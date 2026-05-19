import { describe, it, expect, vi } from 'vitest';
import { generateSessionId, buildSessionEnv, wrapCommand, applyCredentials } from '../credentials-interceptor.js';
import type { CredhelperClient } from '../credhelper-client.js';

describe('generateSessionId', () => {
  it('uses AGENT_ID and WORKFLOW_ID when both are set', () => {
    const id = generateSessionId({ AGENT_ID: 'agent-1', WORKFLOW_ID: 'wf-42' });
    expect(id).toMatch(/^agent-1-wf-42-\d+-[0-9a-f]{4}$/);
  });

  it('falls back to HOSTNAME when AGENT_ID is absent', () => {
    const id = generateSessionId({ HOSTNAME: 'host-7', WORKFLOW_ID: 'wf-1' });
    expect(id).toMatch(/^host-7-wf-1-\d+-[0-9a-f]{4}$/);
  });

  it("falls back to 'unknown' when neither AGENT_ID nor HOSTNAME is set", () => {
    const id = generateSessionId({ WORKFLOW_ID: 'wf-1' });
    expect(id).toMatch(/^unknown-wf-1-\d+-[0-9a-f]{4}$/);
  });

  it("falls back to 'adhoc' when WORKFLOW_ID is absent", () => {
    const id = generateSessionId({ AGENT_ID: 'agent-1' });
    expect(id).toMatch(/^agent-1-adhoc-\d+-[0-9a-f]{4}$/);
  });

  it('produces different IDs on successive calls', () => {
    const env = { AGENT_ID: 'a', WORKFLOW_ID: 'w' };
    const id1 = generateSessionId(env);
    const id2 = generateSessionId(env);
    expect(id1).not.toBe(id2);
  });
});

describe('buildSessionEnv', () => {
  it('returns the four expected env vars with correct paths', () => {
    const sessionDir = '/run/sessions/test-123';
    const result = buildSessionEnv(sessionDir);

    expect(result).toEqual({
      GENERACY_SESSION_DIR: '/run/sessions/test-123',
      GIT_CONFIG_GLOBAL: '/run/sessions/test-123/git/config',
      GOOGLE_APPLICATION_CREDENTIALS: '/run/sessions/test-123/gcp/external-account.json',
      DOCKER_HOST: 'unix:///run/sessions/test-123/docker.sock',
    });
  });
});

describe('wrapCommand', () => {
  it('wraps a command with args in sh -c with positional params', () => {
    const result = wrapCommand('claude', ['--model', 'opus']);

    expect(result).toEqual({
      command: 'sh',
      args: [
        '-c',
        '. "$GENERACY_SESSION_DIR/env" && exec "$@"',
        '_',
        'claude',
        '--model',
        'opus',
      ],
    });
  });

  it('handles empty args', () => {
    const result = wrapCommand('echo', []);

    expect(result).toEqual({
      command: 'sh',
      args: [
        '-c',
        '. "$GENERACY_SESSION_DIR/env" && exec "$@"',
        '_',
        'echo',
      ],
    });
  });
});

describe('applyCredentials', () => {
  function createMockClient(sessionDir: string): CredhelperClient {
    return {
      beginSession: vi.fn<CredhelperClient['beginSession']>().mockResolvedValue({
        sessionDir,
        expiresAt: new Date('2026-04-13T12:00:00Z'),
      }),
      endSession: vi.fn<CredhelperClient['endSession']>().mockResolvedValue(undefined),
    };
  }

  it('returns a wrapped command, merged env, uid/gid, and sessionId', async () => {
    const client = createMockClient('/sess/abc');
    const credentials = { role: 'developer', uid: 1001, gid: 1001 };
    const env = { PATH: '/usr/bin', AGENT_ID: 'a1', WORKFLOW_ID: 'w1' };

    const result = await applyCredentials(client, credentials, 'claude', ['--model', 'opus'], env);

    // Wrapped command
    expect(result.command).toBe('sh');
    expect(result.args[0]).toBe('-c');
    expect(result.args).toContain('claude');
    expect(result.args).toContain('--model');
    expect(result.args).toContain('opus');

    // uid/gid from credentials
    expect(result.uid).toBe(1001);
    expect(result.gid).toBe(1001);

    // sessionId was generated
    expect(result.sessionId).toMatch(/^a1-w1-\d+-[0-9a-f]{4}$/);
  });

  it('merges original env with session env vars', async () => {
    const client = createMockClient('/sess/abc');
    const credentials = { role: 'developer', uid: 1000, gid: 1000 };
    const env = { PATH: '/usr/bin', MY_VAR: 'keep-me' };

    const result = await applyCredentials(client, credentials, 'echo', [], env);

    // Original vars preserved
    expect(result.env.PATH).toBe('/usr/bin');
    expect(result.env.MY_VAR).toBe('keep-me');

    // Session vars added on top
    expect(result.env.GENERACY_SESSION_DIR).toBe('/sess/abc');
    expect(result.env.GIT_CONFIG_GLOBAL).toBe('/sess/abc/git/config');
    expect(result.env.GOOGLE_APPLICATION_CREDENTIALS).toBe('/sess/abc/gcp/external-account.json');
    expect(result.env.DOCKER_HOST).toBe('unix:///sess/abc/docker.sock');
  });

  it('calls beginSession with the correct role and sessionId', async () => {
    const client = createMockClient('/sess/xyz');
    const credentials = { role: 'admin', uid: 0, gid: 0 };
    const env = { AGENT_ID: 'bot', WORKFLOW_ID: 'deploy' };

    const result = await applyCredentials(client, credentials, 'deploy', ['--force'], env);

    expect(client.beginSession).toHaveBeenCalledOnce();
    expect(client.beginSession).toHaveBeenCalledWith('admin', result.sessionId);
  });
});

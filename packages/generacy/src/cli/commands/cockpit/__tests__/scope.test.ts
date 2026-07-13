import { describe, expect, it, vi } from 'vitest';
import { runScope } from '../scope.js';
import { CockpitExit } from '../exit.js';
import type { GhWrapper, Issue, CommandRunner, CommandResult } from '@generacy-ai/cockpit';

const baseLoad = vi.fn(async () => ({
  config: {},
  source: 'defaults' as const,
  warnings: [],
}));

function stubIssue(body: string): Issue {
  return {
    number: 1,
    title: 't',
    state: 'OPEN',
    stateReason: null,
    labels: [],
    url: '',
    body,
    createdAt: '',
  };
}

function stubGh(overrides: Partial<GhWrapper> = {}): GhWrapper {
  return {
    getIssue: vi.fn(async () => stubIssue('')),
    updateIssueBody: vi.fn(async () => {}),
    ...overrides,
  } as unknown as GhWrapper;
}

// A no-op runner. resolveIssueContext only invokes it if input is a bare number
// — our tests use qualified refs, so the runner is never called.
const runner: CommandRunner = async (): Promise<CommandResult> => ({
  stdout: '',
  stderr: '',
  exitCode: 0,
});

describe('cockpit scope', () => {
  it('add: happy path — writes body, prints summary line, exits 0', async () => {
    let currentBody = '';
    const gh = stubGh({
      getIssue: vi.fn(async () => stubIssue(currentBody)) as unknown as GhWrapper['getIssue'],
      updateIssueBody: vi.fn(async (_repo: string, _n: number, body: string) => {
        currentBody = body;
      }) as unknown as GhWrapper['updateIssueBody'],
    });
    const lines: string[] = [];
    await runScope(
      'add',
      'owner/scope#42',
      'owner/target#7',
      { gh, runner, loadConfig: baseLoad, stdout: (l) => lines.push(l) },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('scope add: owner/target#7 → owner/scope#42');
    expect(lines[0]).toContain('shape=');
    expect(lines[0]).toContain('attempts=');
    expect(lines[0]).toContain('alreadyPresent=false');
    expect(currentBody).toContain('- [ ] owner/target#7');
  });

  it('add: already present — prints alreadyPresent=true, no write', async () => {
    const updateSpy = vi.fn(async () => {});
    const gh = stubGh({
      getIssue: vi.fn(async () => stubIssue('- [ ] owner/target#7\n')) as unknown as GhWrapper['getIssue'],
      updateIssueBody: updateSpy as unknown as GhWrapper['updateIssueBody'],
    });
    const lines: string[] = [];
    await runScope(
      'add',
      'owner/scope#42',
      'owner/target#7',
      { gh, runner, loadConfig: baseLoad, stdout: (l) => lines.push(l) },
    );
    expect(lines[0]).toContain('alreadyPresent=true');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('remove: happy path — writes body, prints summary line, exits 0', async () => {
    let currentBody = '- [ ] owner/target#7\n';
    const gh = stubGh({
      getIssue: vi.fn(async () => stubIssue(currentBody)) as unknown as GhWrapper['getIssue'],
      updateIssueBody: vi.fn(async (_r: string, _n: number, body: string) => {
        currentBody = body;
      }) as unknown as GhWrapper['updateIssueBody'],
    });
    const lines: string[] = [];
    await runScope(
      'remove',
      'owner/scope#42',
      'owner/target#7',
      { gh, runner, loadConfig: baseLoad, stdout: (l) => lines.push(l) },
    );
    expect(lines[0]).toContain('scope remove: owner/target#7 ✕ owner/scope#42');
    expect(lines[0]).toContain('alreadyAbsent=false');
    expect(currentBody).not.toContain('- [ ] owner/target#7');
  });

  it('remove: already absent — noop, alreadyAbsent=true', async () => {
    const gh = stubGh({
      getIssue: vi.fn(async () => stubIssue('- [ ] someone/else#1\n')) as unknown as GhWrapper['getIssue'],
    });
    const lines: string[] = [];
    await runScope(
      'remove',
      'owner/scope#42',
      'owner/target#7',
      { gh, runner, loadConfig: baseLoad, stdout: (l) => lines.push(l) },
    );
    expect(lines[0]).toContain('alreadyAbsent=true');
  });

  it('contended path — throws CockpitExit(1) with SCOPE_ADD_CONTENDED', async () => {
    // Every readback returns different content from what we wrote.
    const bodies = [
      '', 'other#1\n', '', 'other#2\n', '', 'other#3\n', '', 'other#4\n', '', 'other#5\n',
    ];
    let idx = 0;
    const gh = stubGh({
      getIssue: vi.fn(async () => stubIssue(bodies[Math.min(idx++, bodies.length - 1)]!)) as unknown as GhWrapper['getIssue'],
      updateIssueBody: vi.fn(async () => {}) as unknown as GhWrapper['updateIssueBody'],
    });
    let thrown: unknown = null;
    try {
      await runScope(
        'add',
        'owner/scope#42',
        'owner/target#7',
        { gh, runner, loadConfig: baseLoad, stdout: () => {} },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CockpitExit);
    expect((thrown as CockpitExit).code).toBe(1);
    expect((thrown as CockpitExit).message).toContain('SCOPE_ADD_CONTENDED');
  });

  it('ref-parse failure — exits 2', async () => {
    let thrown: unknown = null;
    try {
      await runScope(
        'add',
        'garbage-ref',
        'owner/target#7',
        { gh: stubGh(), runner, loadConfig: baseLoad, stdout: () => {} },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CockpitExit);
    expect((thrown as CockpitExit).code).toBe(2);
    expect((thrown as CockpitExit).message).toContain('parse issue');
  });
});

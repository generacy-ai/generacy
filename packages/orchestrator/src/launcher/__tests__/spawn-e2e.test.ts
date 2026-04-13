import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  cpSync,
  chmodSync,
  rmSync,
  unlinkSync,
  existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AgentLauncher } from '../agent-launcher.js';
import { GenericSubprocessPlugin } from '../generic-subprocess-plugin.js';
import { ClaudeCodeLaunchPlugin } from '@generacy-ai/generacy-plugin-claude-code';
import { defaultProcessFactory } from '../../worker/claude-cli-worker.js';
import { conversationProcessFactory } from '../../conversation/process-factory.js';
import type { LaunchRequest } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- T002: Capture file parser ---

interface CaptureFile {
  argv: string[];
  env: Record<string, string>;
}

function parseCaptureFile(filePath: string): CaptureFile {
  const content = readFileSync(filePath, 'utf-8');
  const argvStart = content.indexOf('=== ARGV ===');
  const envStart = content.indexOf('=== ENV ===');

  if (argvStart === -1 || envStart === -1) {
    throw new Error('Invalid capture file format: missing section markers');
  }

  const argvSection = content
    .slice(argvStart + '=== ARGV ==='.length, envStart)
    .trim();
  const envSection = content.slice(envStart + '=== ENV ==='.length).trim();

  const argv = argvSection ? argvSection.split('\n') : [];
  const env: Record<string, string> = {};
  for (const line of envSection.split('\n')) {
    if (!line) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex > 0) {
      env[line.slice(0, eqIndex)] = line.slice(eqIndex + 1);
    }
  }

  return { argv, env };
}

// --- Helpers ---

function collectStdout(handle: {
  process: {
    stdout: NodeJS.ReadableStream | null;
    exitPromise: Promise<number | null>;
  };
}): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    if (handle.process.stdout) {
      handle.process.stdout.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      handle.process.stdout.on('end', () => resolve(data));
    } else {
      resolve('');
    }
  });
}

// T030: python3 availability guard (evaluated once at module load)
let hasPython3 = false;
try {
  execSync('python3 --version', { stdio: 'pipe' });
  hasPython3 = true;
} catch {
  // python3 not available — conversation-turn tests will be skipped
}

// --- T003: Test scaffolding ---

describe('spawn-e2e', () => {
  let tmpDir: string;
  let captureFile: string;
  let responseFile: string;
  let modifiedPath: string;
  let launcher: AgentLauncher;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'spawn-e2e-'));
    captureFile = join(tmpDir, 'capture.txt');
    responseFile = join(tmpDir, 'response.txt');

    // Copy mock-claude.sh → <tmpdir>/claude, chmod +x
    const mockSrc = join(__dirname, 'fixtures', 'mock-claude.sh');
    const mockDst = join(tmpDir, 'claude');
    cpSync(mockSrc, mockDst);
    chmodSync(mockDst, 0o755);

    // PATH with tmpdir prepended so `claude` resolves to our mock
    modifiedPath = `${tmpDir}:${process.env.PATH}`;

    // Real factories, real plugins — only the binary is mocked
    launcher = new AgentLauncher(
      new Map([
        ['default', defaultProcessFactory],
        ['interactive', conversationProcessFactory],
      ]),
    );
    launcher.registerPlugin(new GenericSubprocessPlugin());
    launcher.registerPlugin(new ClaudeCodeLaunchPlugin());
  });

  beforeEach(() => {
    if (existsSync(captureFile)) unlinkSync(captureFile);
    if (existsSync(responseFile)) unlinkSync(responseFile);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Build env with PATH override and capture file path */
  function buildEnv(extra?: Record<string, string>): Record<string, string> {
    return {
      PATH: modifiedPath,
      MOCK_CLAUDE_CAPTURE_FILE: captureFile,
      ...extra,
    };
  }

  // ─── Phase 2: Core Test Cases ───────────────────────────────────

  // T010: phase intent
  it('phase intent: argv contains expected flags and session resume', async () => {
    const request: LaunchRequest = {
      intent: {
        kind: 'phase',
        phase: 'plan',
        prompt: 'https://github.com/org/repo/issues/1',
        sessionId: 'sess-123',
      } as any,
      cwd: tmpDir,
      env: buildEnv(),
    };

    const handle = launcher.launch(request);
    // defaultProcessFactory → stdin is null
    expect(handle.process.stdin).toBeNull();

    const [, exitCode] = await Promise.all([
      collectStdout(handle),
      handle.process.exitPromise,
    ]);
    expect(exitCode).toBe(0);

    const capture = parseCaptureFile(captureFile);
    expect(capture.argv).toContain('-p');
    expect(capture.argv).toContain('--output-format');
    expect(capture.argv).toContain('stream-json');
    expect(capture.argv).toContain('--dangerously-skip-permissions');
    expect(capture.argv).toContain('--verbose');
    expect(capture.argv).toContain('--resume');
    expect(capture.argv).toContain('sess-123');
    expect(capture.argv.some((a) => a.includes('/plan'))).toBe(true);
    expect(
      capture.argv.some((a) =>
        a.includes('https://github.com/org/repo/issues/1'),
      ),
    ).toBe(true);
  });

  // T011: pr-feedback intent
  it('pr-feedback intent: argv contains prompt text', async () => {
    const request: LaunchRequest = {
      intent: {
        kind: 'pr-feedback',
        prNumber: 42,
        prompt: 'Fix the bug in auth.ts',
      } as any,
      cwd: tmpDir,
      env: buildEnv(),
    };

    const handle = launcher.launch(request);
    await handle.process.exitPromise;

    const capture = parseCaptureFile(captureFile);
    expect(capture.argv).toContain('-p');
    expect(capture.argv).toContain('--output-format');
    expect(capture.argv).toContain('stream-json');
    expect(capture.argv).toContain('--dangerously-skip-permissions');
    expect(capture.argv).toContain('--verbose');
    expect(capture.argv).toContain('Fix the bug in auth.ts');
  });

  // T012: invoke intent
  it('invoke intent: argv contains --print and command string', async () => {
    const request: LaunchRequest = {
      intent: {
        kind: 'invoke',
        command: '/speckit:specify https://github.com/org/repo/issues/5',
      } as any,
      cwd: tmpDir,
      env: buildEnv(),
    };

    const handle = launcher.launch(request);
    await handle.process.exitPromise;

    const capture = parseCaptureFile(captureFile);
    expect(capture.argv).toContain('--print');
    expect(capture.argv).toContain('--dangerously-skip-permissions');
    expect(capture.argv).toContain(
      '/speckit:specify https://github.com/org/repo/issues/5',
    );
  });

  // T013: conversation-turn intent (requires python3 for PTY wrapper)
  it.skipIf(!hasPython3)(
    'conversation-turn intent: PTY wrapper invocation with correct argv',
    async () => {
      const request: LaunchRequest = {
        intent: {
          kind: 'conversation-turn',
          message: 'Hello',
          skipPermissions: true,
          model: 'claude-opus-4-6',
        } as any,
        cwd: tmpDir,
        env: buildEnv(),
      };

      const handle = launcher.launch(request);
      // conversationProcessFactory → stdin is piped (not null)
      expect(handle.process.stdin).not.toBeNull();

      // Close stdin so PTY wrapper doesn't hang after child exits
      handle.process.stdin!.end();

      const [, exitCode] = await Promise.all([
        collectStdout(handle),
        handle.process.exitPromise,
      ]);
      expect(exitCode).toBe(0);

      const capture = parseCaptureFile(captureFile);
      expect(capture.argv).toContain('-p');
      expect(capture.argv).toContain('Hello');
      expect(capture.argv).toContain('--output-format');
      expect(capture.argv).toContain('stream-json');
      expect(capture.argv).toContain('--verbose');
      expect(capture.argv).toContain('--dangerously-skip-permissions');
      expect(capture.argv).toContain('--model');
      expect(capture.argv).toContain('claude-opus-4-6');
    },
  );

  // T014: generic-subprocess intent
  it('generic-subprocess intent: exits cleanly with correct stdout', async () => {
    const request: LaunchRequest = {
      intent: {
        kind: 'generic-subprocess',
        command: 'echo',
        args: ['hello', 'world'],
      },
      cwd: tmpDir,
    };

    const handle = launcher.launch(request);
    const [stdout, exitCode] = await Promise.all([
      collectStdout(handle),
      handle.process.exitPromise,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('hello world');
  });

  // T015: shell intent
  it('shell intent: wrapped in sh -c with correct stdout', async () => {
    const request: LaunchRequest = {
      intent: {
        kind: 'shell',
        command: 'echo integration-test-marker',
      },
      cwd: tmpDir,
    };

    const handle = launcher.launch(request);
    const [stdout, exitCode] = await Promise.all([
      collectStdout(handle),
      handle.process.exitPromise,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toContain('integration-test-marker');
  });

  // ─── Phase 3: Advanced Assertions ──────────────────────────────

  // T020: Env inheritance 3-layer merge
  it('env: request env overrides process.env in 3-layer merge', async () => {
    const request: LaunchRequest = {
      intent: {
        kind: 'phase',
        phase: 'plan',
        prompt: 'https://github.com/org/repo/issues/1',
      } as any,
      cwd: tmpDir,
      env: buildEnv({ TEST_CUSTOM_KEY: 'test-value' }),
    };

    const handle = launcher.launch(request);
    await handle.process.exitPromise;

    const capture = parseCaptureFile(captureFile);
    // Request env key is present
    expect(capture.env['TEST_CUSTOM_KEY']).toBe('test-value');
    // PATH is our modified PATH (request env wins over process.env)
    expect(capture.env['PATH']).toContain(tmpDir);
    // Capture file path is passed through
    expect(capture.env['MOCK_CLAUDE_CAPTURE_FILE']).toBe(captureFile);
  });

  // T021: Response file configurable stdout
  it('response file: mock emits configured response to stdout', async () => {
    const fixtureContent =
      '{"type":"init","sessionId":"test-session"}\n{"type":"result","subtype":"success"}';
    writeFileSync(responseFile, fixtureContent, 'utf-8');

    const request: LaunchRequest = {
      intent: {
        kind: 'phase',
        phase: 'plan',
        prompt: 'https://github.com/org/repo/issues/1',
      } as any,
      cwd: tmpDir,
      env: buildEnv({ MOCK_CLAUDE_RESPONSE_FILE: responseFile }),
    };

    const handle = launcher.launch(request);
    const [stdout, exitCode] = await Promise.all([
      collectStdout(handle),
      handle.process.exitPromise,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(fixtureContent);
  });
});

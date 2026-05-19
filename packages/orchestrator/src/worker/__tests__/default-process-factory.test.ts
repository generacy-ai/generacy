import { EventEmitter } from 'node:events';
import { vi, describe, it, expect, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mock for node:child_process
// vi.hoisted ensures the variable is available when vi.mock factories run
// (vi.mock calls are hoisted above imports by vitest's transform)
// ---------------------------------------------------------------------------
const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

// ---------------------------------------------------------------------------
// Mock all transitive dependencies of claude-cli-worker.ts so that importing
// it does not trigger real module resolution for heavy packages.
// ---------------------------------------------------------------------------
vi.mock('@generacy-ai/workflow-engine', () => ({
  createGitHubClient: vi.fn(),
  createFeature: vi.fn(),
}));

vi.mock('../repo-checkout.js', () => ({
  RepoCheckout: vi.fn(),
}));

vi.mock('../phase-resolver.js', () => ({
  PhaseResolver: vi.fn(),
}));

vi.mock('../label-manager.js', () => ({
  LabelManager: vi.fn(),
}));

vi.mock('../stage-comment-manager.js', () => ({
  StageCommentManager: vi.fn(),
}));

vi.mock('../gate-checker.js', () => ({
  GateChecker: vi.fn(),
}));

vi.mock('../cli-spawner.js', () => ({
  CliSpawner: vi.fn(),
}));

vi.mock('../output-capture.js', () => ({
  OutputCapture: vi.fn(),
}));

vi.mock('../phase-loop.js', () => ({
  PhaseLoop: vi.fn(),
}));

vi.mock('../pr-manager.js', () => ({
  PrManager: vi.fn(),
}));

vi.mock('../pr-feedback-handler.js', () => ({
  PrFeedbackHandler: vi.fn(),
}));

vi.mock('../epic-post-tasks.js', () => ({
  EpicPostTasks: vi.fn(),
}));

vi.mock('../conversation-logger.js', () => ({
  ConversationLogger: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import the unit under test AFTER all vi.mock calls
// ---------------------------------------------------------------------------
import { defaultProcessFactory } from '../claude-cli-worker.js';

// ---------------------------------------------------------------------------
// Helper: create a mock ChildProcess returned by spawn
// ---------------------------------------------------------------------------
function createMockChildProcess() {
  const child = new EventEmitter();
  (child as any).stdout = new EventEmitter();
  (child as any).stderr = new EventEmitter();
  (child as any).pid = 12345;
  (child as any).stdin = null;
  (child as any).kill = vi.fn(() => true);
  return child;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('defaultProcessFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn.mockReturnValue(createMockChildProcess());
  });

  it('forwards uid and gid to child_process.spawn when provided', () => {
    defaultProcessFactory.spawn('claude', ['--help'], {
      cwd: '/tmp/work',
      env: { FOO: 'bar' },
      uid: 1000,
      gid: 1001,
    });

    expect(mockSpawn).toHaveBeenCalledTimes(1);

    const spawnOptions = mockSpawn.mock.calls[0][2];
    expect(spawnOptions.uid).toBe(1000);
    expect(spawnOptions.gid).toBe(1001);
  });

  it('does not include uid or gid keys when they are omitted', () => {
    defaultProcessFactory.spawn('claude', ['--help'], {
      cwd: '/tmp/work',
      env: { FOO: 'bar' },
    });

    expect(mockSpawn).toHaveBeenCalledTimes(1);

    const spawnOptions = mockSpawn.mock.calls[0][2];
    expect(spawnOptions).not.toHaveProperty('uid');
    expect(spawnOptions).not.toHaveProperty('gid');
  });

  it('forwards only uid when gid is omitted', () => {
    defaultProcessFactory.spawn('claude', ['--help'], {
      cwd: '/tmp/work',
      env: {},
      uid: 500,
    });

    expect(mockSpawn).toHaveBeenCalledTimes(1);

    const spawnOptions = mockSpawn.mock.calls[0][2];
    expect(spawnOptions.uid).toBe(500);
    expect(spawnOptions).not.toHaveProperty('gid');
  });

  it('forwards only gid when uid is omitted', () => {
    defaultProcessFactory.spawn('claude', ['--help'], {
      cwd: '/tmp/work',
      env: {},
      gid: 600,
    });

    expect(mockSpawn).toHaveBeenCalledTimes(1);

    const spawnOptions = mockSpawn.mock.calls[0][2];
    expect(spawnOptions).not.toHaveProperty('uid');
    expect(spawnOptions.gid).toBe(600);
  });

  it('passes cwd, env (merged with process.env), and stdio to spawn', () => {
    defaultProcessFactory.spawn('claude', ['-p', 'hello'], {
      cwd: '/my/project',
      env: { CUSTOM_VAR: 'value' },
    });

    expect(mockSpawn).toHaveBeenCalledTimes(1);

    const [command, args, spawnOptions] = mockSpawn.mock.calls[0];
    expect(command).toBe('claude');
    expect(args).toEqual(['-p', 'hello']);
    expect(spawnOptions.cwd).toBe('/my/project');
    expect(spawnOptions.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    // env should include process.env merged with the provided env
    expect(spawnOptions.env).toMatchObject({ CUSTOM_VAR: 'value' });
  });

  it('returns a ChildProcessHandle with expected properties', () => {
    const handle = defaultProcessFactory.spawn('claude', [], {
      cwd: '/tmp',
      env: {},
    });

    expect(handle.pid).toBe(12345);
    expect(handle.stdin).toBeNull();
    expect(handle.stdout).toBeDefined();
    expect(handle.stderr).toBeDefined();
    expect(typeof handle.kill).toBe('function');
    expect(handle.exitPromise).toBeInstanceOf(Promise);
  });
});

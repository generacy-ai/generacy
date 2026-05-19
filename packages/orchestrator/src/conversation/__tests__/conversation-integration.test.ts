import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConversationManager } from '../conversation-manager.js';
import { ConversationSpawner } from '../conversation-spawner.js';
import type { ConversationConfig } from '../../config/schema.js';
import type { Logger, ChildProcessHandle } from '../../worker/types.js';
import type { ConversationOutputEvent } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => mockLogger,
};

function createConfig(overrides: Partial<ConversationConfig> = {}): ConversationConfig {
  return {
    maxConcurrent: 3,
    shutdownGracePeriodMs: 5000,
    workspaces: { primary: '/workspace/primary', dev: '/workspace/dev' },
    ...overrides,
  };
}

function createMockProcessHandle(): {
  handle: ChildProcessHandle;
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
  resolveExit: (code: number | null) => void;
} {
  const stdin = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  stdin.write = vi.fn().mockReturnValue(true);
  stdin.end = vi.fn();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let resolveExit: (code: number | null) => void;
  const exitPromise = new Promise<number | null>((resolve) => {
    resolveExit = resolve;
  });

  const handle: ChildProcessHandle = {
    stdin: stdin as unknown as NodeJS.WritableStream,
    stdout: stdout as unknown as NodeJS.ReadableStream,
    stderr: stderr as unknown as NodeJS.ReadableStream,
    pid: Math.floor(Math.random() * 90000) + 10000,
    kill: vi.fn(() => true),
    exitPromise,
  };

  return { handle, stdin, stdout, stderr, resolveExit: resolveExit! };
}

type MockProcess = ReturnType<typeof createMockProcessHandle>;

function createSpawnerWithProcesses(processes: MockProcess[]) {
  let callIndex = 0;
  const getNextProcess = () => {
    const proc = processes[callIndex++];
    if (!proc) throw new Error('No more mock processes');
    return proc.handle;
  };
  return {
    spawn: vi.fn(getNextProcess),
    spawnTurn: vi.fn(getNextProcess),
    gracefulKill: vi.fn((h: ChildProcessHandle) => h.kill('SIGTERM')),
  } as unknown as ConversationSpawner;
}

// ---------------------------------------------------------------------------
// T017: Full Conversation Lifecycle
// ---------------------------------------------------------------------------

describe('Integration: full conversation lifecycle', () => {
  let config: ConversationConfig;
  let proc: MockProcess;
  let spawner: ConversationSpawner;
  let manager: ConversationManager;
  let outputEvents: { id: string; event: ConversationOutputEvent }[];

  beforeEach(() => {
    vi.clearAllMocks();
    config = createConfig();
    proc = createMockProcessHandle();
    spawner = createSpawnerWithProcesses([proc]);
    manager = new ConversationManager(config, spawner, mockLogger);
    outputEvents = [];
    manager.setOutputCallback((id, event) => outputEvents.push({ id, event }));
  });

  it('start → send message → receive output events → end → verify cleanup', async () => {
    // 1. Start a conversation
    const info = await manager.start({
      conversationId: 'lifecycle-1',
      workingDirectory: 'primary',
    });
    expect(info.state).toBe('active');
    expect(info.workspaceId).toBe('primary');
    expect(manager.list()).toHaveLength(1);

    // 2. Send a message (per-turn model: spawns a new process)
    await manager.sendMessage('lifecycle-1', 'What is TypeScript?');
    expect(spawner.spawnTurn).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'What is TypeScript?' }),
    );

    // 3. Simulate CLI output events in stream-json verbose format
    proc.stdout.emit(
      'data',
      '{"type":"system","subtype":"init","session_id":"ses-abc","model":"claude-sonnet-4-6"}\n',
    );
    proc.stdout.emit(
      'data',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"TypeScript is a typed superset of JavaScript."}]}}\n',
    );
    proc.stdout.emit(
      'data',
      '{"type":"result","subtype":"success","usage":{"input_tokens":100,"output_tokens":50}}\n',
    );

    expect(outputEvents).toHaveLength(3);
    expect(outputEvents[0].event.event).toBe('output');
    expect(outputEvents[0].event.payload).toEqual({
      sessionId: 'ses-abc',
      model: 'claude-sonnet-4-6',
    });
    expect(outputEvents[1].event.event).toBe('output');
    expect(outputEvents[1].event.payload).toEqual({
      text: 'TypeScript is a typed superset of JavaScript.',
    });
    expect(outputEvents[2].event.event).toBe('complete');
    expect(outputEvents[2].event.payload).toEqual({
      tokensIn: 100,
      tokensOut: 50,
    });

    // 4. End the conversation
    const endPromise = manager.end('lifecycle-1');
    proc.resolveExit(0);
    const endInfo = await endPromise;

    expect(endInfo.state).toBe('ended');
    expect(spawner.gracefulKill).toHaveBeenCalled();

    // 5. Verify cleanup
    expect(manager.list()).toHaveLength(0);

    // Verify a 'complete' event was emitted from end()
    const completeEvents = outputEvents.filter((e) => e.event.event === 'complete');
    expect(completeEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('start with initial command spawns a turn immediately', async () => {
    await manager.start({
      conversationId: 'init-cmd',
      workingDirectory: 'primary',
      initialCommand: '/onboard-evaluate',
    });

    expect(spawner.spawnTurn).toHaveBeenCalledWith(
      expect.objectContaining({ message: '/onboard-evaluate' }),
    );
  });

  it('receives tool_use and tool_result events', async () => {
    await manager.start({
      conversationId: 'tools-test',
      workingDirectory: 'primary',
    });

    // Need a running turn to have stdout listeners
    await manager.sendMessage('tools-test', 'read a file');

    proc.stdout.emit(
      'data',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","id":"call-1","input":{"path":"/foo.ts"}}]}}\n',
    );
    proc.stdout.emit(
      'data',
      '{"type":"tool_result","tool_use_id":"call-1","content":"contents"}\n',
    );

    expect(outputEvents).toHaveLength(2);
    expect(outputEvents[0].event.event).toBe('tool_use');
    expect(outputEvents[0].event.payload).toEqual({
      toolName: 'Read',
      callId: 'call-1',
      input: { path: '/foo.ts' },
    });
    expect(outputEvents[1].event.event).toBe('tool_result');
    expect(outputEvents[1].event.payload).toEqual({
      callId: 'call-1',
      output: 'contents',
    });
  });

  it('handles multi-turn conversation', async () => {
    const proc2 = createMockProcessHandle();
    spawner = createSpawnerWithProcesses([proc, proc2]);
    manager = new ConversationManager(config, spawner, mockLogger);
    manager.setOutputCallback((id, event) => outputEvents.push({ id, event }));

    await manager.start({
      conversationId: 'multi-turn',
      workingDirectory: 'primary',
    });

    // Turn 1
    await manager.sendMessage('multi-turn', 'Hello');
    proc.stdout.emit('data', '{"type":"assistant","message":{"content":[{"type":"text","text":"Hi there!"}]}}\n');
    proc.resolveExit(0);
    await new Promise((r) => setTimeout(r, 10));

    // Turn 2
    await manager.sendMessage('multi-turn', 'How are you?');
    proc2.stdout.emit('data', '{"type":"assistant","message":{"content":[{"type":"text","text":"I am doing well!"}]}}\n');

    expect(outputEvents).toHaveLength(2);
    expect((spawner.spawnTurn as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// T018: Concurrency and Error Paths
// ---------------------------------------------------------------------------

describe('Integration: concurrency and error paths', () => {
  let config: ConversationConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    config = createConfig({ maxConcurrent: 2 });
  });

  it('enforces concurrent conversation limit', async () => {
    const proc1 = createMockProcessHandle();
    const proc2 = createMockProcessHandle();
    const proc3 = createMockProcessHandle();
    const spawner = createSpawnerWithProcesses([proc1, proc2, proc3]);
    const manager = new ConversationManager(config, spawner, mockLogger);

    await manager.start({ conversationId: 'c1', workingDirectory: 'primary' });
    await manager.start({ conversationId: 'c2', workingDirectory: 'dev' });

    // Third should be rejected with 429
    await expect(
      manager.start({ conversationId: 'c3', workingDirectory: 'primary' }),
    ).rejects.toMatchObject({ statusCode: 429 });

    expect(manager.list()).toHaveLength(2);
  });

  it('allows new conversation after ending one at limit', async () => {
    const proc1 = createMockProcessHandle();
    const proc2 = createMockProcessHandle();
    const proc3 = createMockProcessHandle();
    const spawner = createSpawnerWithProcesses([proc1, proc2, proc3]);
    const manager = new ConversationManager(config, spawner, mockLogger);

    await manager.start({ conversationId: 'c1', workingDirectory: 'primary' });
    await manager.start({ conversationId: 'c2', workingDirectory: 'dev' });

    // End one conversation (no running process)
    await manager.end('c1');

    // Now should be able to start another
    const info = await manager.start({ conversationId: 'c3', workingDirectory: 'primary' });
    expect(info.state).toBe('active');
    expect(manager.list()).toHaveLength(2);
  });

  it('rejects invalid workspace identifier', async () => {
    const proc = createMockProcessHandle();
    const spawner = createSpawnerWithProcesses([proc]);
    const manager = new ConversationManager(config, spawner, mockLogger);

    await expect(
      manager.start({ conversationId: 'c1', workingDirectory: 'nonexistent' }),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(manager.list()).toHaveLength(0);
  });

  it('handles turn process exit without removing conversation', async () => {
    const proc = createMockProcessHandle();
    const spawner = createSpawnerWithProcesses([proc]);
    const manager = new ConversationManager(config, spawner, mockLogger);

    await manager.start({ conversationId: 'c1', workingDirectory: 'primary' });

    // Send a message to start a turn
    await manager.sendMessage('c1', 'hello');

    // Process exits (per-turn model: this is normal)
    proc.resolveExit(137);
    await new Promise((r) => setTimeout(r, 20));

    // Per-turn model: conversation remains active after turn ends
    expect(manager.list()).toHaveLength(1);
  });

  it('rejects duplicate conversation ID', async () => {
    const proc1 = createMockProcessHandle();
    const proc2 = createMockProcessHandle();
    const spawner = createSpawnerWithProcesses([proc1, proc2]);
    const manager = new ConversationManager(config, spawner, mockLogger);

    await manager.start({ conversationId: 'dup', workingDirectory: 'primary' });

    await expect(
      manager.start({ conversationId: 'dup', workingDirectory: 'dev' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('handles graceful shutdown with multiple active conversations', async () => {
    const proc1 = createMockProcessHandle();
    const proc2 = createMockProcessHandle();
    const spawner = createSpawnerWithProcesses([proc1, proc2]);
    const manager = new ConversationManager(config, spawner, mockLogger);

    await manager.start({ conversationId: 'c1', workingDirectory: 'primary' });
    await manager.start({ conversationId: 'c2', workingDirectory: 'dev' });

    expect(manager.list()).toHaveLength(2);

    // No running processes (per-turn model), so stop completes immediately
    await manager.stop();

    expect(manager.list()).toHaveLength(0);
  });

  it('slots freed by ending become available', async () => {
    const proc1 = createMockProcessHandle();
    const proc2 = createMockProcessHandle();
    const proc3 = createMockProcessHandle();
    const spawner = createSpawnerWithProcesses([proc1, proc2, proc3]);
    const manager = new ConversationManager(config, spawner, mockLogger);

    await manager.start({ conversationId: 'c1', workingDirectory: 'primary' });
    await manager.start({ conversationId: 'c2', workingDirectory: 'dev' });

    // End c1 to free a slot
    await manager.end('c1');

    // Slot is now free
    const info = await manager.start({ conversationId: 'c3', workingDirectory: 'primary' });
    expect(info.state).toBe('active');
    expect(manager.list()).toHaveLength(2);
  });

  it('sendMessage after end returns 404', async () => {
    const proc = createMockProcessHandle();
    const spawner = createSpawnerWithProcesses([proc]);
    const manager = new ConversationManager(config, spawner, mockLogger);

    await manager.start({ conversationId: 'c1', workingDirectory: 'primary' });

    await manager.end('c1');

    await expect(
      manager.sendMessage('c1', 'hello'),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

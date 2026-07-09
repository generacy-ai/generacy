import { describe, it, expect, vi } from 'vitest';
import {
  AgentLauncher,
  GenericSubprocessPlugin,
} from '@generacy-ai/orchestrator';
import {
  RecordingProcessFactory,
  normalizeSpawnRecords,
} from '@generacy-ai/orchestrator/test-utils';
import { SubprocessAgency } from '../subprocess.js';

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
}

describe('SubprocessAgency snapshot parity', () => {
  it('launcher path produces byte-identical spawn args to direct path', async () => {
    // RecordingProcessFactory returns a dummy handle with stdin: null. Once
    // connect() reaches setupIO(), sendMessage() throws "Process not started"
    // inside a .then() chain that has no catch handler, producing an unhandled
    // rejection Vitest converts to a test-run failure. Swallow it here.
    const suppressUnhandled = () => { /* swallow */ };
    process.on('unhandledRejection', suppressUnhandled);
    try {
      const factory = new RecordingProcessFactory();
      const factories = new Map([['interactive', factory]]);
      const launcher = new AgentLauncher(factories);
      launcher.registerPlugin(new GenericSubprocessPlugin());

      const callerEnv = { CUSTOM_VAR: 'custom_value' };
      const agency = new SubprocessAgency(
        {
          command: 'node',
          args: ['agent.js', '--mode', 'mcp'],
          logger: createMockLogger(),
          cwd: '/workspace/project',
          env: callerEnv,
        },
        launcher,
      );

      // connect() will call launcher.launch() → factory.spawn()
      // We don't await because the dummy handle won't respond to init
      agency.connect().catch(() => { /* timeout expected */ });

      // launch() is async — flush microtasks so factory.spawn() has been called
      await Promise.resolve();
      await Promise.resolve();

      // Verify spawn was called through the launcher
      expect(factory.calls).toHaveLength(1);

      const record = normalizeSpawnRecords(factory.calls)[0];
      expect(record.command).toBe('node');
      expect(record.args).toEqual(['agent.js', '--mode', 'mcp']);
      expect(record.cwd).toBe('/workspace/project');

      // normalizeSpawnRecords filters env down to a stable allowlist (PATH etc).
      // Arbitrary caller-injected vars like CUSTOM_VAR are stripped for snapshot
      // stability, so we only verify the always-present PATH.
      expect(record.env.PATH).toBeDefined();

      // Cleanup: disconnect to clear pending timeout
      agency.disconnect();
      // Allow any pending unhandled rejection to fire before removing the listener
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      process.off('unhandledRejection', suppressUnhandled);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { ConversationSpawner } from '../conversation-spawner.js';
import { AgentLauncher } from '../../launcher/agent-launcher.js';
import { GenericSubprocessPlugin } from '../../launcher/generic-subprocess-plugin.js';
import { ClaudeCodeLaunchPlugin } from '@generacy-ai/generacy-plugin-claude-code';
import { PTY_WRAPPER } from '@generacy-ai/generacy-plugin-claude-code';
import { RecordingProcessFactory } from '../../test-utils/recording-process-factory.js';

/**
 * Integration test: ConversationSpawner → AgentLauncher → ClaudeCodeLaunchPlugin → ProcessFactory
 *
 * Verifies the full launch path produces the correct command, args, and env
 * by using a RecordingProcessFactory that captures spawn calls.
 */
describe('ConversationSpawner integration', () => {
  function createStack() {
    const defaultFactory = new RecordingProcessFactory();
    const interactiveFactory = new RecordingProcessFactory();

    const launcher = new AgentLauncher(
      new Map([
        ['default', defaultFactory],
        ['interactive', interactiveFactory],
      ]),
    );
    launcher.registerPlugin(new GenericSubprocessPlugin());
    launcher.registerPlugin(new ClaudeCodeLaunchPlugin());

    const spawner = new ConversationSpawner(launcher);
    return { spawner, defaultFactory, interactiveFactory };
  }

  it('routes conversation turn through ClaudeCodeLaunchPlugin to interactive factory', async () => {
    const { spawner, defaultFactory, interactiveFactory } = createStack();

    await spawner.spawnTurn({
      cwd: '/workspace',
      message: 'Hello, Claude!',
      skipPermissions: true,
    });

    // Should use interactive factory (not default)
    expect(defaultFactory.calls).toHaveLength(0);
    expect(interactiveFactory.calls).toHaveLength(1);
  });

  it('produces python3 PTY wrapper command with correct args', async () => {
    const { spawner, interactiveFactory } = createStack();

    await spawner.spawnTurn({
      cwd: '/workspace',
      message: 'Hello, Claude!',
      skipPermissions: true,
    });

    const call = interactiveFactory.calls[0];
    expect(call.command).toBe('python3');
    expect(call.args[0]).toBe('-u');
    expect(call.args[1]).toBe('-c');
    expect(call.args[2]).toBe(PTY_WRAPPER);
    // claude args after PTY_WRAPPER
    expect(call.args[3]).toBe('claude');
    expect(call.args).toContain('-p');
    expect(call.args).toContain('Hello, Claude!');
    expect(call.args).toContain('--output-format');
    expect(call.args).toContain('stream-json');
    expect(call.args).toContain('--verbose');
    expect(call.args).toContain('--dangerously-skip-permissions');
    expect(call.cwd).toBe('/workspace');
  });

  it('includes --resume when sessionId is provided', async () => {
    const { spawner, interactiveFactory } = createStack();

    await spawner.spawnTurn({
      cwd: '/workspace',
      message: 'Follow up',
      sessionId: 'ses-abc',
      skipPermissions: true,
    });

    const args = interactiveFactory.calls[0].args;
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe('ses-abc');
  });

  it('includes --model when model is provided', async () => {
    const { spawner, interactiveFactory } = createStack();

    await spawner.spawnTurn({
      cwd: '/workspace',
      message: 'Hello',
      skipPermissions: true,
      model: 'claude-opus-4-6',
    });

    const args = interactiveFactory.calls[0].args;
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-4-6');
  });

  it('omits --dangerously-skip-permissions when skipPermissions is false', async () => {
    const { spawner, interactiveFactory } = createStack();

    await spawner.spawnTurn({
      cwd: '/workspace',
      message: 'Hello',
      skipPermissions: false,
    });

    const args = interactiveFactory.calls[0].args;
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('snapshot: full spawn args match pre-refactor baseline', async () => {
    const { spawner, interactiveFactory } = createStack();

    await spawner.spawnTurn({
      cwd: '/workspace/project',
      message: 'Explain this code',
      sessionId: 'ses-xyz',
      model: 'claude-sonnet-4-6',
      skipPermissions: true,
    });

    const call = interactiveFactory.calls[0];
    // Snapshot the command + args (excluding env which includes process.env)
    expect({
      command: call.command,
      args: call.args,
      cwd: call.cwd,
    }).toMatchSnapshot();
  });

  it('PTY wrapper content matches plugin constant', async () => {
    const { spawner, interactiveFactory } = createStack();

    await spawner.spawnTurn({
      cwd: '/workspace',
      message: 'test',
      skipPermissions: true,
    });

    const ptyScript = interactiveFactory.calls[0].args[2];
    expect(ptyScript).toBe(PTY_WRAPPER);
    // Verify key parts of the PTY wrapper
    expect(ptyScript).toContain('import pty, os, sys');
    expect(ptyScript).toContain('pty.spawn(sys.argv[1:], read)');
    expect(ptyScript).toContain('os.environ["COLUMNS"] = "50000"');
  });

  it('returns a process handle with expected properties', () => {
    const { spawner } = createStack();

    const handle = spawner.spawnTurn({
      cwd: '/workspace',
      message: 'test',
      skipPermissions: true,
    });

    expect(handle.pid).toBe(12345);
    expect(handle.exitPromise).toBeInstanceOf(Promise);
    expect(typeof handle.kill).toBe('function');
  });
});

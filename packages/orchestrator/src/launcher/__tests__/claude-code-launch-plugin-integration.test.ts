import { describe, it, expect } from 'vitest';
import { AgentLauncher } from '../agent-launcher.js';
import { GenericSubprocessPlugin } from '../generic-subprocess-plugin.js';
import { ClaudeCodeLaunchPlugin } from '@generacy-ai/generacy-plugin-claude-code';
import { RecordingProcessFactory } from '../../test-utils/index.js';
import type { LaunchRequest } from '../types.js';

describe('ClaudeCodeLaunchPlugin integration', () => {
  it('routes phase intent to ClaudeCodeLaunchPlugin via AgentLauncher', async () => {
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

    const request: LaunchRequest = {
      intent: {
        kind: 'phase',
        phase: 'implement',
        prompt: 'https://github.com/org/repo/issues/123',
      } as any,
      cwd: '/tmp/test-repo',
    };

    const handle = await launcher.launch(request);

    expect(handle.metadata.pluginId).toBe('claude-code');
    expect(handle.metadata.intentKind).toBe('phase');
    expect(handle.process).toBeDefined();
    expect(handle.outputParser).toBeDefined();

    // Verify the default factory was used (phase intent uses stdioProfile: "default")
    expect(defaultFactory.calls).toHaveLength(1);
    expect(interactiveFactory.calls).toHaveLength(0);

    const call = defaultFactory.calls[0];
    expect(call.command).toBe('claude');
    expect(call.args).toContain('-p');
    expect(call.args).toContain('--dangerously-skip-permissions');
    expect(call.cwd).toBe('/tmp/test-repo');
  });

  it('routes conversation-turn intent to interactive factory', async () => {
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

    const request: LaunchRequest = {
      intent: {
        kind: 'conversation-turn',
        message: 'Hello',
        skipPermissions: true,
      } as any,
      cwd: '/tmp/test-repo',
    };

    const handle = await launcher.launch(request);

    expect(handle.metadata.pluginId).toBe('claude-code');
    expect(handle.metadata.intentKind).toBe('conversation-turn');

    // Verify the interactive factory was used (conversation-turn uses stdioProfile: "interactive")
    expect(defaultFactory.calls).toHaveLength(0);
    expect(interactiveFactory.calls).toHaveLength(1);

    const call = interactiveFactory.calls[0];
    expect(call.command).toBe('python3');
  });
});

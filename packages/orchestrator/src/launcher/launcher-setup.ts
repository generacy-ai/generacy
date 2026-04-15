import type { ProcessFactory } from '../worker/types.js';
import type { CredhelperClient } from './credhelper-client.js';
import { AgentLauncher } from './agent-launcher.js';
import { GenericSubprocessPlugin } from './generic-subprocess-plugin.js';
import { ClaudeCodeLaunchPlugin } from '@generacy-ai/generacy-plugin-claude-code';

/**
 * Create a fully configured AgentLauncher with all standard plugins registered.
 *
 * Shared between server.ts (full mode) and ClaudeCliWorker (worker mode) to
 * ensure identical plugin registrations across both entry points.
 */
export function createAgentLauncher(factories: {
  default: ProcessFactory;
  interactive: ProcessFactory;
}, credhelperClient?: CredhelperClient): AgentLauncher {
  const launcher = new AgentLauncher(
    new Map([
      ['default', factories.default],
      ['interactive', factories.interactive],
    ]),
    credhelperClient,
  );
  launcher.registerPlugin(new GenericSubprocessPlugin());
  launcher.registerPlugin(new ClaudeCodeLaunchPlugin());
  return launcher;
}

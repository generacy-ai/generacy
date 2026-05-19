import type {
  AgentLaunchPlugin,
  LaunchIntent,
  LaunchSpec,
  OutputParser,
} from './types.js';

/**
 * Pass-through plugin for generic-subprocess and shell intents.
 *
 * - generic-subprocess: passes command, args, env directly
 * - shell: wraps command in `sh -c`
 */
export class GenericSubprocessPlugin implements AgentLaunchPlugin {
  readonly pluginId = 'generic-subprocess';
  readonly supportedKinds = ['generic-subprocess', 'shell'] as const;

  buildLaunch(intent: LaunchIntent): LaunchSpec {
    switch (intent.kind) {
      case 'generic-subprocess':
        return {
          command: intent.command,
          args: intent.args,
          env: intent.env,
          stdioProfile: intent.stdioProfile ?? 'default',
          detached: intent.detached,
        };
      case 'shell':
        return {
          command: 'sh',
          args: ['-c', intent.command],
          env: intent.env,
          stdioProfile: 'default',
          detached: intent.detached,
        };
      default:
        throw new Error(`Unsupported intent kind: ${(intent as LaunchIntent).kind}`);
    }
  }

  createOutputParser(_intent: LaunchIntent): OutputParser {
    return {
      processChunk(_stream: 'stdout' | 'stderr', _data: string): void {
        // no-op pass-through
      },
      flush(): void {
        // no-op
      },
    };
  }
}

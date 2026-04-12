import type { ClaudeCodeIntent, PhaseIntent, PrFeedbackIntent, ConversationTurnIntent, InvokeIntent } from './types.js';
import { PHASE_TO_COMMAND, PTY_WRAPPER } from './constants.js';

/**
 * Structurally compatible with orchestrator's LaunchSpec.
 * Defined locally to avoid circular dependency between packages.
 */
interface LaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  stdioProfile?: string;
}

/**
 * Structurally compatible with orchestrator's OutputParser.
 */
interface OutputParser {
  processChunk(stream: 'stdout' | 'stderr', data: string): void;
  flush(): void;
}

/**
 * Launch plugin for Claude Code subprocess invocations.
 *
 * Handles three intent kinds:
 * - phase: speckit workflow phase execution
 * - pr-feedback: PR review feedback addressing
 * - conversation-turn: interactive conversation via PTY wrapper
 *
 * Structurally compatible with the orchestrator's AgentLaunchPlugin interface.
 * No circular import required — TypeScript structural typing ensures compatibility
 * when registered in claude-cli-worker.ts.
 */
export class ClaudeCodeLaunchPlugin {
  readonly pluginId = 'claude-code';
  readonly supportedKinds = ['phase', 'pr-feedback', 'conversation-turn', 'invoke'] as const;

  buildLaunch(intent: ClaudeCodeIntent): LaunchSpec {
    switch (intent.kind) {
      case 'phase':
        return this.buildPhaseLaunch(intent);
      case 'pr-feedback':
        return this.buildPrFeedbackLaunch(intent);
      case 'conversation-turn':
        return this.buildConversationTurnLaunch(intent);
      case 'invoke':
        return this.buildInvokeLaunch(intent);
      default:
        throw new Error(`Unsupported intent kind: ${(intent as any).kind}`);
    }
  }

  createOutputParser(_intent: ClaudeCodeIntent): OutputParser {
    // No-op parser — existing callers manage their own OutputCapture.
    // Full parser logic deferred to Wave 3 when callers migrate.
    return {
      processChunk(_stream: 'stdout' | 'stderr', _data: string): void {
        // no-op pass-through
      },
      flush(): void {
        // no-op
      },
    };
  }

  private buildPhaseLaunch(intent: PhaseIntent): LaunchSpec {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--verbose',
    ];

    if (intent.sessionId) {
      args.push('--resume', intent.sessionId);
    }

    const command = PHASE_TO_COMMAND[intent.phase];
    args.push(`${command} ${intent.prompt}`);

    return {
      command: 'claude',
      args,
      stdioProfile: 'default',
    };
  }

  private buildPrFeedbackLaunch(intent: PrFeedbackIntent): LaunchSpec {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--verbose',
      intent.prompt,
    ];

    return {
      command: 'claude',
      args,
      stdioProfile: 'default',
    };
  }

  private buildInvokeLaunch(intent: InvokeIntent): LaunchSpec {
    return {
      command: 'claude',
      args: ['--print', '--dangerously-skip-permissions', intent.command],
      stdioProfile: 'default',
    };
  }

  private buildConversationTurnLaunch(intent: ConversationTurnIntent): LaunchSpec {
    const claudeArgs = [
      'claude',
      '-p', intent.message,
      '--output-format', 'stream-json',
      '--verbose',
    ];

    if (intent.sessionId) {
      claudeArgs.push('--resume', intent.sessionId);
    }

    if (intent.skipPermissions) {
      claudeArgs.push('--dangerously-skip-permissions');
    }

    if (intent.model) {
      claudeArgs.push('--model', intent.model);
    }

    return {
      command: 'python3',
      args: ['-u', '-c', PTY_WRAPPER, ...claudeArgs],
      stdioProfile: 'interactive',
    };
  }
}

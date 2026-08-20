import { execFileSync } from 'node:child_process';
import type {
  ClaudeCodeIntent,
  PhaseIntent,
  PrFeedbackIntent,
  ValidateFixIntent,
  MergeConflictIntent,
  ReviewIntent,
  ConversationTurnIntent,
  InvokeIntent,
} from './types.js';
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
 * Process-lifetime cache for the `--effort` capability probe. `undefined`
 * means the probe has not yet run; `true`/`false` is the resolved answer.
 * See `ClaudeCodeLaunchPlugin.hasEffortMechanism()`.
 */
let effortMechanismCache: boolean | undefined = undefined;

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
  readonly provider = 'claude-code';
  readonly supportedKinds = ['phase', 'pr-feedback', 'validate-fix', 'merge-conflict', 'review', 'conversation-turn', 'invoke'] as const;

  /**
   * Whether the installed CLI supports a delivery mechanism for reasoning effort.
   *
   * Probes `claude --help` once per process (result cached in
   * `effortMechanismCache`) and greps for `--effort`. Consulted by validate-time
   * (`packages/generacy`) and spawn-time (orchestrator worker) warning surfaces
   * per FR-010a of issue #1095. Runtime detection closes the drift hazard
   * called out in the #1096 review Finding 3: a container whose CLI predates or
   * removes `--effort` would otherwise still get the flag appended and fail the
   * spawn with an unknown-option error and no `agent.effort.dropped` warning.
   *
   * If the probe cannot run (`claude` not on PATH, spawn error, timeout), the
   * cache falls back to `true` — preserves the pre-#1096 behavior for hosts
   * that do not yet have the CLI installed but will at spawn time. Force a
   * fixed result in tests via `_setHasEffortMechanismForTests`.
   */
  static hasEffortMechanism(): boolean {
    if (effortMechanismCache !== undefined) return effortMechanismCache;
    try {
      const output = execFileSync('claude', ['--help'], {
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      effortMechanismCache = /(^|\s)--effort(\s|=|$)/.test(output);
    } catch {
      // `claude` not on PATH, spawn failed, or --help exited non-zero — preserve
      // prior behavior. Operator surfaces (validate warnings + spawn-time
      // warnings) rely on the plugin telling the truth about the CLI installed
      // in the same environment; when we can't tell, don't invent a warning.
      effortMechanismCache = true;
    }
    return effortMechanismCache;
  }

  /**
   * Test-only cache override. Pass `undefined` to force a re-probe on the next
   * `hasEffortMechanism()` call. Not part of the public API.
   */
  static _setHasEffortMechanismForTests(value: boolean | undefined): void {
    effortMechanismCache = value;
  }

  buildLaunch(intent: ClaudeCodeIntent): LaunchSpec {
    switch (intent.kind) {
      case 'phase':
        return this.buildPhaseLaunch(intent);
      case 'pr-feedback':
        return this.buildPrFeedbackLaunch(intent);
      case 'validate-fix':
        return this.buildValidateFixLaunch(intent);
      case 'merge-conflict':
        return this.buildMergeConflictLaunch(intent);
      case 'review':
        return this.buildReviewLaunch(intent);
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

    if (intent.model) {
      args.push('--model', intent.model);
    }

    if (intent.effort) {
      args.push('--effort', intent.effort);
    }

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
    ];

    if (intent.model) {
      args.push('--model', intent.model);
    }

    if (intent.effort) {
      args.push('--effort', intent.effort);
    }

    args.push(intent.prompt);

    return {
      command: 'claude',
      args,
      stdioProfile: 'default',
    };
  }

  private buildValidateFixLaunch(intent: ValidateFixIntent): LaunchSpec {
    // Same shape as pr-feedback — one bounded agent turn with a prepared prompt.
    // The `evidenceHash` on the intent is metadata for launcher observability,
    // not CLI input. See specs/892-found-during-cockpit-v1/contracts/validate-fix-handler.md.
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--verbose',
    ];

    if (intent.model) {
      args.push('--model', intent.model);
    }

    if (intent.effort) {
      args.push('--effort', intent.effort);
    }

    args.push(intent.prompt);

    return {
      command: 'claude',
      args,
      stdioProfile: 'default',
    };
  }

  private buildMergeConflictLaunch(intent: MergeConflictIntent): LaunchSpec {
    // Same shape as pr-feedback / validate-fix — one bounded agent turn with
    // a prepared prompt. See specs/898-found-during-cockpit-v1/contracts/
    // handler-contract.md §"Sibling-owned path constraint".
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--verbose',
    ];

    if (intent.model) {
      args.push('--model', intent.model);
    }

    if (intent.effort) {
      args.push('--effort', intent.effort);
    }

    args.push(intent.prompt);

    return {
      command: 'claude',
      args,
      stdioProfile: 'default',
    };
  }

  private buildReviewLaunch(intent: ReviewIntent): LaunchSpec {
    // Same shape as pr-feedback / validate-fix / merge-conflict — one bounded
    // agent turn with an engine-built charter prompt (#1124). The charter is
    // constructed in-process by the ReviewExecutor (Q4→B — no /speckit:review
    // slash command). See specs/1124-context-new-review-phase/contracts/
    // review-executor.md.
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--verbose',
    ];

    if (intent.model) {
      args.push('--model', intent.model);
    }

    if (intent.effort) {
      args.push('--effort', intent.effort);
    }

    args.push(intent.prompt);

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

    if (intent.effort) {
      claudeArgs.push('--effort', intent.effort);
    }

    return {
      command: 'python3',
      args: ['-u', '-c', PTY_WRAPPER, ...claudeArgs],
      stdioProfile: 'interactive',
    };
  }
}

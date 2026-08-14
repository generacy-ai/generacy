import type { Effort } from '@generacy-ai/config';
import type { Logger } from './types.js';
import { ClaudeCodeLaunchPlugin } from '@generacy-ai/generacy-plugin-claude-code';

/**
 * Per-provider registry for the reasoning-effort delivery mechanism (issue
 * #1095 D-5, FR-010a-b spawn-time warning source). Mirrors the CLI-side probe
 * in `packages/generacy/src/config/effort-mechanism-probe.ts`. Consulted at
 * spawn time to emit exactly one warning per spawn when `effort` is set but
 * the provider's plugin has no CLI mechanism.
 */
const PROVIDER_HAS_EFFORT_MECHANISM: Record<string, () => boolean> = {
  'claude-code': () => ClaudeCodeLaunchPlugin.hasEffortMechanism(),
};

/**
 * Whether the named provider has a CLI-observable mechanism for reasoning
 * effort. Unknown provider → `false` (the warning surface fires).
 */
export function providerHasEffortMechanism(provider: string | undefined): boolean {
  if (!provider) return false;
  const probe = PROVIDER_HAS_EFFORT_MECHANISM[provider];
  return probe ? probe() : false;
}

/**
 * Emit a single `agent.effort.dropped` warning if `effort` is set but the
 * resolved provider has no CLI mechanism to deliver it. Callers invoke this
 * exactly once per spawn — CliSpawner from the phase path (#1095 D-5), and
 * each fixer handler (pr-feedback, validate-fix, merge-conflict) before its
 * `agentLauncher.launch` call. Without the per-handler calls, dropped-effort
 * warnings only fire on phase spawns; the three fixer paths silently swallow
 * the drop, violating the 'once per spawn' half of Q3=D (#1095 review Finding 2).
 */
export function warnIfEffortDropped(
  logger: Logger,
  options: {
    provider: string | undefined;
    effort: Effort | undefined;
    /** Free-form context field(s) so the emitted line is source-attributable. */
    context: Record<string, unknown>;
  },
): void {
  if (options.effort === undefined) return;
  if (providerHasEffortMechanism(options.provider)) return;
  logger.warn(
    {
      ...options.context,
      provider: options.provider ?? '(default)',
      effort: options.effort,
      reason: 'no-cli-mechanism',
    },
    'agent.effort.dropped',
  );
}

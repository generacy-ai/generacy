/**
 * Per-provider capability probe for the reasoning-effort delivery mechanism
 * (issue #1095 D-5, FR-010a).
 *
 * Mirrors the plugin's own `hasEffortMechanism()` const (see
 * `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts`
 * `ClaudeCodeLaunchPlugin.hasEffortMechanism`). Kept as a small local registry
 * because `packages/generacy` does not take a direct workspace dependency on
 * the plugin package. When a new provider ships with an effort-argv path,
 * add a `{ '<provider>': true }` entry here alongside the plugin update.
 *
 * Values must match the shipped plugin's `hasEffortMechanism()` return value
 * at build time. Consumers: `validate` command warnings channel + orchestrator
 * spawn-time warning surface (via a separate helper in the orchestrator).
 */

const PROVIDER_EFFORT_MECHANISM: Record<string, boolean> = {
  // Claude CLI v2.1.150 exposes `--effort <level>` as a first-class flag.
  'claude-code': true,
};

/**
 * Whether the named provider has a CLI-observable mechanism for reasoning effort.
 * Unknown providers return `false` — the CLI validate command surfaces a warning
 * naming both `effort` and the provider so the operator can act on it.
 */
export function hasEffortMechanism(provider: string): boolean {
  return PROVIDER_EFFORT_MECHANISM[provider] ?? false;
}

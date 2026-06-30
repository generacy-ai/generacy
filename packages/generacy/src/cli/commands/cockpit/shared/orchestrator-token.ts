/**
 * Token resolution for the cockpit orchestrator client.
 *
 * Pure function: no `process.env` access, no logging, no I/O. The caller is
 * responsible for sourcing `envValue` (typically `process.env.ORCHESTRATOR_API_TOKEN`)
 * and `configValue` (typically `loaded.config.orchestrator?.token`) and
 * passing them in. This is the only place the CLI consults for token
 * precedence — commands inject the resolved string into
 * `createOrchestratorClient({ token })`.
 */

export interface TokenSources {
  /** Typically `process.env.ORCHESTRATOR_API_TOKEN`. */
  envValue: string | undefined;
  /** Typically `loaded.config.orchestrator?.token`. */
  configValue: string | undefined;
}

/**
 * Resolve the orchestrator API token.
 *
 * Rules:
 * - Both inputs are trimmed.
 * - If trimmed `envValue` is non-empty, return it.
 * - Else if trimmed `configValue` is non-empty, return it.
 * - Else return `undefined`.
 * - `null`, `undefined`, `""`, or whitespace-only inputs are treated as unset.
 */
export function resolveOrchestratorToken(
  sources: TokenSources,
): string | undefined {
  const env = (sources.envValue ?? '').trim();
  if (env.length > 0) {
    return env;
  }
  const config = (sources.configValue ?? '').trim();
  if (config.length > 0) {
    return config;
  }
  return undefined;
}

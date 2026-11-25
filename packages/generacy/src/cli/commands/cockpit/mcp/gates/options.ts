/**
 * Options-bag resolver for the two remote-gate tools (#1022).
 *
 * `resolveGateOptions` is the ONLY place in this package that reads
 * `process.env` for orchestrator configuration — parity tests inject a
 * distinct `env` argument so no `global.fetch` monkey-patch or env-var
 * mutation is required.
 *
 * Precedence chain (data-model.md § "Options-bag schema"):
 *   baseUrl:    deps.orchestratorUrl > env.ORCHESTRATOR_URL > 'http://127.0.0.1:3100'
 *   timeoutMs:  deps.orchestratorTimeoutMs > 5000
 *   fetchImpl:  deps.fetchImpl > global fetch
 *   appUrl:     deps.appUrl > env.GENERACY_APP_URL > 'https://app.generacy.ai'
 */
import type { BuildMcpServerDeps } from '../server.js';

export interface GateClientOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  appUrl: string;
}

export function resolveGateOptions(
  deps: Pick<
    BuildMcpServerDeps,
    'orchestratorUrl' | 'orchestratorTimeoutMs' | 'fetchImpl' | 'appUrl'
  >,
  env: NodeJS.ProcessEnv = process.env,
): GateClientOptions {
  return {
    baseUrl: deps.orchestratorUrl ?? env['ORCHESTRATOR_URL'] ?? 'http://127.0.0.1:3100',
    timeoutMs: deps.orchestratorTimeoutMs ?? 5000,
    fetchImpl: deps.fetchImpl ?? fetch,
    appUrl: deps.appUrl ?? env['GENERACY_APP_URL'] ?? 'https://app.generacy.ai',
  };
}

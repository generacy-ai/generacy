/**
 * Simplified OrchestratorConfig interface.
 * The full Zod-inferred type lives in @generacy-ai/orchestrator.
 * This is the minimal surface the CLI needs for type annotations.
 */
export interface OrchestratorConfig {
  mode: 'full' | 'worker';
  server: { host: string; port: number };
  redis: { url: string; prefix?: string };
  auth: { apiKeys: string[]; enabled?: boolean };
  repositories: Array<{ url?: string; name?: string; owner?: string; repo?: string; [key: string]: unknown }>;
  logging: { level: string; pretty?: boolean };
  monitor: { pollIntervalMs?: number };
  dispatch: { heartbeatTtlMs?: number; shutdownTimeoutMs?: number };
  labelMonitor?: boolean;
  [key: string]: unknown;
}

import { z } from 'zod';

export interface RelayConfig {
  apiKey: string;
  relayUrl: string;
  orchestratorUrl: string;
  orchestratorApiKey?: string;
  requestTimeoutMs: number;
  heartbeatIntervalMs: number;
  baseReconnectDelayMs: number;
  maxReconnectDelayMs: number;
}

export const RelayConfigSchema = z.object({
  apiKey: z.string().min(1, 'GENERACY_API_KEY is required'),
  relayUrl: z.string().url().default('wss://api.generacy.ai/relay'),
  orchestratorUrl: z.string().url().default('http://localhost:3000'),
  orchestratorApiKey: z.string().optional(),
  requestTimeoutMs: z.number().positive().default(30000),
  heartbeatIntervalMs: z.number().positive().default(30000),
  baseReconnectDelayMs: z.number().positive().default(5000),
  maxReconnectDelayMs: z.number().positive().default(300000),
});

/**
 * Load relay configuration from environment variables, with optional overrides.
 */
export function loadConfig(overrides?: Partial<RelayConfig>): RelayConfig {
  const env: Record<string, unknown> = {
    apiKey: process.env['GENERACY_API_KEY'] ?? '',
    relayUrl: process.env['RELAY_URL'] ?? undefined,
    orchestratorUrl: process.env['ORCHESTRATOR_URL'] ?? undefined,
    orchestratorApiKey: process.env['ORCHESTRATOR_API_KEY'] ?? undefined,
    requestTimeoutMs: process.env['REQUEST_TIMEOUT_MS']
      ? Number(process.env['REQUEST_TIMEOUT_MS'])
      : undefined,
    heartbeatIntervalMs: process.env['HEARTBEAT_INTERVAL_MS']
      ? Number(process.env['HEARTBEAT_INTERVAL_MS'])
      : undefined,
    baseReconnectDelayMs: process.env['BASE_RECONNECT_DELAY_MS']
      ? Number(process.env['BASE_RECONNECT_DELAY_MS'])
      : undefined,
    maxReconnectDelayMs: process.env['MAX_RECONNECT_DELAY_MS']
      ? Number(process.env['MAX_RECONNECT_DELAY_MS'])
      : undefined,
  };

  // Remove undefined values so Zod defaults apply
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined),
  );

  // Merge overrides (takes precedence over env vars)
  const merged = { ...cleaned, ...overrides };

  return RelayConfigSchema.parse(merged);
}

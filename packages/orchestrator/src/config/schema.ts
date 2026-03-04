import { z } from 'zod';
import { WorkerConfigSchema, type WorkerConfig } from '../worker/config.js';

/**
 * Logging level configuration
 */
export const LogLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevelSchema>;

/**
 * Server configuration
 */
export const ServerConfigSchema = z.object({
  /** Port to listen on (0 = random available port) */
  port: z.number().int().min(0).max(65535).default(3000),
  /** Host to bind to */
  host: z.string().default('0.0.0.0'),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/**
 * Redis configuration
 */
export const RedisConfigSchema = z.object({
  /** Redis connection URL */
  url: z.string().url().default('redis://localhost:6379'),
});
export type RedisConfig = z.infer<typeof RedisConfigSchema>;

/**
 * GitHub OAuth configuration
 */
export const GitHubOAuthConfigSchema = z.object({
  /** GitHub OAuth client ID */
  clientId: z.string().min(1),
  /** GitHub OAuth client secret */
  clientSecret: z.string().min(1),
  /** OAuth callback URL */
  callbackUrl: z.string().url().default('http://localhost:3000/auth/github/callback'),
});
export type GitHubOAuthConfig = z.infer<typeof GitHubOAuthConfigSchema>;

/**
 * JWT configuration
 */
export const JWTConfigSchema = z.object({
  /** Secret key for signing JWTs */
  secret: z.string().min(32),
  /** Token expiration time */
  expiresIn: z.string().default('24h'),
});
export type JWTConfig = z.infer<typeof JWTConfigSchema>;

/**
 * Authentication configuration
 */
export const AuthConfigSchema = z.object({
  /** Whether authentication is enabled */
  enabled: z.boolean().default(true),
  /** Enabled authentication providers */
  providers: z.array(z.enum(['apiKey', 'github-oauth2'])).default(['apiKey']),
  /** GitHub OAuth configuration (required if github-oauth2 provider is enabled) */
  github: GitHubOAuthConfigSchema.optional(),
  /** JWT configuration */
  jwt: JWTConfigSchema,
});
export type AuthConfig = z.infer<typeof AuthConfigSchema>;

/**
 * Rate limit configuration
 */
export const RateLimitConfigSchema = z.object({
  /** Whether rate limiting is enabled */
  enabled: z.boolean().default(true),
  /** Maximum requests per time window */
  max: z.number().int().positive().default(100),
  /** Time window for rate limiting */
  timeWindow: z.string().default('1 minute'),
});
export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;

/**
 * CORS configuration
 */
export const CorsConfigSchema = z.object({
  /** Allowed origins (true = reflect request origin) */
  origin: z.union([z.boolean(), z.string(), z.array(z.string())]).default(true),
  /** Whether to include credentials */
  credentials: z.boolean().default(true),
});
export type CorsConfig = z.infer<typeof CorsConfigSchema>;

/**
 * Logging configuration
 */
export const LoggingConfigSchema = z.object({
  /** Log level */
  level: LogLevelSchema.default('info'),
  /** Pretty print logs (for development) */
  pretty: z.boolean().default(false),
});
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;

/**
 * Repository configuration for label sync
 */
export const RepositoryConfigSchema = z.object({
  /** GitHub organization or username */
  owner: z.string().min(1),
  /** Repository name */
  repo: z.string().min(1),
});
export type RepositoryConfig = z.infer<typeof RepositoryConfigSchema>;

/**
 * Monitor configuration for label detection
 */
export const MonitorConfigSchema = z.object({
  /** Polling interval in milliseconds */
  pollIntervalMs: z.number().int().min(5000).default(30000),
  /** GitHub webhook secret for signature verification */
  webhookSecret: z.string().optional(),
  /** Maximum concurrent GitHub API calls during polling */
  maxConcurrentPolls: z.number().int().min(1).max(20).default(5),
  /** Enable adaptive polling frequency */
  adaptivePolling: z.boolean().default(true),
  /** GitHub username for this cluster — used to filter issues by assignee */
  clusterGithubUsername: z.string().optional(),
});
export type MonitorConfig = z.infer<typeof MonitorConfigSchema>;

/**
 * PR feedback monitor configuration
 */
export const PrMonitorConfigSchema = z.object({
  /** Whether the PR feedback monitor is enabled */
  enabled: z.boolean().default(true),
  /** Polling interval in milliseconds */
  pollIntervalMs: z.number().int().min(5000).default(60000),
  /** GitHub webhook secret for signature verification */
  webhookSecret: z.string().optional(),
  /** Enable adaptive polling frequency */
  adaptivePolling: z.boolean().default(true),
  /** Maximum concurrent GitHub API calls during polling */
  maxConcurrentPolls: z.number().int().min(1).max(20).default(3),
});
export type PrMonitorConfig = z.infer<typeof PrMonitorConfigSchema>;

/**
 * Epic completion monitor configuration
 */
export const EpicMonitorConfigSchema = z.object({
  /** Whether the epic completion monitor is enabled */
  enabled: z.boolean().default(true),
  /** Polling interval in milliseconds (minimum 60 seconds) */
  pollIntervalMs: z.number().int().min(60000).default(300000),
});
export type EpicMonitorConfig = z.infer<typeof EpicMonitorConfigSchema>;

/**
 * Dispatch configuration for worker queue and dispatcher
 */
export const DispatchConfigSchema = z.object({
  /** Interval between queue polls in milliseconds */
  pollIntervalMs: z.number().int().min(1000).default(5000),
  /** Maximum number of concurrent workers */
  maxConcurrentWorkers: z.number().int().min(1).max(20).default(3),
  /** Worker heartbeat TTL in milliseconds */
  heartbeatTtlMs: z.number().int().min(5000).default(30000),
  /** Interval between heartbeat/reaper checks in milliseconds */
  heartbeatCheckIntervalMs: z.number().int().min(5000).default(15000),
  /** Timeout for graceful shutdown of workers in milliseconds */
  shutdownTimeoutMs: z.number().int().min(5000).default(60000),
  /** Maximum retry attempts before dead-lettering */
  maxRetries: z.number().int().min(1).default(3),
});
export type DispatchConfig = z.infer<typeof DispatchConfigSchema>;

export { WorkerConfigSchema, type WorkerConfig };

/**
 * Smee.io webhook proxy configuration
 */
export const SmeeConfigSchema = z.object({
  /** Smee.io channel URL for receiving webhook events */
  channelUrl: z.string().url().optional(),
  /** Fallback poll interval when Smee is active (milliseconds) */
  fallbackPollIntervalMs: z.number().int().min(30000).default(300000),
});
export type SmeeConfig = z.infer<typeof SmeeConfigSchema>;

/**
 * Webhook setup configuration
 */
export const WebhookSetupConfigSchema = z.object({
  /** Whether automatic webhook setup is enabled */
  enabled: z.boolean().default(false),
});
export type WebhookSetupConfig = z.infer<typeof WebhookSetupConfigSchema>;

/**
 * Complete orchestrator configuration
 */
export const OrchestratorConfigSchema = z.object({
  server: ServerConfigSchema.default({}),
  redis: RedisConfigSchema.default({}),
  auth: AuthConfigSchema,
  rateLimit: RateLimitConfigSchema.default({}),
  cors: CorsConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
  repositories: z.array(RepositoryConfigSchema).default([]),
  monitor: MonitorConfigSchema.default({}),
  prMonitor: PrMonitorConfigSchema.default({}),
  epicMonitor: EpicMonitorConfigSchema.default({}),
  dispatch: DispatchConfigSchema.default({}),
  worker: WorkerConfigSchema.default({}),
  smee: SmeeConfigSchema.default({}),
  webhookSetup: WebhookSetupConfigSchema.default({}),
});
export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;

/**
 * Validate configuration and return typed result
 */
export function validateConfig(config: unknown): OrchestratorConfig {
  return OrchestratorConfigSchema.parse(config);
}

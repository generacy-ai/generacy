import { z } from 'zod';

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
});
export type MonitorConfig = z.infer<typeof MonitorConfigSchema>;

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
});
export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;

/**
 * Validate configuration and return typed result
 */
export function validateConfig(config: unknown): OrchestratorConfig {
  return OrchestratorConfigSchema.parse(config);
}

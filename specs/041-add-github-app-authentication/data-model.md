# Data Model: GitHub App Authentication

## Core Types

### Auth Configuration

```typescript
/**
 * GitHub App authentication configuration
 */
interface GitHubAppConfig {
  /** GitHub App ID (numeric) */
  appId: number | string;

  /** Private key in PEM format */
  privateKey?: string;

  /** Path to private key PEM file */
  privateKeyPath?: string;

  /** Installation ID (optional - auto-discovered if not provided) */
  installationId?: number;
}

/**
 * Extended plugin configuration with GitHub App support
 */
interface GitHubIssuesConfig {
  // Existing fields
  owner: string;
  repo: string;
  webhookSecret?: string;
  agentAccount?: string;
  triggerLabels?: string[];
  baseUrl?: string;

  // PAT authentication (existing, now optional)
  token?: string;

  // GitHub App authentication (new)
  app?: GitHubAppConfig;
}
```

### Environment Variable Mapping

```typescript
/**
 * Environment variables for GitHub App auth
 */
interface GitHubAppEnvVars {
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_PRIVATE_KEY_PATH?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
}
```

### Token Cache

```typescript
/**
 * Cached installation access token
 */
interface CachedToken {
  /** The access token */
  token: string;

  /** Token expiration time */
  expiresAt: Date;

  /** Installation ID this token is for */
  installationId: number;

  /** Permissions granted */
  permissions: Record<string, string>;

  /** Repository selection */
  repositorySelection: 'all' | 'selected';
}
```

### Auth Strategy

```typescript
/**
 * Authentication strategy interface
 */
interface AuthStrategy {
  /** Get a valid auth token */
  getToken(): Promise<string>;

  /** Verify the authentication works */
  verify(): Promise<AuthVerification>;

  /** Get auth type for logging */
  readonly type: 'pat' | 'github-app';
}

interface AuthVerification {
  login: string;
  id: number;
  type: 'User' | 'Bot';
}
```

## Validation Schemas

```typescript
import { z } from 'zod';

/**
 * GitHub App config validation
 */
const GitHubAppConfigSchema = z.object({
  appId: z.union([z.number().positive(), z.string().regex(/^\d+$/)]),
  privateKey: z.string().optional(),
  privateKeyPath: z.string().optional(),
  installationId: z.number().positive().optional(),
}).refine(
  (data) => data.privateKey || data.privateKeyPath,
  { message: 'Either privateKey or privateKeyPath is required' }
);

/**
 * Extended config validation
 */
const ExtendedConfigSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  token: z.string().optional(),
  app: GitHubAppConfigSchema.optional(),
  webhookSecret: z.string().optional(),
  agentAccount: z.string().optional(),
  triggerLabels: z.array(z.string()).optional(),
  baseUrl: z.string().url().optional(),
}).refine(
  (data) => data.token || data.app,
  { message: 'Either token or app configuration is required' }
);
```

## API Response Types

### Installation List Response

```typescript
interface Installation {
  id: number;
  account: {
    login: string;
    id: number;
    type: 'User' | 'Organization';
  };
  repository_selection: 'all' | 'selected';
  permissions: Record<string, 'read' | 'write' | 'admin'>;
  events: string[];
}

interface InstallationListResponse {
  installations: Installation[];
}
```

### Installation Token Response

```typescript
interface InstallationTokenResponse {
  token: string;
  expires_at: string; // ISO 8601 datetime
  permissions: Record<string, string>;
  repository_selection: 'all' | 'selected';
  repositories?: Array<{
    id: number;
    name: string;
    full_name: string;
  }>;
}
```

## Error Types

```typescript
/**
 * GitHub App authentication errors
 */
class GitHubAppAuthError extends Error {
  constructor(
    message: string,
    public readonly code: GitHubAppErrorCode,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'GitHubAppAuthError';
  }
}

enum GitHubAppErrorCode {
  INVALID_PRIVATE_KEY = 'INVALID_PRIVATE_KEY',
  PRIVATE_KEY_NOT_FOUND = 'PRIVATE_KEY_NOT_FOUND',
  INSTALLATION_NOT_FOUND = 'INSTALLATION_NOT_FOUND',
  TOKEN_GENERATION_FAILED = 'TOKEN_GENERATION_FAILED',
  JWT_GENERATION_FAILED = 'JWT_GENERATION_FAILED',
}
```

## Relationships

```
GitHubIssuesConfig
├── token (PAT auth - optional)
└── app (GitHub App auth - optional)
    ├── appId
    ├── privateKey OR privateKeyPath
    └── installationId (optional, auto-discovered)

GitHubClient
└── AuthStrategy
    ├── PATAuthStrategy
    │   └── token
    └── GitHubAppAuthStrategy
        ├── appId
        ├── privateKey
        ├── installationId
        └── TokenCache
            └── CachedToken
```

import type { GitHubAppConfig } from './types.js';
import * as fs from 'node:fs';

/**
 * Environment variable names for GitHub App authentication
 */
export const ENV_VARS = {
  GITHUB_APP_ID: 'GITHUB_APP_ID',
  GITHUB_APP_PRIVATE_KEY: 'GITHUB_APP_PRIVATE_KEY',
  GITHUB_APP_PRIVATE_KEY_PATH: 'GITHUB_APP_PRIVATE_KEY_PATH',
  GITHUB_APP_INSTALLATION_ID: 'GITHUB_APP_INSTALLATION_ID',
} as const;

/**
 * Read GitHub App configuration from environment variables
 *
 * Checks for:
 * - GITHUB_APP_ID: Required for GitHub App auth
 * - GITHUB_APP_PRIVATE_KEY: Inline private key (base64 or PEM)
 * - GITHUB_APP_PRIVATE_KEY_PATH: Path to private key file
 * - GITHUB_APP_INSTALLATION_ID: Optional installation ID
 *
 * @returns GitHubAppConfig if environment variables are present, undefined otherwise
 */
export function readGitHubAppConfigFromEnv(): GitHubAppConfig | undefined {
  const appId = process.env[ENV_VARS.GITHUB_APP_ID];

  // If no app ID, GitHub App auth is not configured via env
  if (!appId) {
    return undefined;
  }

  const privateKey = process.env[ENV_VARS.GITHUB_APP_PRIVATE_KEY];
  const privateKeyPath = process.env[ENV_VARS.GITHUB_APP_PRIVATE_KEY_PATH];
  const installationIdStr = process.env[ENV_VARS.GITHUB_APP_INSTALLATION_ID];

  // At least one of privateKey or privateKeyPath must be set
  if (!privateKey && !privateKeyPath) {
    return undefined;
  }

  const config: GitHubAppConfig = {
    appId,
    privateKey: privateKey ? decodePrivateKey(privateKey) : undefined,
    privateKeyPath: privateKeyPath,
    installationId: installationIdStr ? parseInt(installationIdStr, 10) : undefined,
  };

  return config;
}

/**
 * Decode a private key that might be base64 encoded
 *
 * GitHub Actions and other CI systems often require base64 encoding
 * for multi-line secrets. This function handles both formats.
 *
 * @param key The private key (PEM or base64)
 * @returns The decoded PEM private key
 */
function decodePrivateKey(key: string): string {
  // Check if it looks like a PEM key
  if (key.includes('-----BEGIN') && key.includes('-----END')) {
    return key;
  }

  // Try base64 decoding
  try {
    const decoded = Buffer.from(key, 'base64').toString('utf-8');
    // Verify it's a valid PEM after decoding
    if (decoded.includes('-----BEGIN') && decoded.includes('-----END')) {
      return decoded;
    }
    // Not a valid PEM after decoding, return original
    return key;
  } catch {
    // Not valid base64, return original
    return key;
  }
}

/**
 * Check if GitHub App authentication is configured via environment variables
 */
export function hasGitHubAppEnvConfig(): boolean {
  const appId = process.env[ENV_VARS.GITHUB_APP_ID];
  const privateKey = process.env[ENV_VARS.GITHUB_APP_PRIVATE_KEY];
  const privateKeyPath = process.env[ENV_VARS.GITHUB_APP_PRIVATE_KEY_PATH];

  return Boolean(appId && (privateKey || privateKeyPath));
}

/**
 * Load private key from file path
 * Useful for when you have the path but need the content
 */
export function loadPrivateKeyFromPath(path: string): string {
  return fs.readFileSync(path, 'utf-8');
}

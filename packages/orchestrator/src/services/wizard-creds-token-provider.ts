import { stat, readFile } from 'node:fs/promises';

export type TokenProvider = () => Promise<string | undefined>;

/**
 * Parse a KEY=VALUE env file and return the value for the given key.
 * Handles empty lines, comments (#), and optional `export` prefix.
 */
function parseEnvValue(content: string, key: string): string | undefined {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const stripped = trimmed.startsWith('export ') ? trimmed.slice(7) : trimmed;
    const eqIndex = stripped.indexOf('=');
    if (eqIndex === -1) continue;
    const k = stripped.slice(0, eqIndex);
    const v = stripped.slice(eqIndex + 1);
    if (k === key) return v || undefined;
  }
  return undefined;
}

/**
 * Create a token provider that reads GH_TOKEN from a wizard-credentials env file.
 *
 * - Stat-based cache invalidation: re-reads file only when mtime changes
 * - State-transition logging: warns once when resolution starts failing,
 *   logs info once when it resumes
 */
export function createWizardCredsTokenProvider(
  envFilePath: string,
  logger: { info(obj: Record<string, unknown>, msg: string): void; warn(obj: Record<string, unknown>, msg: string): void },
): TokenProvider {
  let cachedToken: string | undefined;
  let lastMtimeMs = 0;
  let lastFailed = false;

  return async () => {
    try {
      const st = await stat(envFilePath);
      if (st.mtimeMs !== lastMtimeMs) {
        const content = await readFile(envFilePath, 'utf-8');
        cachedToken = parseEnvValue(content, 'GH_TOKEN');
        lastMtimeMs = st.mtimeMs;
      }
      if (cachedToken) {
        if (lastFailed) {
          logger.info({ envFilePath }, 'GitHub token resolution resumed');
          lastFailed = false;
        }
        return cachedToken;
      }
      // File exists but GH_TOKEN not found or empty
      if (!lastFailed) {
        logger.warn({ envFilePath }, 'GH_TOKEN not found in wizard-credentials env file');
        lastFailed = true;
      }
      return undefined;
    } catch {
      if (!lastFailed) {
        logger.warn({ envFilePath }, 'GitHub token resolution failed — file not readable');
        lastFailed = true;
      }
      return undefined;
    }
  };
}

import { z } from 'zod';

const DEFAULT_CLOUD_URL = 'https://api.generacy.ai';
const CloudUrlSchema = z.string().url();

let deprecationLogged = false;

/**
 * Resolve the cloud API URL using 4-tier precedence:
 * 1. CLI `--cloud-url` flag value (if provided)
 * 2. `GENERACY_API_URL` env var (if set)
 * 3. `GENERACY_CLOUD_URL` env var (if set, with deprecation log)
 * 4. `https://api.generacy.ai` (default)
 */
export function resolveApiUrl(flagValue?: string): string {
  let url: string;
  if (flagValue) {
    url = flagValue;
  } else if (process.env['GENERACY_API_URL']) {
    url = process.env['GENERACY_API_URL'];
  } else if (process.env['GENERACY_CLOUD_URL']) {
    url = process.env['GENERACY_CLOUD_URL'];
    if (!deprecationLogged) {
      deprecationLogged = true;
      console.debug('[deprecated] GENERACY_CLOUD_URL is ambiguous, prefer GENERACY_API_URL');
    }
  } else {
    url = DEFAULT_CLOUD_URL;
  }
  const result = CloudUrlSchema.safeParse(url);
  if (!result.success) {
    throw new Error(
      `Invalid cloud URL "${url}": must be a valid URL with scheme (e.g. https://api.generacy.ai)`,
    );
  }
  return result.data;
}

/** @deprecated Use {@link resolveApiUrl} instead. */
export const resolveCloudUrl = resolveApiUrl;

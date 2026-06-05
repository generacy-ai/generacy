import { stat, readFile } from 'node:fs/promises';
import { GitHelperError } from '../types/git-token.js';

const DEFAULT_KEY_PATH = '/var/lib/generacy/cluster-api-key';

export interface ClusterApiKeyReader {
  read(): Promise<string>;
}

export interface CreateClusterApiKeyReaderOptions {
  keyPath?: string;
}

export function createClusterApiKeyReader(
  options: CreateClusterApiKeyReaderOptions = {},
): ClusterApiKeyReader {
  const keyPath = options.keyPath ?? DEFAULT_KEY_PATH;
  let cachedValue: string | undefined;
  let lastMtimeMs = -1;

  return {
    async read(): Promise<string> {
      try {
        const st = await stat(keyPath);
        // `mtime.getTime()` is integer-ms (truncated from the kernel's
        // nanosecond mtime). `mtimeMs` may carry fractional nanoseconds that
        // round-trip differently through utimes() — using getTime() keeps the
        // cache invariant stable across FS-precision quirks.
        const mtimeMs = st.mtime.getTime();
        if (mtimeMs !== lastMtimeMs || cachedValue === undefined) {
          const raw = await readFile(keyPath, 'utf8');
          cachedValue = raw.replace(/\r?\n+$/, '');
          lastMtimeMs = mtimeMs;
        }
        if (!cachedValue) {
          throw new GitHelperError(
            'CLUSTER_API_KEY_MISSING',
            `Cluster API key file at ${keyPath} is empty`,
          );
        }
        return cachedValue;
      } catch (err) {
        if (err instanceof GitHelperError) throw err;
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
          throw new GitHelperError(
            'CLUSTER_API_KEY_MISSING',
            `Cluster API key file at ${keyPath} is missing or unreadable`,
            { cause: code },
          );
        }
        throw err;
      }
    },
  };
}

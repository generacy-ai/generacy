import type { BackendEntry } from '@generacy-ai/credhelper';

export const DEFAULT_BACKEND_TYPE = 'cluster-local';

/**
 * Normalize a backend entry, defaulting type to 'cluster-local' when omitted.
 */
export function normalizeBackendEntry(entry: Partial<BackendEntry> & { id: string }): BackendEntry {
  return {
    ...entry,
    type: entry.type || DEFAULT_BACKEND_TYPE,
  } as BackendEntry;
}

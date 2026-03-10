/**
 * Detects drift between repos defined in the config file and repos from env vars.
 * Normalizes both sources to `owner/repo` sets and compares them.
 * Returns null if sets are identical; otherwise returns the differences.
 */
export function detectRepoDrift(
  configRepos: { owner: string; repo: string }[],
  envRepos: { owner: string; repo: string }[],
): { inConfigOnly: string[]; inEnvOnly: string[] } | null {
  const toKey = (r: { owner: string; repo: string }) =>
    `${r.owner}/${r.repo}`.toLowerCase();

  const configSet = new Set(configRepos.map(toKey));
  const envSet = new Set(envRepos.map(toKey));

  const inConfigOnly = [...configSet].filter((k) => !envSet.has(k)).sort();
  const inEnvOnly = [...envSet].filter((k) => !configSet.has(k)).sort();

  if (inConfigOnly.length === 0 && inEnvOnly.length === 0) {
    return null;
  }

  return { inConfigOnly, inEnvOnly };
}

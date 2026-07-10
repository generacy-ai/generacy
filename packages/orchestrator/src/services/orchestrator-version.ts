import { readFileSync } from 'node:fs';

function isRealVersion(candidate: string | undefined): candidate is string {
  return candidate !== undefined && candidate !== '' && candidate !== '0.0.0';
}

export function resolveOrchestratorVersion(): string {
  const envValue = process.env.ORCHESTRATOR_VERSION;
  if (isRealVersion(envValue)) {
    return envValue;
  }

  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    const pkgVersion = typeof parsed.version === 'string' ? parsed.version : undefined;
    if (isRealVersion(pkgVersion)) {
      return pkgVersion;
    }
  } catch {
    // fall through to sentinel
  }

  return 'unknown';
}

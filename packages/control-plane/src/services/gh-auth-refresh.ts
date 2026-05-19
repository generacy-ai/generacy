import { execFile } from 'node:child_process';

export interface RefreshGhAuthResult {
  ok: boolean;
  error?: string;
}

/**
 * Extract the GitHub token from a credential value based on its type.
 *
 * - `github-app`: JSON-encoded `{ token: string, ... }` — extracts `.token`
 * - `github-pat`: raw token string
 * - Other types: returns `null`
 */
export function extractGhToken(type: string, value: string): string | null {
  if (type === 'github-app') {
    try {
      const parsed = JSON.parse(value) as { token?: unknown };
      return typeof parsed.token === 'string' && parsed.token.length > 0
        ? parsed.token
        : null;
    } catch {
      return null;
    }
  }
  if (type === 'github-pat') {
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * Refresh the `gh` CLI auth state by piping a token via stdin to
 * `gh auth login --with-token --hostname github.com`.
 *
 * Token is passed via stdin (never argv) to avoid leaking in `/proc/<pid>/cmdline`.
 * Non-fatal: caller should log on failure but not fail the credential write.
 */
export function refreshGhAuth(token: string): Promise<RefreshGhAuthResult> {
  return new Promise((resolve) => {
    const child = execFile(
      'gh',
      ['auth', 'login', '--with-token', '--hostname', 'github.com'],
      { timeout: 10_000 },
      (error) => {
        if (error) {
          resolve({ ok: false, error: error.message });
        } else {
          resolve({ ok: true });
        }
      },
    );
    child.stdin?.write(token);
    child.stdin?.end();
  });
}

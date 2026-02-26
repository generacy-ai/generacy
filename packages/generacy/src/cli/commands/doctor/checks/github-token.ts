import type { CheckDefinition } from '../types.js';

const REQUIRED_SCOPES = ['repo', 'workflow'] as const;

export const githubTokenCheck: CheckDefinition = {
  id: 'github-token',
  label: 'GitHub Token',
  category: 'credentials',
  dependencies: ['env-file'],
  priority: 'P1',

  async run(context) {
    if (!context.envVars) {
      return {
        status: 'skip',
        message: 'Skipped — env vars not available',
      };
    }

    const token = context.envVars.GITHUB_TOKEN;

    if (!token || token.trim() === '') {
      return {
        status: 'fail',
        message: 'GITHUB_TOKEN is not set',
        suggestion:
          'Add a valid GitHub personal access token to `.generacy/generacy.env`. Generate one at https://github.com/settings/tokens with `repo` and `workflow` scopes.',
      };
    }

    let response: Response;

    try {
      response = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'generacy-doctor',
        },
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        return {
          status: 'fail',
          message: 'GitHub API request timed out',
          suggestion:
            'Check your network connection or try again later.',
        };
      }

      return {
        status: 'fail',
        message: 'Failed to connect to GitHub API',
        suggestion:
          'Check your network connection. If behind a proxy, ensure HTTPS_PROXY is set.',
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    if (response.status === 401) {
      return {
        status: 'fail',
        message: 'GitHub token is invalid',
        suggestion:
          'Generate a new personal access token at https://github.com/settings/tokens with `repo` and `workflow` scopes, then update `.generacy/generacy.env`.',
      };
    }

    if (!response.ok) {
      return {
        status: 'fail',
        message: `GitHub API returned HTTP ${response.status}`,
        suggestion: 'Verify your GitHub token is valid and try again.',
        detail: await response.text().catch(() => ''),
      };
    }

    // Check required scopes from X-OAuth-Scopes header
    const scopesHeader = response.headers.get('x-oauth-scopes');
    const grantedScopes = scopesHeader
      ? scopesHeader.split(',').map((s) => s.trim()).filter(Boolean)
      : [];

    const missingScopes = REQUIRED_SCOPES.filter(
      (scope) => !grantedScopes.includes(scope),
    );

    // Fine-grained tokens don't return X-OAuth-Scopes — treat missing header as acceptable
    if (scopesHeader !== null && missingScopes.length > 0) {
      return {
        status: 'warn',
        message: `GitHub token is missing scopes: ${missingScopes.join(', ')}`,
        suggestion: `Update your token at https://github.com/settings/tokens to include: ${missingScopes.join(', ')}`,
        detail: `Granted scopes: ${grantedScopes.join(', ') || '(none)'}`,
      };
    }

    // Extract username for display
    let username = '';
    try {
      const body = (await response.json()) as { login?: string };
      if (body.login) {
        username = ` (${body.login})`;
      }
    } catch {
      // Non-critical — skip username display
    }

    return {
      status: 'pass',
      message: `GitHub token is valid${username}`,
      detail: scopesHeader !== null
        ? `Scopes: ${grantedScopes.join(', ') || '(none)'}`
        : 'Fine-grained token (no classic scopes header)',
    };
  },
};

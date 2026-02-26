import type { CheckDefinition } from '../types.js';

export const anthropicKeyCheck: CheckDefinition = {
  id: 'anthropic-key',
  label: 'Anthropic API Key',
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

    const apiKey = context.envVars.ANTHROPIC_API_KEY;

    if (!apiKey || apiKey.trim() === '') {
      return {
        status: 'fail',
        message: 'ANTHROPIC_API_KEY is not set',
        suggestion:
          'Add a valid Anthropic API key to `.generacy/generacy.env`. Get one at https://console.anthropic.com/settings/keys',
      };
    }

    let response: Response;

    try {
      response = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        return {
          status: 'fail',
          message: 'Anthropic API request timed out',
          suggestion:
            'Check your network connection or try again later.',
        };
      }

      return {
        status: 'fail',
        message: 'Failed to connect to Anthropic API',
        suggestion:
          'Check your network connection. If behind a proxy, ensure HTTPS_PROXY is set.',
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    if (response.status === 401) {
      return {
        status: 'fail',
        message: 'Anthropic API key is invalid',
        suggestion:
          'Generate a new API key at https://console.anthropic.com/settings/keys and update `.generacy/generacy.env`.',
      };
    }

    if (!response.ok) {
      return {
        status: 'fail',
        message: `Anthropic API returned HTTP ${response.status}`,
        suggestion: 'Verify your Anthropic API key is valid and try again.',
        detail: await response.text().catch(() => ''),
      };
    }

    return {
      status: 'pass',
      message: 'Anthropic API key is valid',
    };
  },
};

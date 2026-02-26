import type { CheckDefinition } from '../types.js';

export const agencyMcpCheck: CheckDefinition = {
  id: 'agency-mcp',
  label: 'Agency MCP',
  category: 'services',
  dependencies: [],
  priority: 'P2',

  async run() {
    const agencyUrl = process.env['AGENCY_URL'];

    if (!agencyUrl || agencyUrl.trim() === '') {
      return {
        status: 'skip',
        message:
          'Agency MCP check skipped — AGENCY_URL not set (only needed for network mode)',
      };
    }

    const healthUrl = `${agencyUrl.replace(/\/+$/, '')}/health`;

    let response: Response;

    try {
      response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        return {
          status: 'fail',
          message: 'Agency MCP server request timed out',
          suggestion: `Verify the Agency MCP server is running at ${agencyUrl} and responsive.`,
        };
      }

      return {
        status: 'fail',
        message: 'Failed to connect to Agency MCP server',
        suggestion: `Check that the Agency MCP server is running at ${agencyUrl}. If using Docker, ensure the container is up.`,
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    if (!response.ok) {
      return {
        status: 'fail',
        message: `Agency MCP server returned HTTP ${response.status}`,
        suggestion: `The server at ${agencyUrl} is reachable but returned an error. Check server logs for details.`,
        detail: await response.text().catch(() => ''),
      };
    }

    return {
      status: 'pass',
      message: `Agency MCP server is reachable (${agencyUrl})`,
    };
  },
};

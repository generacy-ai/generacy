/**
 * MCP server catalog interface contract for /onboard:mcp
 *
 * Defines the hardcoded recommendation map and the
 * .mcp.json output format
 */

/** An MCP server available for configuration */
export interface McpServerDefinition {
  /** Unique server identifier (e.g., "playwright", "agency") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Short description */
  description: string;
  /** Command to run the server */
  command: string;
  /** Command arguments */
  args: string[];
  /** Optional environment variables */
  env?: Record<string, string>;
  /** Stack signals from stack.yaml that trigger a recommendation */
  stackSignals: string[];
  /** Whether to always recommend regardless of stack */
  alwaysRecommend: boolean;
}

/** Entry in .mcp.json */
export interface McpJsonEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Full .mcp.json structure */
export interface McpConfig {
  mcpServers: Record<string, McpJsonEntry>;
}

/** Custom server definition from .generacy/mcp-servers.yaml */
export interface CustomMcpServer {
  name: string;
  package: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  recommend_when: string[];
  description: string;
}

/** Initial hardcoded catalog — 3 known MCP servers */
export const MCP_SERVER_CATALOG: McpServerDefinition[] = [
  {
    id: 'agency',
    name: 'Agency MCP',
    description: 'Core agency tools — plugin management, configuration, workflows',
    command: 'npx',
    args: ['@generacy-ai/agency'],
    stackSignals: [],
    alwaysRecommend: true,
  },
  {
    id: 'playwright',
    name: 'Playwright MCP',
    description: 'Browser automation for testing web applications',
    command: 'npx',
    args: ['@anthropic/mcp-playwright'],
    stackSignals: ['React', 'Next.js', 'Vue', 'Angular', 'Svelte', 'Express', 'Fastify'],
    alwaysRecommend: false,
  },
  {
    id: 'vscode',
    name: 'VS Code MCP',
    description: 'VS Code editor integration for workspace management',
    command: 'npx',
    args: ['vscode-mcp-server'],
    stackSignals: [],
    alwaysRecommend: false,
  },
];

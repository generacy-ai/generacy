/**
 * `generacy cockpit mcp` command — Commander factory. Refuses to start on
 * worker containers via `GENERACY_CLUSTER_ROLE` (Q2-A defense-in-depth).
 * On orchestrator (or missing env), builds the MCP server and connects a
 * stdio transport.
 */
import { Command } from 'commander';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpServer } from './server.js';

export interface CockpitMcpDeps {
  /** Injection seam for tests — bypass real stdio transport. */
  makeTransport?: () => unknown;
  env?: NodeJS.ProcessEnv;
  stderr?: (line: string) => void;
  exit?: (code: number) => never;
}

export function cockpitMcpCommand(deps: CockpitMcpDeps = {}): Command {
  const cmd = new Command('mcp');
  cmd
    .description(
      'Run the cockpit stdio MCP server (orchestrator container only; refuses on workers).',
    )
    .action(async () => {
      await runCockpitMcp(deps);
    });
  return cmd;
}

export async function runCockpitMcp(deps: CockpitMcpDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const exit =
    deps.exit ??
    ((code: number) => {
      process.exit(code);
    });

  if (env['GENERACY_CLUSTER_ROLE'] === 'worker') {
    stderr(
      'Error: cockpit mcp: refusing to start on a worker container ' +
        '(GENERACY_CLUSTER_ROLE=worker). Register this server user-scope in the ' +
        'orchestrator container only.',
    );
    exit(2);
    return;
  }

  const server = buildMcpServer();
  const transport = (deps.makeTransport?.() ?? new StdioServerTransport()) as InstanceType<
    typeof StdioServerTransport
  >;
  await server.connect(transport);
}

/**
 * Agent command — DEPRECATED.
 *
 * The external agent/worker model (HTTP-based registration, heartbeat, and job polling)
 * has been replaced by the internal WorkerDispatcher in @generacy-ai/orchestrator.
 * Workers are now spawned internally by the orchestrator's Fastify server.
 *
 * Use `generacy orchestrator` to start the orchestrator, which handles worker
 * dispatch automatically.
 */
import { Command } from 'commander';

/**
 * Create the (deprecated) agent command
 */
export function agentCommand(): Command {
  const command = new Command('agent');

  command
    .description('[DEPRECATED] Start an agent worker (use `generacy orchestrator` instead)')
    .action(() => {
      console.error(
        'The `generacy agent` command has been removed.\n\n' +
        'The orchestrator now manages workers internally via WorkerDispatcher.\n' +
        'Run `generacy orchestrator` to start the server, which automatically\n' +
        'dispatches work to internal Claude CLI workers.\n\n' +
        'See the @generacy-ai/orchestrator package for details.'
      );
      process.exit(1);
    });

  return command;
}

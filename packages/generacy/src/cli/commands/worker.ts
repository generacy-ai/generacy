/**
 * Worker command — DEPRECATED.
 *
 * The external worker model (HTTP-based registration, heartbeat, and job polling)
 * has been replaced by the internal WorkerDispatcher in @generacy-ai/orchestrator.
 * Workers are now spawned internally by the orchestrator's Fastify server.
 *
 * Use `generacy orchestrator` to start the orchestrator, which handles worker
 * dispatch automatically.
 */
import { Command } from 'commander';

/**
 * Create the (deprecated) worker command
 */
export function workerCommand(): Command {
  const command = new Command('worker');

  command
    .description('[DEPRECATED] Start an external worker (use `generacy orchestrator` instead)')
    .action(() => {
      console.error(
        'The `generacy worker` command has been removed.\n\n' +
        'The orchestrator now manages workers internally via WorkerDispatcher.\n' +
        'Run `generacy orchestrator` to start the server, which automatically\n' +
        'dispatches work to internal Claude CLI workers.\n\n' +
        'See the @generacy-ai/orchestrator package for details.'
      );
      process.exit(1);
    });

  return command;
}

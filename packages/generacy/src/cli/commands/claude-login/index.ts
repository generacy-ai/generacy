import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { getLogger } from '../../utils/logger.js';
import { getClusterContext } from '../../utils/cluster-context.js';
import { openUrl } from '../../utils/browser.js';
import { UrlScanner } from './url-scanner.js';

export function claudeLoginCommand(): Command {
  const command = new Command('claude-login');

  command
    .description('Authenticate Claude inside the orchestrator container')
    .action(async () => {
      const logger = getLogger();

      const context = await getClusterContext();

      logger.debug({ clusterId: context.clusterId }, 'Resolved cluster context');

      const scanner = new UrlScanner();
      scanner.pipe(process.stdout);

      // Auto-open URL when detected
      scanner.urlDetected.then((url) => {
        logger.debug({ url }, 'URL detected in claude /login output');
        openUrl(url);
      });

      const child = spawn('docker', [
        'compose',
        '--project-name', context.clusterId,
        '--project-directory', context.projectDir,
        'exec', '-it', 'orchestrator',
        'claude', '/login',
      ], {
        stdio: ['inherit', 'pipe', 'inherit'],
      });

      child.stdout!.pipe(scanner);

      const exitCode = await new Promise<number>((resolve) => {
        child.on('close', (code) => resolve(code ?? 1));
      });

      process.exit(exitCode);
    });

  return command;
}

import { Command } from 'commander';
import { execSync } from 'node:child_process';
import { getClusterContext } from '../../utils/cluster-context.js';

export function setCommand(): Command {
  const cmd = new Command('set');

  cmd
    .description('Set an app config environment variable')
    .argument('<name>', 'Environment variable name')
    .argument('<value>', 'Environment variable value')
    .option('--secret', 'Mark the value as a secret (encrypted at rest)')
    .action(async (name: string, value: string, options: { secret?: boolean }) => {
      const context = await getClusterContext();

      const body = JSON.stringify({
        name,
        value,
        secret: options.secret ?? false,
      });

      const curlCmd = [
        'docker', 'compose',
        '--project-name', context.clusterId,
        '--project-directory', context.projectDir,
        'exec', '-T', 'orchestrator',
        'curl', '-sf', '--unix-socket', '/run/generacy-control-plane/control.sock',
        '-X', 'PUT',
        '-H', "'Content-Type: application/json'",
        '-d', `'${body.replace(/'/g, "'\\''")}'`,
        'http://localhost/app-config/env',
      ];

      try {
        const result = execSync(curlCmd.join(' '), {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const parsed = JSON.parse(result);
        if (parsed.accepted) {
          const secretTag = options.secret ? ' (secret)' : '';
          console.log(`✓ Set ${name}${secretTag}`);
        } else {
          console.error(`Failed to set ${name}:`, result);
          process.exit(1);
        }
      } catch (err: unknown) {
        console.error(`Failed to set ${name}:`, (err as Error).message);
        process.exit(1);
      }
    });

  return cmd;
}

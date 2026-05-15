import { Command } from 'commander';
import { exec } from '../../utils/exec.js';
import { getLogger } from '../../utils/logger.js';
import { getClusterContext } from '../../utils/cluster-context.js';

export function showCommand(): Command {
  const cmd = new Command('show');

  cmd
    .description('Show app config manifest and current values')
    .action(async () => {
      const logger = getLogger();
      const context = await getClusterContext();

      const curlBase = [
        'docker', 'compose',
        '--project-name', context.clusterId,
        '--project-directory', context.projectDir,
        'exec', '-T', 'orchestrator',
        'curl', '-sf', '--unix-socket', '/run/generacy-control-plane/control.sock',
      ];

      // Fetch manifest
      let manifest: { appConfig: null | Record<string, unknown> } = { appConfig: null };
      try {
        const manifestRaw = exec(
          [...curlBase, 'http://localhost/app-config/manifest'].join(' '),
        );
        manifest = JSON.parse(manifestRaw);
      } catch (err) {
        logger.debug({ err }, 'Failed to fetch manifest');
      }

      // Fetch values
      let values: { env: Array<Record<string, unknown>>; files: Array<Record<string, unknown>> } = { env: [], files: [] };
      try {
        const valuesRaw = exec(
          [...curlBase, 'http://localhost/app-config/values'].join(' '),
        );
        values = JSON.parse(valuesRaw);
      } catch (err) {
        logger.debug({ err }, 'Failed to fetch values');
      }

      // Display manifest
      if (!manifest.appConfig) {
        console.log('No appConfig section in cluster.yaml\n');
      } else {
        const config = manifest.appConfig as {
          env?: Array<{ name: string; description?: string; secret?: boolean; required?: boolean }>;
          files?: Array<{ id: string; description?: string; mountPath: string; required?: boolean }>;
        };

        if (config.env && config.env.length > 0) {
          console.log('Environment Variables:');
          console.log('─'.repeat(60));
          for (const entry of config.env) {
            const valueEntry = values.env.find(v => v.name === entry.name);
            const status = valueEntry ? '✓ set' : '○ not set';
            const secretTag = entry.secret ? ' [secret]' : '';
            const requiredTag = entry.required === false ? '' : ' (required)';
            console.log(`  ${entry.name}${secretTag}${requiredTag} — ${status}`);
            if (entry.description) {
              console.log(`    ${entry.description}`);
            }
          }
          console.log();
        }

        // Show ad-hoc env vars not in manifest
        const manifestNames = new Set((config.env ?? []).map(e => e.name));
        const adHocVars = values.env.filter(v => !manifestNames.has(v.name as string));
        if (adHocVars.length > 0) {
          console.log('Ad-hoc Variables (not in manifest):');
          console.log('─'.repeat(60));
          for (const entry of adHocVars) {
            const secretTag = entry.secret ? ' [secret]' : '';
            console.log(`  ${entry.name}${secretTag} — ✓ set`);
          }
          console.log();
        }

        if (config.files && config.files.length > 0) {
          console.log('Files:');
          console.log('─'.repeat(60));
          for (const entry of config.files) {
            const fileEntry = values.files.find(f => f.id === entry.id);
            const status = fileEntry ? `✓ uploaded (${fileEntry.size} bytes)` : '○ not uploaded';
            const requiredTag = entry.required === false ? '' : ' (required)';
            console.log(`  ${entry.id}${requiredTag} → ${entry.mountPath} — ${status}`);
            if (entry.description) {
              console.log(`    ${entry.description}`);
            }
          }
          console.log();
        }
      }
    });

  return cmd;
}

import { Command } from 'commander';

interface PlaceholderDef {
  name: string;
  description: string;
  phase: string;
}

const PLACEHOLDERS: PlaceholderDef[] = [
  { name: 'launch',       description: 'Launch a new cluster',               phase: 'phase 5' },
  { name: 'up',           description: 'Start a stopped cluster',            phase: 'phase 5' },
  { name: 'stop',         description: 'Stop a running cluster',             phase: 'phase 5' },
  { name: 'down',         description: 'Stop and remove cluster containers', phase: 'phase 5' },
  { name: 'destroy',      description: 'Permanently destroy a cluster',      phase: 'phase 5' },
  { name: 'status',       description: 'Show cluster status',                phase: 'phase 5' },
  { name: 'update',       description: 'Update cluster to latest version',   phase: 'phase 7' },
  { name: 'open',         description: 'Open cluster dashboard in browser',  phase: 'phase 6' },
  { name: 'claude-login', description: 'Authenticate with Claude',           phase: 'phase 6' },
  { name: 'deploy',       description: 'Deploy to production',               phase: 'phase 10' },
  { name: 'rebuild',      description: 'Rebuild cluster from scratch',       phase: 'phase 7' },
];

export function placeholderCommands(): Command[] {
  return PLACEHOLDERS.map(({ name, description, phase }) => {
    const cmd = new Command(name);
    cmd.description(description);
    cmd.allowUnknownOption(true);
    cmd.action(() => {
      console.log(
        `"${name}" is not yet implemented in this preview — ` +
        `landing in a future v1.5 ${phase} issue.`
      );
    });
    return cmd;
  });
}

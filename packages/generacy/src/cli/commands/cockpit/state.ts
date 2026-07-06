/**
 * `generacy cockpit state <issue>` — classify one issue and print the result.
 */
import { Command } from 'commander';
import {
  classify,
  loadCockpitConfig,
  nodeChildProcessRunner,
  type CockpitState,
  type CommandRunner,
} from '@generacy-ai/cockpit';
import { getLogger } from '../../utils/logger.js';
import { parseIssueRef, type IssueRef } from './issue-ref.js';
import { createCockpitGh, type CockpitGh } from './gh-ext.js';
import { CockpitExit, isCockpitExit } from './exit.js';

export interface ClassifyStateOutput {
  /** Echo of input ref in "owner/repo#n" form. */
  issue: string;
  /** Curated tier from @generacy-ai/cockpit. */
  state: CockpitState;
  /** Label that drove the classification — "" when state is "unknown". */
  sourceLabel: string;
}

export interface StateCommandDeps {
  runner?: CommandRunner;
  gh?: CockpitGh;
  loadConfig?: typeof loadCockpitConfig;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export function stateCommand(deps: StateCommandDeps = {}): Command {
  const cmd = new Command('state');
  cmd
    .description("Classify one issue's current cockpit state and print the source label.")
    .argument('<issue>', 'Issue ref — <number>, <owner>/<repo>#<n>, or full URL.')
    .option('--json', 'Emit machine-readable JSON instead of a text line.')
    .action(async (issue: string, opts: { json?: boolean }) => {
      try {
        await runState(issue, opts, deps);
      } catch (err) {
        if (isCockpitExit(err)) {
          const stderr = deps.stderr ?? ((line) => process.stderr.write(`${line}\n`));
          stderr(err.message);
          process.exit(err.code);
        }
        throw err;
      }
    });
  return cmd;
}

export async function runState(
  issue: string,
  opts: { json?: boolean },
  deps: StateCommandDeps,
): Promise<void> {
  const log = getLogger();
  const print = deps.stdout ?? ((line) => process.stdout.write(`${line}\n`));

  const loaded = await (deps.loadConfig ?? loadCockpitConfig)({});
  for (const w of loaded.warnings) log.warn(w);

  let ref: IssueRef;
  try {
    ref = parseIssueRef(issue);
  } catch (err) {
    throw new CockpitExit(2, `Error: cockpit state: ${(err as Error).message}`);
  }

  const gh = deps.gh ?? createCockpitGh(deps.runner ?? nodeChildProcessRunner);
  let labels: string[];
  try {
    const result = await gh.fetchIssueLabels(ref.nwo, ref.number);
    labels = result.labels;
  } catch (err) {
    throw new CockpitExit(1, `Error: cockpit state: gh issue view: ${(err as Error).message}`);
  }

  const result = classify(labels);

  const payload: ClassifyStateOutput = {
    issue: `${ref.nwo}#${ref.number}`,
    state: result.state,
    sourceLabel: result.sourceLabel,
  };

  if (opts.json) {
    print(JSON.stringify(payload));
    return;
  }

  print(`${payload.issue}  ${payload.state}  ${payload.sourceLabel}`);
}


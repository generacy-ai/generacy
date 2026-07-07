/**
 * `generacy cockpit advance <issue> --gate <name>` — manually flip a gate.
 *
 * Happy-path side-effect order:
 *   1. gh issue comment   (post manual-advance marker)
 *   2. gh issue edit --add-label completed:<gate>
 *   3. gh issue edit --remove-label waiting-for:<gate>
 *
 * Idempotent (AD-6): if `completed:<gate>` is already on the issue, exits 0
 * with `already advanced …` and posts nothing.
 *
 * Refusal (AD-4): if the active `waiting-for:*` ≠ requested gate, exits 3
 * without side effects. No `--force` in v1.
 */
import { Command, Option } from 'commander';
import {
  GhCliWrapper,
  loadCockpitConfig,
  nodeChildProcessRunner,
  type CommandRunner,
  type GhWrapper,
} from '@generacy-ai/cockpit';
import { getLogger } from '../../utils/logger.js';
import { parseIssueRef, type IssueRef } from './resolver.js';
import { GATES, listGates, type GateDefinition } from './gate-vocabulary.js';
import { formatManualAdvanceComment } from './manual-advance-marker.js';
import { CockpitExit, isCockpitExit } from './exit.js';
import { resolveCockpitIdentity } from './shared/identity.js';

export interface AdvanceCommandDeps {
  runner?: CommandRunner;
  gh?: GhWrapper;
  loadConfig?: typeof loadCockpitConfig;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export interface AdvanceOptions {
  gate?: string;
  helpGates?: boolean;
}

export function advanceCommand(deps: AdvanceCommandDeps = {}): Command {
  const cmd = new Command('advance');
  cmd
    .description('Manually advance a gated issue.')
    .argument('[issue]', 'Issue ref — <number>, <owner>/<repo>#<n>, or full URL.')
    .addOption(new Option('--gate <name>', 'Gate name (e.g. "clarification", "plan-review").'))
    .addOption(new Option('--help-gates', 'Print the list of valid gate names and exit 0.'))
    .action(async (issue: string | undefined, opts: AdvanceOptions) => {
      try {
        await runAdvance(issue, opts, deps);
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

export async function runAdvance(
  issue: string | undefined,
  opts: AdvanceOptions,
  deps: AdvanceCommandDeps,
): Promise<void> {
  const log = getLogger();
  const print = deps.stdout ?? ((line) => process.stdout.write(`${line}\n`));

  if (opts.helpGates) {
    for (const name of listGates()) print(name);
    return;
  }

  if (issue == null || issue.trim() === '') {
    throw new CockpitExit(2, 'Error: cockpit advance: missing required argument <issue>');
  }
  if (opts.gate == null || opts.gate.trim() === '') {
    throw new CockpitExit(2, 'Error: cockpit advance: missing required option --gate');
  }

  const gateDef = GATES.get(opts.gate);
  if (!gateDef) {
    throw new CockpitExit(
      2,
      `Error: cockpit advance: unknown gate "${opts.gate}". Valid gates: ${listGates().join(', ')}`,
    );
  }

  const loaded = await (deps.loadConfig ?? loadCockpitConfig)({});
  for (const w of loaded.warnings) log.warn(w);

  let ref: IssueRef;
  try {
    ref = parseIssueRef(issue);
  } catch (err) {
    throw new CockpitExit(2, `Error: cockpit advance: ${(err as Error).message}`);
  }

  const gh = deps.gh ?? new GhCliWrapper(deps.runner ?? nodeChildProcessRunner);

  let labels: string[];
  try {
    labels = (await gh.fetchIssueLabels(ref.nwo, ref.number)).labels;
  } catch (err) {
    throw new CockpitExit(1, `Error: cockpit advance: gh issue view: ${(err as Error).message}`);
  }

  // Idempotency check (AD-6): if completed:<gate> is already present, no-op.
  if (labels.includes(gateDef.completedLabel)) {
    print(
      `already advanced ${ref.nwo}#${ref.number}: ${gateDef.completedLabel} is present (no-op)`,
    );
    return;
  }

  // Refusal (AD-4): the issue must currently be waiting on this gate.
  const activeWaitingLabel = labels.find((l) => l.startsWith('waiting-for:')) ?? null;
  const activeGate = activeWaitingLabel?.slice('waiting-for:'.length) ?? null;
  if (activeGate !== gateDef.name) {
    print(
      `refusing to advance gate "${gateDef.name}": active waiting gate is ` +
        `${activeGate == null ? 'none' : `"${activeGate}"`}`,
    );
    throw new CockpitExit(
      3,
      `Error: cockpit advance: gate refusal: issue ${ref.nwo}#${ref.number} is ` +
        `${activeGate == null ? 'not in any waiting gate' : `waiting on "${activeGate}"`}`,
    );
  }

  // Happy path. Resolve actor via the shared identity helper. Optional mode
  // means an unresolvable identity is cosmetic degradation — the label/gate
  // transition still happens (FR-003).
  const { login: actor } = await resolveCockpitIdentity({
    flag: undefined,
    configAssignee: loaded.config.assignee,
    gh,
    logger: log,
    verb: 'advance',
    mode: 'optional',
    env: deps.env,
  });

  const ts = (deps.now ?? (() => new Date()))().toISOString();
  const body = formatManualAdvanceComment({ gate: gateDef.name, actor, ts });

  let commentUrl: string;
  try {
    commentUrl = (await gh.postIssueComment(ref.nwo, ref.number, body)).url;
  } catch (err) {
    throw new CockpitExit(1, `Error: cockpit advance: gh issue comment: ${(err as Error).message}`);
  }

  try {
    await gh.addLabel(ref.nwo, ref.number, gateDef.completedLabel);
  } catch (err) {
    throw new CockpitExit(
      1,
      `Error: cockpit advance: gh issue edit (add ${gateDef.completedLabel}): ${(err as Error).message}`,
    );
  }

  try {
    await gh.removeLabel(ref.nwo, ref.number, gateDef.waitingLabel);
  } catch (err) {
    throw new CockpitExit(
      1,
      `Error: cockpit advance: gh issue edit (remove ${gateDef.waitingLabel}): ${(err as Error).message}`,
    );
  }

  print(
    `advanced ${ref.nwo}#${ref.number}: ${gateDef.waitingLabel} → ${gateDef.completedLabel}` +
      (commentUrl ? ` (comment: ${commentUrl})` : ''),
  );
}

export type { GateDefinition };

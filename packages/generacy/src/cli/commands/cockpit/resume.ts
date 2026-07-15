/**
 * `generacy cockpit resume <issue>` — re-arm a failed phase in place.
 *
 * Engine-owned label surgery: on an issue carrying `failed:<phase>` (with or
 * without `agent:error`), applies the additions `waiting-for:<preceding-gate>`
 * + `completed:<preceding-gate>` + `agent:paused` FIRST, then removes
 * `failed:<phase>` plus defensive `agent:error` / `phase:<phase>` /
 * `failed:<phase>-repeated` (#942 escalation sibling) when present. The
 * terminal on-issue state is byte-identical to a naturally-paused-then-completed
 * gate — the label monitor's next poll emits a resume event, and the worker's
 * `PhaseResolver.resolveFromContinue` walks the preserved
 * `completed:<earlier-phase>` chain to pick `<phase>` as the start phase.
 *
 * Side effects (in order):
 *   1. gh addLabels [waiting-for:<G>, completed:<G>, agent:paused]
 *   2. gh removeLabels [failed:<phase>, ...conditional]
 *
 * Idempotent (FR-003): no `failed:*` → no-op with single-line stdout, exit 0.
 * Refuses (FR-004) with evidence and zero mutations when the state is
 * ambiguous or non-re-armable. No `--force` in v1 (parity with `advance`).
 *
 * #942: `failed:<phase>-repeated` (repeat-identical failure escalation) is
 * treated as a sibling of `failed:<phase>` — it is NOT counted as a separate
 * primary failure for the multiple-failed refusal, and it is cleared alongside
 * its primary. Count semantics on clear are "resume, do not reset": the next
 * same-fingerprint failure re-escalates immediately.
 */
import { Command } from 'commander';
import {
  loadCockpitConfig,
  type CommandRunner,
  type GhWrapper,
} from '@generacy-ai/cockpit';
import type { WorkflowPhase } from '@generacy-ai/orchestrator';
import { getLogger } from '../../utils/logger.js';
import { resolveIssueContext, type IssueRef } from './resolver.js';
import { resolvePrecedingGate, type PrecedingGate } from './gate-vocabulary.js';
import { CockpitExit, isCockpitExit } from './exit.js';

export interface ResumeCommandDeps {
  runner?: CommandRunner;
  gh?: GhWrapper;
  loadConfig?: typeof loadCockpitConfig;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export interface ResumeOptions {
  workflow?: string;
}

const KNOWN_PHASES: readonly WorkflowPhase[] = [
  'specify',
  'clarify',
  'plan',
  'tasks',
  'implement',
  'validate',
];

function isKnownPhase(candidate: string): candidate is WorkflowPhase {
  return (KNOWN_PHASES as readonly string[]).includes(candidate);
}

type ResumeClassification =
  | { kind: 'no-op' }
  | {
      kind: 'happy-path';
      failedPhase: WorkflowPhase;
      gate: PrecedingGate;
      labelsToAdd: string[];
      labelsToRemove: string[];
    }
  | { kind: 'refuse-multiple-failed'; failedLabels: string[] }
  | { kind: 'refuse-unknown-phase'; failedLabel: string; phaseSuffix: string }
  | { kind: 'refuse-no-preceding-gate'; failedPhase: WorkflowPhase; workflowName: string }
  | {
      kind: 'refuse-conflicting-waiting';
      failedPhase: WorkflowPhase;
      conflictingLabel: string;
      expectedLabel: string;
    };

function resolveWorkflowFromLabels(labels: string[]): string {
  const workflowLabel = labels.find((l) => l.startsWith('workflow:'));
  if (workflowLabel) {
    return workflowLabel.slice('workflow:'.length);
  }
  return 'speckit-feature';
}

function classify(labels: string[], workflowOverride?: string): ResumeClassification {
  // #942: `failed:<phase>-repeated` is the repeat-identical-failure escalation
  // sibling of `failed:<phase>`. It does NOT count as a separate primary failure
  // for the "multiple-failed" refusal — it's always paired with its primary.
  const primaryFailedLabels = labels
    .filter((l) => l.startsWith('failed:') && !l.endsWith('-repeated'))
    .sort();

  if (primaryFailedLabels.length === 0) {
    return { kind: 'no-op' };
  }

  if (primaryFailedLabels.length > 1) {
    return { kind: 'refuse-multiple-failed', failedLabels: primaryFailedLabels };
  }

  const failedLabel = primaryFailedLabels[0]!;
  const phaseSuffix = failedLabel.slice('failed:'.length);
  if (!isKnownPhase(phaseSuffix)) {
    return { kind: 'refuse-unknown-phase', failedLabel, phaseSuffix };
  }
  const failedPhase = phaseSuffix;

  const workflowName = workflowOverride ?? resolveWorkflowFromLabels(labels);
  const gateResult = resolvePrecedingGate(failedPhase, workflowName);
  if (gateResult.kind === 'no-preceding-gate') {
    return { kind: 'refuse-no-preceding-gate', failedPhase, workflowName };
  }
  const gate = gateResult.gate;

  const conflictingWaiting = labels.find(
    (l) => l.startsWith('waiting-for:') && l !== gate.waitingLabel,
  );
  if (conflictingWaiting) {
    return {
      kind: 'refuse-conflicting-waiting',
      failedPhase,
      conflictingLabel: conflictingWaiting,
      expectedLabel: gate.waitingLabel,
    };
  }

  const labelsToAdd = [gate.waitingLabel, gate.completedLabel, 'agent:paused'];
  const labelsToRemove = [failedLabel];
  if (labels.includes('agent:error')) labelsToRemove.push('agent:error');
  const phaseLabel = `phase:${failedPhase}`;
  if (labels.includes(phaseLabel)) labelsToRemove.push(phaseLabel);
  // #942: clear the repeat-failure escalation label alongside failed:<phase>.
  // Best-effort — `gh label remove` no-ops when the label is absent.
  const repeatedLabel = `failed:${failedPhase}-repeated`;
  if (labels.includes(repeatedLabel)) labelsToRemove.push(repeatedLabel);

  return { kind: 'happy-path', failedPhase, gate, labelsToAdd, labelsToRemove };
}

export function resumeCommand(deps: ResumeCommandDeps = {}): Command {
  const cmd = new Command('resume');
  cmd
    .description('Re-arm a failed phase in place so the next poll re-runs it.')
    .argument('[issue]', 'Issue ref — <number>, <owner>/<repo>#<n>, or full URL.')
    .option('--workflow <name>', 'Workflow name override (defaults to the issue\'s workflow:<name> label).')
    .action(async (issue: string | undefined, opts: ResumeOptions) => {
      try {
        await runResume(issue, opts, deps);
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

export async function runResume(
  issue: string | undefined,
  opts: ResumeOptions,
  deps: ResumeCommandDeps,
): Promise<void> {
  const log = getLogger();
  const print = deps.stdout ?? ((line) => process.stdout.write(`${line}\n`));

  if (issue == null || issue.trim() === '') {
    throw new CockpitExit(2, 'Error: cockpit resume: missing required argument <issue>');
  }

  const loaded = await (deps.loadConfig ?? loadCockpitConfig)({});
  for (const w of loaded.warnings) log.warn(w);

  let ref: IssueRef;
  let gh: GhWrapper;
  try {
    const resolvedCtx = await resolveIssueContext({ issue, runner: deps.runner });
    ref = resolvedCtx.ref;
    gh = deps.gh ?? resolvedCtx.gh;
  } catch (err) {
    throw new CockpitExit(2, `Error: cockpit resume: ${(err as Error).message}`);
  }

  let labels: string[];
  try {
    labels = (await gh.fetchIssueLabels(ref.nwo, ref.number)).labels;
  } catch (err) {
    throw new CockpitExit(1, `Error: cockpit resume: gh issue view: ${(err as Error).message}`);
  }

  const decision = classify(labels, opts.workflow);

  switch (decision.kind) {
    case 'no-op':
      print(
        `issue ${ref.nwo}#${ref.number} is not in a failed state (no failed:<phase> label); nothing to re-arm`,
      );
      return;

    case 'refuse-multiple-failed':
      throw new CockpitExit(
        3,
        `Error: cockpit resume: refusing to resume: multiple failed:* labels present: [${decision.failedLabels.join(', ')}]`,
      );

    case 'refuse-unknown-phase':
      throw new CockpitExit(
        3,
        `Error: cockpit resume: refusing to resume: unknown phase "${decision.phaseSuffix}" in label "${decision.failedLabel}"`,
      );

    case 'refuse-no-preceding-gate':
      throw new CockpitExit(
        3,
        `Error: cockpit resume: refusing to resume: phase "${decision.failedPhase}" has no preceding gate; ` +
          `use \`process:${decision.workflowName}\` label to re-queue from the beginning instead`,
      );

    case 'refuse-conflicting-waiting':
      throw new CockpitExit(
        3,
        `Error: cockpit resume: refusing to resume: conflicting ${decision.conflictingLabel} already present; ` +
          `derived preceding-gate is ${decision.expectedLabel.slice('waiting-for:'.length)}`,
      );

    case 'happy-path': {
      try {
        await gh.addLabels(ref.nwo, ref.number, decision.labelsToAdd);
      } catch (err) {
        throw new CockpitExit(
          1,
          `Error: cockpit resume: gh issue edit (add ${decision.labelsToAdd.join(',')}): ${(err as Error).message}`,
        );
      }

      try {
        await gh.removeLabels(ref.nwo, ref.number, decision.labelsToRemove);
      } catch (err) {
        throw new CockpitExit(
          1,
          `Error: cockpit resume: gh issue edit (remove ${decision.labelsToRemove.join(',')}): ${(err as Error).message}`,
        );
      }

      print(
        `resumed ${ref.nwo}#${ref.number}: re-armed phase=${decision.failedPhase} ` +
          `via preceding-gate=${decision.gate.name}; ` +
          `added=[${decision.labelsToAdd.join(',')}] ` +
          `removed=[${decision.labelsToRemove.join(',')}]`,
      );
      return;
    }
  }
}

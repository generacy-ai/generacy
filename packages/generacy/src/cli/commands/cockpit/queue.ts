/**
 * `generacy cockpit queue <epic-ref> <phase>` — enqueue every eligible ref
 * listed under the matched `### <phase>` heading in the epic body.
 *
 * Pipeline:
 *   1. resolveEpic(epicRef) → matchPhaseHeading(phase).
 *   2. Per ref in the matched phase: gh issue view → classifyRow → eligible or [SKIP: …].
 *   3. Print preview; if !--yes, prompt; on confirm, assign + label best-effort.
 */
import { Command, Option } from 'commander';
import * as p from '@clack/prompts';
import {
  GhCliWrapper,
  LoudResolverError,
  loadCockpitConfig,
  nodeChildProcessRunner,
  resolveEpic,
  matchPhaseHeading,
  type CommandRunner,
  type GhWrapper,
  type IssueRef,
  type IssueStateResult,
  type ParsedPhase,
  type ResolvedEpic,
} from '@generacy-ai/cockpit';
import { getLogger } from '../../utils/logger.js';
import { resolveIssueContext } from './resolver.js';
import { CockpitExit, isCockpitExit } from './exit.js';
import { LoudIdentityError, resolveCockpitIdentity } from './shared/identity.js';
import {
  extractPlanDependencies,
  type DependencyRef,
} from './plan-dependency-extractor.js';

const DEFAULT_LABEL = 'process:speckit-feature';

const OWNER_REPO_REGEX = /^[^/]+\/[^/]+$/;
const LOGIN_REGEX = /^[A-Za-z0-9-]+$/;
// GitHub allows most characters in label names, but we validate the small
// subset the workflow ever uses to guard against typos.
const LABEL_REGEX = /^[A-Za-z0-9_:./-]{1,50}$/;

export interface QueueOptions {
  label?: string;
  repo?: string;
  assignee?: string;
  yes?: boolean;
}

export type EligibilityStatus =
  | { kind: 'eligible'; workflowLabel: string }
  | { kind: 'skip'; reason: 'closed' | 'cross-repo' | 'already-labeled' | 'not-found' };

export type MutationOutcome =
  | { kind: 'ok' }
  | { kind: 'already' }
  | { kind: 'error'; reason: string };

/** Warning state observed at queue time for a plan.md-declared dependency (#864). */
export type DependencyWarningState = 'unresolved' | 'closed-unmerged';

export interface DependencyWarning {
  ref: DependencyRef;
  state: DependencyWarningState;
}

export interface QueueRow {
  ref: IssueRef;
  title: string;
  labels: string[];
  assignees: string[];
  eligibility: EligibilityStatus;
  /**
   * Present only when eligibility.kind === 'eligible', the phase heading matches
   * /implement/i, and plan.md-declared prerequisites are not yet merged (#864).
   */
  dependencyWarnings?: DependencyWarning[];
  assignResult?: MutationOutcome;
  labelResult?: MutationOutcome;
}

export interface QueueResult {
  epic: ResolvedEpic;
  phase: ParsedPhase;
  targetRepo: string;
  workflowLabel: string;
  assignee: string;
  rows: QueueRow[];
  confirmed: boolean;
  exitCode: 0 | 1 | 2;
}

/**
 * Fetches the raw `plan.md` for a given issue via the GitHub API.
 * Returns `null` when the file (or spec directory) doesn't exist yet.
 */
export type PlanFetcher = (ref: IssueRef) => Promise<string | null>;

export interface QueueCommandDeps {
  runner?: CommandRunner;
  gh?: GhWrapper;
  cockpitGh?: GhWrapper;
  loadConfig?: typeof loadCockpitConfig;
  env?: NodeJS.ProcessEnv;
  prompt?: (message: string) => Promise<boolean>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Optional plan.md fetcher — defaults to a `gh api` call via `deps.runner`. */
  fetchPlan?: PlanFetcher;
}

/**
 * Default plan.md fetcher. Uses `gh api` via the provided CommandRunner to fetch the
 * spec directory contents for an issue's feature branch and returns the decoded plan.md
 * body. Returns null when the PR (and thus the branch, and thus the spec dir) does not
 * exist yet, or when plan.md is not present.
 */
function makeDefaultPlanFetcher(
  runner: CommandRunner,
  gh: GhWrapper,
): PlanFetcher {
  return async (ref: IssueRef): Promise<string | null> => {
    let resolution;
    try {
      resolution = await gh.resolveIssueToPRRef(ref.repo, ref.number);
    } catch {
      return null;
    }
    if (resolution.kind !== 'resolved') return null;
    const branch = resolution.ref.headRefName;
    const specDir = `specs/${branch}/plan.md`;
    const apiPath = `repos/${ref.repo}/contents/${encodeURIComponent(specDir).replace(/%2F/g, '/')}?ref=${encodeURIComponent(branch)}`;
    const result = await runner('gh', ['api', apiPath, '--jq', '.content']);
    if (result.exitCode !== 0) return null;
    // gh returns base64 content (from GitHub API `.content` field) with newlines.
    const b64 = result.stdout.trim().replace(/\n/g, '');
    if (!b64) return null;
    try {
      return Buffer.from(b64, 'base64').toString('utf-8');
    } catch {
      return null;
    }
  };
}

/**
 * Classify a dependency's state at queue time. Returns null when the dep is fine
 * (merged or already closed with an associated merged PR).
 */
async function classifyDependency(
  dep: DependencyRef,
  gh: GhWrapper,
): Promise<DependencyWarningState | null> {
  const nwo = `${dep.owner}/${dep.repo}`;
  let resolution;
  try {
    resolution = await gh.resolveIssueToPRRef(nwo, dep.number);
  } catch {
    return 'unresolved';
  }
  // Resolver returns only OPEN, non-draft PRs, so a resolved/ambiguous/pr-is-draft
  // result means the dep is still in flight. MERGED/CLOSED PRs are surfaced via
  // the issue's stateReason below.
  if (resolution.kind !== 'unresolved') {
    return 'unresolved';
  }
  // No open PR linked — fall back to the issue's state. `stateReason` disambiguates
  // merged deps (COMPLETED — no warning) from truly closed-unmerged ones.
  let issueState: IssueStateResult | null = null;
  try {
    issueState = await gh.fetchIssueState(nwo, dep.number);
  } catch {
    return 'unresolved';
  }
  if (issueState == null) return 'unresolved';
  if (issueState.state === 'CLOSED') {
    return issueState.stateReason === 'COMPLETED' ? null : 'closed-unmerged';
  }
  return 'unresolved';
}

async function annotateRowsWithDependencyWarnings(
  rows: QueueRow[],
  fetchPlan: PlanFetcher,
  gh: GhWrapper,
): Promise<void> {
  for (const row of rows) {
    if (row.eligibility.kind !== 'eligible') continue;
    let planMd: string | null;
    try {
      planMd = await fetchPlan(row.ref);
    } catch {
      continue; // treat any fetch error as "no plan.md — skip"
    }
    if (planMd == null) continue;

    // IssueRef.repo is the full owner/repo string; split for the extractor's defaults.
    const [defaultOwner = '', defaultRepo = ''] = row.ref.repo.split('/');
    const deps = extractPlanDependencies(planMd, defaultOwner, defaultRepo);
    const warnings: DependencyWarning[] = [];
    for (const dep of deps) {
      const state = await classifyDependency(dep, gh);
      if (state != null) warnings.push({ ref: dep, state });
    }
    if (warnings.length > 0) {
      row.dependencyWarnings = warnings;
    }
  }
}

function classifyRow(
  ref: IssueRef,
  targetRepo: string,
  workflowLabel: string,
  viewResult: IssueStateResult | null,
): EligibilityStatus {
  if (ref.repo !== targetRepo) return { kind: 'skip', reason: 'cross-repo' };
  if (viewResult == null) return { kind: 'skip', reason: 'not-found' };
  if (viewResult.state === 'CLOSED') return { kind: 'skip', reason: 'closed' };
  if (viewResult.labels.includes(workflowLabel)) {
    return { kind: 'skip', reason: 'already-labeled' };
  }
  return { kind: 'eligible', workflowLabel };
}

function sortRows(rows: QueueRow[]): { eligible: QueueRow[]; skipped: QueueRow[] } {
  const eligible: QueueRow[] = [];
  const skipped: QueueRow[] = [];
  for (const r of rows) {
    if (r.eligibility.kind === 'eligible') eligible.push(r);
    else skipped.push(r);
  }
  const byRepoThenNumber = (a: QueueRow, b: QueueRow) =>
    a.ref.repo === b.ref.repo ? a.ref.number - b.ref.number : a.ref.repo.localeCompare(b.ref.repo);
  eligible.sort(byRepoThenNumber);
  skipped.sort(byRepoThenNumber);
  return { eligible, skipped };
}

export function renderPreview(
  epic: ResolvedEpic,
  phase: ParsedPhase,
  targetRepo: string,
  workflowLabel: string,
  assignee: string,
  rows: QueueRow[],
): string[] {
  const { eligible, skipped } = sortRows(rows);
  const lines: string[] = [];
  lines.push(
    `cockpit queue: epic ${epic.epic.repo}#${epic.epic.number} / phase '${phase.heading}' → ` +
      `${eligible.length} eligible, ${skipped.length} skipped in ${targetRepo}`,
  );
  for (const row of eligible) {
    if (row.eligibility.kind !== 'eligible') continue;
    lines.push(
      `  ${row.ref.repo}#${row.ref.number}  ${row.title} ` +
        `(${row.eligibility.workflowLabel}, assignee: ${assignee})`,
    );
    if (row.dependencyWarnings) {
      for (const warning of row.dependencyWarnings) {
        const depRef = `${warning.ref.owner}/${warning.ref.repo}#${warning.ref.number}`;
        lines.push(`    [WARN: depends-on ${depRef} not yet merged]`);
      }
    }
  }
  for (const row of skipped) {
    if (row.eligibility.kind !== 'skip') continue;
    const tag = `[SKIP: ${row.eligibility.reason}]`;
    const title = row.title ? `  ${row.title}` : '';
    lines.push(`  ${tag}  ${row.ref.repo}#${row.ref.number}${title}`);
  }
  return lines;
}

function mutationField(o: MutationOutcome | undefined): string {
  if (o == null) return 'skipped';
  if (o.kind === 'ok') return 'ok';
  if (o.kind === 'already') return 'already';
  return `error: ${o.reason}`;
}

export function renderSummary(rows: QueueRow[]): string[] {
  const { eligible } = sortRows(rows);
  const lines: string[] = [];
  for (const row of eligible) {
    const assignField = mutationField(row.assignResult);
    const labelField = mutationField(row.labelResult);
    const isErr =
      row.assignResult?.kind === 'error' || row.labelResult?.kind === 'error';
    const prefix = isErr ? 'FAILED' : 'Queued';
    lines.push(
      `${prefix} ${row.ref.repo}#${row.ref.number}  assignee=${assignField}  label=${labelField}`,
    );
  }
  return lines;
}

async function defaultPrompt(message: string): Promise<boolean> {
  const answer = await p.confirm({ message });
  if (p.isCancel(answer)) return false;
  return Boolean(answer);
}

function pickTargetRepo(
  refs: IssueRef[],
  repoFlag: string | undefined,
): string | { kind: 'multi-repo-no-flag'; repos: string[] } | { kind: 'flag-not-in-repos'; repos: string[] } {
  const seen = new Set<string>();
  for (const r of refs) seen.add(r.repo);
  const repos = [...seen].sort();
  if (repoFlag != null) {
    if (!repos.includes(repoFlag)) return { kind: 'flag-not-in-repos', repos };
    return repoFlag;
  }
  if (repos.length === 1) return repos[0]!;
  return { kind: 'multi-repo-no-flag', repos };
}

export async function runQueue(
  epicRef: string | undefined,
  phaseArg: string | undefined,
  opts: QueueOptions,
  deps: QueueCommandDeps,
): Promise<QueueResult> {
  const print = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));

  if (epicRef == null || epicRef.trim() === '') {
    throw new CockpitExit(2, 'Error: cockpit queue: missing required argument <epic-ref>');
  }
  if (phaseArg == null || phaseArg.trim() === '') {
    throw new CockpitExit(2, 'Error: cockpit queue: missing required argument <phase>');
  }
  const workflowLabel = opts.label ?? DEFAULT_LABEL;
  if (!LABEL_REGEX.test(workflowLabel)) {
    throw new CockpitExit(
      2,
      `Error: cockpit queue: invalid --label "${workflowLabel}"`,
    );
  }
  if (opts.repo != null && !OWNER_REPO_REGEX.test(opts.repo)) {
    throw new CockpitExit(
      2,
      `Error: cockpit queue: invalid --repo "${opts.repo}" (expected owner/repo)`,
    );
  }
  if (opts.assignee != null && !LOGIN_REGEX.test(opts.assignee)) {
    throw new CockpitExit(
      2,
      `Error: cockpit queue: invalid --assignee "${opts.assignee}" (expected GitHub login)`,
    );
  }

  const gh = deps.gh ?? new GhCliWrapper();
  const cockpitGh = deps.cockpitGh ?? new GhCliWrapper(deps.runner ?? nodeChildProcessRunner);

  const loadedConfig = await (deps.loadConfig ?? loadCockpitConfig)({});
  const log = getLogger();
  for (const w of loadedConfig.warnings) log.warn(w);

  let expandedEpicRef: string;
  try {
    const resolvedCtx = await resolveIssueContext({ issue: epicRef, runner: deps.runner });
    expandedEpicRef = `${resolvedCtx.ref.nwo}#${resolvedCtx.ref.number}`;
  } catch (err) {
    throw new CockpitExit(
      2,
      `Error: cockpit queue: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let epic: ResolvedEpic;
  try {
    epic = await resolveEpic({ epicRef: expandedEpicRef, gh });
  } catch (err) {
    if (err instanceof LoudResolverError) {
      throw new CockpitExit(2, `Error: cockpit queue: ${err.message}`);
    }
    throw err;
  }

  let phase: ParsedPhase;
  try {
    phase = matchPhaseHeading(epic.parsed, phaseArg);
  } catch (err) {
    if (err instanceof LoudResolverError) {
      throw new CockpitExit(2, `Error: cockpit queue: ${err.message}`);
    }
    throw err;
  }

  const target = pickTargetRepo(phase.refs, opts.repo);
  if (typeof target !== 'string') {
    if (target.kind === 'multi-repo-no-flag') {
      throw new CockpitExit(
        2,
        `Error: cockpit queue: phase '${phase.heading}' spans repos [${target.repos.join(', ')}]. ` +
          'Pass --repo <owner/repo> to scope this invocation.',
      );
    }
    throw new CockpitExit(
      2,
      `Error: cockpit queue: --repo ${opts.repo} not in phase repos [${target.repos.join(', ')}].`,
    );
  }
  const targetRepo = target;

  const rows: QueueRow[] = [];
  for (const ref of phase.refs) {
    if (ref.repo !== targetRepo) {
      rows.push({
        ref,
        title: '',
        labels: [],
        assignees: [],
        eligibility: { kind: 'skip', reason: 'cross-repo' },
      });
      continue;
    }
    let view: IssueStateResult | null;
    try {
      view = await cockpitGh.fetchIssueState(ref.repo, ref.number);
    } catch {
      view = null;
    }
    const eligibility = classifyRow(ref, targetRepo, workflowLabel, view);
    rows.push({
      ref,
      title: view?.title ?? '',
      labels: view?.labels ?? [],
      assignees: view?.assignees ?? [],
      eligibility,
    });
  }

  // Warning-only dependency check for the implement phase (#864).
  if (/implement/i.test(phase.heading)) {
    const fetchPlan =
      deps.fetchPlan ?? makeDefaultPlanFetcher(deps.runner ?? nodeChildProcessRunner, cockpitGh);
    try {
      await annotateRowsWithDependencyWarnings(rows, fetchPlan, cockpitGh);
    } catch (err) {
      log.warn(`cockpit queue: dependency warning check failed — ${String(err)}`);
    }
  }

  let assignee: string;
  try {
    const resolved = await resolveCockpitIdentity({
      flag: opts.assignee,
      configAssignee: loadedConfig.config.assignee,
      gh: cockpitGh,
      logger: log,
      verb: 'queue',
      mode: 'required',
      env: deps.env,
    });
    assignee = resolved.login;
  } catch (err) {
    if (err instanceof LoudIdentityError) {
      throw new CockpitExit(1, `Error: ${err.message}`);
    }
    throw err;
  }

  for (const line of renderPreview(epic, phase, targetRepo, workflowLabel, assignee, rows)) {
    print(line);
  }

  const eligibleCount = rows.filter((r) => r.eligibility.kind === 'eligible').length;
  if (eligibleCount === 0) {
    print('cockpit queue: no eligible issues — nothing to do.');
    return {
      epic,
      phase,
      targetRepo,
      workflowLabel,
      assignee,
      rows,
      confirmed: false,
      exitCode: 0,
    };
  }

  let confirmed = Boolean(opts.yes);
  if (!confirmed) {
    const prompt = deps.prompt ?? defaultPrompt;
    const answer = await prompt('Proceed?');
    confirmed = answer === true;
    if (!confirmed) {
      print('Cancelled. No mutations made.');
      return {
        epic,
        phase,
        targetRepo,
        workflowLabel,
        assignee,
        rows,
        confirmed: false,
        exitCode: 0,
      };
    }
  }

  const { eligible } = sortRows(rows);
  for (const row of eligible) {
    if (row.eligibility.kind !== 'eligible') continue;
    if (row.assignees.includes(assignee)) {
      row.assignResult = { kind: 'already' };
    } else {
      try {
        await cockpitGh.addAssignees(row.ref.repo, row.ref.number, [assignee]);
        row.assignResult = { kind: 'ok' };
      } catch (err) {
        row.assignResult = { kind: 'error', reason: (err as Error).message };
      }
    }
    if (row.labels.includes(row.eligibility.workflowLabel)) {
      row.labelResult = { kind: 'already' };
    } else {
      try {
        await cockpitGh.addLabel(row.ref.repo, row.ref.number, row.eligibility.workflowLabel);
        row.labelResult = { kind: 'ok' };
      } catch (err) {
        row.labelResult = { kind: 'error', reason: (err as Error).message };
      }
    }
  }

  for (const line of renderSummary(rows)) print(line);

  const anyError = rows.some(
    (r) =>
      r.eligibility.kind === 'eligible' &&
      (r.assignResult?.kind === 'error' || r.labelResult?.kind === 'error'),
  );

  return {
    epic,
    phase,
    targetRepo,
    workflowLabel,
    assignee,
    rows,
    confirmed: true,
    exitCode: anyError ? 1 : 0,
  };
}

export function queueCommand(deps: QueueCommandDeps = {}): Command {
  const cmd = new Command('queue');
  cmd
    .description('Queue every eligible ref under a phase heading to the cluster pipeline.')
    .argument('<epic-ref>', 'Epic ref (owner/repo#N).')
    .argument('<phase>', 'Phase token — matched case-insensitively against the first token of a ### heading.')
    .addOption(new Option('--label <name>', `Workflow label (default: ${DEFAULT_LABEL}).`))
    .addOption(new Option('--repo <owner/repo>', 'Restrict the invocation to a single repo.'))
    .addOption(new Option('--assignee <login>', 'Override the default cluster-account assignee.'))
    .addOption(new Option('--yes', 'Skip the interactive confirmation prompt.'))
    .action(async (epicRef: string, phaseArg: string, opts: QueueOptions) => {
      try {
        const result = await runQueue(epicRef, phaseArg, opts, deps);
        process.exit(result.exitCode);
      } catch (err) {
        if (isCockpitExit(err)) {
          const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
          stderr(err.message);
          process.exit(err.code);
        }
        throw err;
      }
    });
  return cmd;
}

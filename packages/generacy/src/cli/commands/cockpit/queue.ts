/**
 * `generacy cockpit queue <phase>` — assign every eligible issue in a phase
 * to the cluster account and apply its derived workflow label, confirm-gated.
 *
 * Pipeline:
 *   1. Glob `.generacy/epics/*.yaml`, readManifest each.
 *   2. resolvePhase(manifests, phaseArg) — match by tier OR name.
 *   3. groupAndPickTargetRepo(issueRefs, --repo) — single repo per invocation.
 *   4. Per ref: gh issue view → classifyRow → eligible or [SKIP: …].
 *   5. Print preview; if !--yes, prompt; on confirm, assign + label best-effort.
 *
 * See data-model.md and contracts/queue.md for the full contract.
 */
import { Command, Option } from 'commander';
import * as p from '@clack/prompts';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  loadCockpitConfig,
  nodeChildProcessRunner,
  readManifest,
  type CommandRunner,
  type EpicManifest,
  type PhaseEntry,
} from '@generacy-ai/cockpit';
import { createCockpitGh, type CockpitGh, type IssueStateResult } from './gh-ext.js';
import { CockpitExit, isCockpitExit } from './exit.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface QueueOptions {
  repo?: string;
  assignee?: string;
  yes?: boolean;
}

export interface ResolvedPhase {
  name: string;
  tier: string | undefined;
  issueRefs: string[];
  manifestPath: string;
}

export type ResolvePhaseError =
  | { kind: 'not-found'; phaseArg: string }
  | {
      kind: 'ambiguous';
      phaseArg: string;
      matches: Array<{ manifestPath: string; name: string; tier: string | undefined }>;
    };

export interface ParsedIssueRef {
  repo: string;
  number: number;
}

export type EligibilityStatus =
  | { kind: 'eligible'; workflowLabel: 'process:speckit-feature' | 'process:speckit-bugfix' }
  | { kind: 'skip'; reason: 'closed' | 'cross-repo' | 'no-phase' | 'not-found' };

export type MutationOutcome =
  | { kind: 'ok' }
  | { kind: 'already' }
  | { kind: 'error'; reason: string };

export interface QueueRow {
  ref: ParsedIssueRef;
  title: string;
  labels: string[];
  assignees: string[];
  eligibility: EligibilityStatus;
  assignResult?: MutationOutcome;
  labelResult?: MutationOutcome;
}

export interface QueueResult {
  resolvedPhase: ResolvedPhase;
  targetRepo: string;
  assignee: string;
  rows: QueueRow[];
  confirmed: boolean;
  exitCode: 0 | 1 | 2;
}

export interface QueueCommandDeps {
  runner?: CommandRunner;
  gh?: CockpitGh;
  loadConfig?: typeof loadCockpitConfig;
  prompt?: (message: string) => Promise<boolean>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  manifestRoot?: string;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────

const ISSUE_REF_REGEX = /^([^/]+\/[^/]+)#(\d+)$/;
const OWNER_REPO_REGEX = /^[^/]+\/[^/]+$/;
const LOGIN_REGEX = /^[A-Za-z0-9-]+$/;

export function parseRef(s: string): ParsedIssueRef {
  const m = ISSUE_REF_REGEX.exec(s);
  if (!m) throw new Error(`invalid issue ref: ${s} (expected owner/repo#n)`);
  return { repo: m[1]!, number: Number(m[2]!) };
}

interface ManifestEntry {
  path: string;
  manifest: EpicManifest;
}

export function resolvePhase(
  manifests: ManifestEntry[],
  phaseArg: string,
): ResolvedPhase | ResolvePhaseError {
  const matches: Array<{ manifestPath: string; phase: PhaseEntry }> = [];
  for (const entry of manifests) {
    for (const phase of entry.manifest.phases) {
      if (phase.tier === phaseArg || phase.name === phaseArg) {
        matches.push({ manifestPath: entry.path, phase });
      }
    }
  }
  if (matches.length === 0) return { kind: 'not-found', phaseArg };
  if (matches.length > 1) {
    return {
      kind: 'ambiguous',
      phaseArg,
      matches: matches.map((m) => ({
        manifestPath: m.manifestPath,
        name: m.phase.name,
        tier: m.phase.tier,
      })),
    };
  }
  const sole = matches[0]!;
  return {
    name: sole.phase.name,
    tier: sole.phase.tier,
    issueRefs: [...sole.phase.issues],
    manifestPath: sole.manifestPath,
  };
}

export function groupAndPickTargetRepo(
  issueRefs: string[],
  repoFlag: string | undefined,
):
  | { kind: 'ok'; targetRepo: string; repos: string[] }
  | { kind: 'multi-repo-no-flag'; repos: string[] }
  | { kind: 'flag-not-in-repos'; repoFlag: string; repos: string[] } {
  const repoSet = new Set<string>();
  for (const ref of issueRefs) {
    const parsed = parseRef(ref);
    repoSet.add(parsed.repo);
  }
  const repos = [...repoSet].sort();
  if (repoFlag != null) {
    if (!repos.includes(repoFlag)) {
      return { kind: 'flag-not-in-repos', repoFlag, repos };
    }
    return { kind: 'ok', targetRepo: repoFlag, repos };
  }
  if (repos.length === 1) return { kind: 'ok', targetRepo: repos[0]!, repos };
  return { kind: 'multi-repo-no-flag', repos };
}

export function classifyRow(
  ref: ParsedIssueRef,
  targetRepo: string,
  viewResult: IssueStateResult | null,
): EligibilityStatus {
  if (ref.repo !== targetRepo) return { kind: 'skip', reason: 'cross-repo' };
  if (viewResult == null) return { kind: 'skip', reason: 'not-found' };
  if (viewResult.state === 'CLOSED') return { kind: 'skip', reason: 'closed' };
  const workflowLabel: 'process:speckit-feature' | 'process:speckit-bugfix' =
    viewResult.labels.includes('type:bug')
      ? 'process:speckit-bugfix'
      : 'process:speckit-feature';
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
  resolvedPhase: ResolvedPhase,
  targetRepo: string,
  assignee: string,
  rows: QueueRow[],
): string[] {
  const { eligible, skipped } = sortRows(rows);
  const lines: string[] = [];
  const phaseLabel = `${resolvedPhase.name}${resolvedPhase.tier ? ` / ${resolvedPhase.tier}` : ''}`;
  lines.push(
    `cockpit queue: phase ${resolvedPhase.tier ?? resolvedPhase.name} (${phaseLabel}) → ` +
      `${eligible.length} eligible, ${skipped.length} skipped in ${targetRepo}`,
  );
  for (const row of eligible) {
    if (row.eligibility.kind !== 'eligible') continue;
    lines.push(
      `  ${row.ref.repo}#${row.ref.number}  ${row.title} ` +
        `(${row.eligibility.workflowLabel}, assignee: ${assignee})`,
    );
  }
  for (const row of skipped) {
    if (row.eligibility.kind !== 'skip') continue;
    const tag = `[SKIP: ${row.eligibility.reason}]`;
    const title = row.title ? `  ${row.title}` : '';
    lines.push(`  ${tag}  ${row.ref.repo}#${row.ref.number}${title}`);
  }
  return lines;
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

function mutationField(o: MutationOutcome | undefined): string {
  if (o == null) return 'skipped';
  if (o.kind === 'ok') return 'ok';
  if (o.kind === 'already') return 'already';
  return `error: ${o.reason}`;
}

// ─── Orchestration ────────────────────────────────────────────────────────

async function defaultPrompt(message: string): Promise<boolean> {
  const answer = await p.confirm({ message });
  if (p.isCancel(answer)) return false;
  return Boolean(answer);
}

async function listManifestPaths(manifestRoot: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(manifestRoot);
  } catch {
    return [];
  }
  return entries.filter((e) => e.endsWith('.yaml')).sort().map((e) => join(manifestRoot, e));
}

export async function runQueue(
  phaseArg: string | undefined,
  opts: QueueOptions,
  deps: QueueCommandDeps,
): Promise<QueueResult> {
  const print = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));

  // ── CLI validation ──
  if (phaseArg == null || phaseArg.trim() === '') {
    throw new CockpitExit(2, 'Error: cockpit queue: missing required argument <phase>');
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

  // ── Config + manifests ──
  await (deps.loadConfig ?? loadCockpitConfig)({});

  const manifestRoot = deps.manifestRoot ?? join(process.cwd(), '.generacy', 'epics');
  const manifestPaths = await listManifestPaths(manifestRoot);
  if (manifestPaths.length === 0) {
    throw new CockpitExit(
      2,
      "Error: cockpit queue: no .generacy/epics directory found. " +
        "Run 'generacy cockpit manifest init' first.",
    );
  }

  const manifests: ManifestEntry[] = [];
  for (const path of manifestPaths) {
    const manifest = await readManifest(path);
    if (manifest != null) manifests.push({ path, manifest });
  }

  // ── Phase resolution ──
  const resolved = resolvePhase(manifests, phaseArg);
  if ('kind' in resolved) {
    if (resolved.kind === 'not-found') {
      throw new CockpitExit(
        2,
        `Error: cockpit queue: phase "${phaseArg}" not found in any manifest under ` +
          ".generacy/epics/. Run 'generacy cockpit manifest init' first.",
      );
    }
    const list = resolved.matches.map((m) => m.manifestPath).join(', ');
    throw new CockpitExit(
      2,
      `Error: cockpit queue: phase "${phaseArg}" matches multiple manifests: ${list}. ` +
        'Disambiguate by running the verb from a more specific cwd.',
    );
  }
  const resolvedPhase: ResolvedPhase = resolved;

  // ── Group + pick target repo ──
  const grouping = groupAndPickTargetRepo(resolvedPhase.issueRefs, opts.repo);
  if (grouping.kind === 'multi-repo-no-flag') {
    throw new CockpitExit(
      2,
      `Error: cockpit queue: phase "${phaseArg}" spans repos [${grouping.repos.join(', ')}]. ` +
        'Pass --repo <owner/repo> to scope this invocation.',
    );
  }
  if (grouping.kind === 'flag-not-in-repos') {
    throw new CockpitExit(
      2,
      `Error: cockpit queue: phase "${phaseArg}" has no issues in ${grouping.repoFlag}. ` +
        `Phase repos: [${grouping.repos.join(', ')}].`,
    );
  }
  const targetRepo = grouping.targetRepo;

  // ── gh adapter + per-ref state fetch ──
  const gh = deps.gh ?? createCockpitGh(deps.runner ?? nodeChildProcessRunner);

  const rows: QueueRow[] = [];
  for (const refStr of resolvedPhase.issueRefs) {
    const ref = parseRef(refStr);
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
      view = await gh.fetchIssueState(ref.repo, ref.number);
    } catch {
      view = null;
    }
    const eligibility = classifyRow(ref, targetRepo, view);
    rows.push({
      ref,
      title: view?.title ?? '',
      labels: view?.labels ?? [],
      assignees: view?.assignees ?? [],
      eligibility,
    });
  }

  // ── Resolve assignee ──
  let assignee: string;
  if (opts.assignee != null) {
    assignee = opts.assignee;
  } else {
    try {
      assignee = await gh.getCurrentUser();
    } catch (err) {
      throw new CockpitExit(
        1,
        `Error: cockpit queue: gh api user: ${(err as Error).message}`,
      );
    }
  }

  // ── Preview ──
  for (const line of renderPreview(resolvedPhase, targetRepo, assignee, rows)) print(line);

  const eligibleCount = rows.filter((r) => r.eligibility.kind === 'eligible').length;

  if (eligibleCount === 0) {
    print('cockpit queue: no eligible issues — nothing to do.');
    return {
      resolvedPhase,
      targetRepo,
      assignee,
      rows,
      confirmed: false,
      exitCode: 0,
    };
  }

  // ── Confirm gate ──
  let confirmed = Boolean(opts.yes);
  if (!confirmed) {
    const prompt = deps.prompt ?? defaultPrompt;
    const answer = await prompt('Proceed?');
    confirmed = answer === true;
    if (!confirmed) {
      print('Cancelled. No mutations made.');
      return {
        resolvedPhase,
        targetRepo,
        assignee,
        rows,
        confirmed: false,
        exitCode: 0,
      };
    }
  }

  // ── Mutation loop (serial, best-effort) ──
  const { eligible } = sortRows(rows);
  for (const row of eligible) {
    if (row.eligibility.kind !== 'eligible') continue;
    if (row.assignees.includes(assignee)) {
      row.assignResult = { kind: 'already' };
    } else {
      try {
        await gh.addAssignees(row.ref.repo, row.ref.number, [assignee]);
        row.assignResult = { kind: 'ok' };
      } catch (err) {
        row.assignResult = { kind: 'error', reason: (err as Error).message };
      }
    }
    if (row.labels.includes(row.eligibility.workflowLabel)) {
      row.labelResult = { kind: 'already' };
    } else {
      try {
        await gh.addLabel(row.ref.repo, row.ref.number, row.eligibility.workflowLabel);
        row.labelResult = { kind: 'ok' };
      } catch (err) {
        row.labelResult = { kind: 'error', reason: (err as Error).message };
      }
    }
  }

  // ── Summary + exit code ──
  for (const line of renderSummary(rows)) print(line);

  const anyError = rows.some(
    (r) =>
      r.eligibility.kind === 'eligible' &&
      (r.assignResult?.kind === 'error' || r.labelResult?.kind === 'error'),
  );

  return {
    resolvedPhase,
    targetRepo,
    assignee,
    rows,
    confirmed: true,
    exitCode: anyError ? 1 : 0,
  };
}

export function queueCommand(deps: QueueCommandDeps = {}): Command {
  const cmd = new Command('queue');
  cmd
    .description('Queue every eligible issue in a phase to the cluster pipeline.')
    .argument('[phase]', 'Phase identifier — matches phase.tier (e.g. P3) or phase.name.')
    .addOption(new Option('--repo <owner/repo>', 'Restrict the invocation to a single repo.'))
    .addOption(new Option('--assignee <login>', 'Override the default cluster-account assignee.'))
    .addOption(new Option('--yes', 'Skip the interactive confirmation prompt.'))
    .action(async (phaseArg: string | undefined, opts: QueueOptions) => {
      try {
        const result = await runQueue(phaseArg, opts, deps);
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

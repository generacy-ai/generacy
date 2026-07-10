/**
 * `generacy cockpit context <issue>` — classify the issue's current
 * `waiting-for:*` gate and emit the bundle that gate needs. Single JSON line
 * on stdout.
 *
 * Gates and bundle shapes are defined in
 * `specs/807-epic-generacy-ai-tetrad/contracts/*.schema.json`.
 *
 * Exit codes (per FR-004):
 *   0 — bundle emitted
 *   1 — gh IO failure
 *   2 — ref-parse failure (bare number without inferrable origin, etc.)
 *   3 — gate refusal (no waiting-for:*, completed:validate, unsupported gate,
 *       PR-scoped gate with no resolvable PR)
 */
import { Command } from 'commander';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  WAITING_PIPELINE_ORDER,
  nodeChildProcessRunner,
  type CommandRunner,
  type GhWrapper,
} from '@generacy-ai/cockpit';
import { resolveIssueContext, type IssueRef } from './resolver.js';
import { findClarificationComment } from './clarification-comment-finder.js';
import { buildReviewContextPayload } from './shared/review-context-json.js';
import { CockpitExit, isCockpitExit } from './exit.js';

type ArtifactPathsGate =
  | 'waiting-for:spec-review'
  | 'waiting-for:plan-review'
  | 'waiting-for:tasks-review';

export interface ArtifactOutput {
  path: string;
  body: string;
}

export interface ClarificationCommentOutput {
  body: string;
  author: string;
  createdAt: string;
  url: string;
}

export interface CodeReferencesOutput {
  prUrl: string;
  touchedFiles: string[];
  diffPatch: string;
}

export interface ClarificationBundle {
  issue: string;
  gate: 'waiting-for:clarification';
  clarificationComment: ClarificationCommentOutput | null;
  spec: ArtifactOutput | null;
  plan: ArtifactOutput | null;
  codeReferences: CodeReferencesOutput | null;
}

export interface ImplementationReviewBundle {
  issue: string;
  gate: 'waiting-for:implementation-review';
  pr: {
    number: number;
    title: string;
    url: string;
    base: string;
    head: string;
    body: string;
    author: string | null;
    state: 'OPEN' | 'CLOSED' | 'MERGED';
    draft: boolean;
  };
  diff: string;
  diffTruncated: boolean;
  checks: Array<{
    name: string;
    state: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NEUTRAL' | 'SKIPPED' | 'CANCELLED';
    conclusion?: string;
    url?: string;
  }>;
}

export interface ArtifactPathsBundle {
  issue: string;
  gate: ArtifactPathsGate;
  artifacts: {
    spec: ArtifactOutput | null;
    plan: ArtifactOutput | null;
    tasks: ArtifactOutput | null;
  };
}

export type ContextBundle =
  | ClarificationBundle
  | ImplementationReviewBundle
  | ArtifactPathsBundle;

export interface ContextCommandDeps {
  runner?: CommandRunner;
  gh?: GhWrapper;
  /** Override `git branch --show-current`. */
  getBranch?: () => Promise<string>;
  /** Repo root for `specs/<branch>/…` lookup; defaults to `process.cwd()`. */
  cwd?: string;
  /** Base branch for the `git diff` fallback; defaults to `develop`. */
  baseBranch?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

const CLARIFICATION_GATE = 'waiting-for:clarification';
const IMPLEMENTATION_REVIEW_GATE = 'waiting-for:implementation-review';
const ARTIFACT_PATH_GATES: readonly ArtifactPathsGate[] = [
  'waiting-for:spec-review',
  'waiting-for:plan-review',
  'waiting-for:tasks-review',
];
const COMPLETED_VALIDATE = 'completed:validate';

export function contextCommand(deps: ContextCommandDeps = {}): Command {
  const cmd = new Command('context');
  cmd
    .description(
      'Classify the issue gate and emit the bundle that gate needs (single JSON line on stdout).',
    )
    .argument('<issue>', 'Issue ref — <owner>/<repo>#<n> or full URL.')
    .action(async (issue: string) => {
      try {
        await runContext(issue, deps);
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

export async function runContext(
  issueArg: string,
  deps: ContextCommandDeps = {},
): Promise<ContextBundle> {
  const print = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const runner = deps.runner ?? nodeChildProcessRunner;

  let ref: IssueRef;
  let gh: GhWrapper;
  try {
    const resolvedCtx = await resolveIssueContext({ issue: issueArg, runner: deps.runner });
    ref = resolvedCtx.ref;
    gh = deps.gh ?? resolvedCtx.gh;
  } catch (err) {
    throw new CockpitExit(2, `Error: cockpit context: ${(err as Error).message}`);
  }

  let labels: string[];
  try {
    labels = (await gh.fetchIssueLabels(ref.nwo, ref.number)).labels;
  } catch (err) {
    throw new CockpitExit(
      1,
      `Error: cockpit context: gh issue view: ${(err as Error).message}`,
    );
  }

  if (labels.includes(COMPLETED_VALIDATE)) {
    throw new CockpitExit(
      3,
      `Error: cockpit context: gate refusal: issue ${ref.nwo}#${ref.number} carries ` +
        `completed:validate — use \`cockpit merge\``,
    );
  }

  const gate = firstWaitingGate(labels);
  if (gate == null) {
    throw new CockpitExit(
      3,
      `Error: cockpit context: gate refusal: no waiting-for:* label on ${ref.nwo}#${ref.number} ` +
        `(labels: ${labels.length === 0 ? '<none>' : labels.join(', ')})`,
    );
  }

  const issueRepr = `${ref.nwo}#${ref.number}`;
  let bundle: ContextBundle;
  if (gate === CLARIFICATION_GATE) {
    bundle = await buildClarificationBundle(ref, issueRepr, gh, runner, deps);
  } else if (gate === IMPLEMENTATION_REVIEW_GATE) {
    bundle = await buildImplementationReviewBundle(ref, issueRepr, gh);
  } else if ((ARTIFACT_PATH_GATES as readonly string[]).includes(gate)) {
    bundle = await buildArtifactPathsBundle(ref, issueRepr, gate as ArtifactPathsGate, deps);
  } else {
    throw new CockpitExit(
      3,
      `Error: cockpit context: gate refusal: unsupported gate "${gate}" on ${issueRepr}`,
    );
  }

  print(JSON.stringify(bundle));
  return bundle;
}

function firstWaitingGate(labels: string[]): string | null {
  for (const listed of WAITING_PIPELINE_ORDER) {
    if (labels.includes(listed)) return listed;
  }
  for (const label of labels) {
    if (label.startsWith('waiting-for:')) return label;
  }
  return null;
}

async function buildClarificationBundle(
  ref: IssueRef,
  issueRepr: string,
  gh: GhWrapper,
  runner: CommandRunner,
  deps: ContextCommandDeps,
): Promise<ClarificationBundle> {
  let comment;
  try {
    comment = await findClarificationComment(gh, ref.nwo, ref.number);
  } catch (err) {
    throw new CockpitExit(
      1,
      `Error: cockpit context: clarification lookup: ${(err as Error).message}`,
    );
  }

  const branch = await (deps.getBranch ?? defaultGetBranch(runner))();
  const cwd = deps.cwd ?? process.cwd();
  const { spec, plan } = await readSpecArtifacts(cwd, branch, ref.number);

  const codeReferences = await buildCodeReferences(ref.nwo, branch, deps.baseBranch ?? 'develop', gh);

  return {
    issue: issueRepr,
    gate: 'waiting-for:clarification',
    clarificationComment: comment
      ? {
          body: comment.body,
          author: comment.author,
          createdAt: comment.createdAt,
          url: comment.url,
        }
      : null,
    spec,
    plan,
    codeReferences,
  };
}

async function buildImplementationReviewBundle(
  ref: IssueRef,
  issueRepr: string,
  gh: GhWrapper,
): Promise<ImplementationReviewBundle> {
  let resolution;
  try {
    resolution = await gh.resolveIssueToPRRef(ref.nwo, ref.number);
  } catch (err) {
    throw new CockpitExit(
      1,
      `Error: cockpit context: gh pr resolve: ${(err as Error).message}`,
    );
  }
  if (resolution.kind === 'pr-is-draft') {
    const nums = resolution.candidates.map((c) => `#${c.number}`).join(', ');
    throw new CockpitExit(
      3,
      `Error: cockpit context: gate refusal: issue ${issueRepr} at ` +
        `${IMPLEMENTATION_REVIEW_GATE} but linked PR(s) are drafts ` +
        `(via ${resolution.linkMethod}): ${nums}`,
    );
  }
  if (resolution.kind === 'ambiguous') {
    const nums = resolution.candidates.map((c) => `#${c.number}`).join(', ');
    throw new CockpitExit(
      3,
      `Error: cockpit context: gate refusal: issue ${issueRepr} at ` +
        `${IMPLEMENTATION_REVIEW_GATE} but multiple PRs match ` +
        `via ${resolution.linkMethod}: ${nums}`,
    );
  }
  if (resolution.kind === 'unresolved') {
    throw new CockpitExit(
      3,
      `Error: cockpit context: gate refusal: issue ${issueRepr} at ` +
        `${IMPLEMENTATION_REVIEW_GATE} but no linked PR resolved`,
    );
  }
  const prRef = resolution.ref;

  let pr, checks;
  try {
    [pr, checks] = await Promise.all([
      gh.getPullRequestDetail(ref.nwo, prRef.number),
      gh.getPullRequestCheckRuns(ref.nwo, prRef.number),
    ]);
  } catch (err) {
    throw new CockpitExit(
      1,
      `Error: cockpit context: gh pr detail: ${(err as Error).message}`,
    );
  }

  const payload = buildReviewContextPayload({ pr, checks });
  return {
    issue: issueRepr,
    gate: 'waiting-for:implementation-review',
    pr: payload.pr,
    diff: payload.diff,
    diffTruncated: payload.diffTruncated,
    checks: payload.checks,
  };
}

async function buildArtifactPathsBundle(
  ref: IssueRef,
  issueRepr: string,
  gate: ArtifactPathsGate,
  deps: ContextCommandDeps,
): Promise<ArtifactPathsBundle> {
  const runner = deps.runner ?? nodeChildProcessRunner;
  const branch = await (deps.getBranch ?? defaultGetBranch(runner))();
  const cwd = deps.cwd ?? process.cwd();
  const specDir = await findSpecDir(cwd, branch, ref.number);
  const artifacts =
    specDir == null
      ? { spec: null, plan: null, tasks: null }
      : {
          spec: await readArtifact(join(specDir, 'spec.md')),
          plan: await readArtifact(join(specDir, 'plan.md')),
          tasks: await readArtifact(join(specDir, 'tasks.md')),
        };
  return { issue: issueRepr, gate, artifacts };
}

async function buildCodeReferences(
  repo: string,
  branch: string,
  baseBranch: string,
  gh: GhWrapper,
): Promise<CodeReferencesOutput | null> {
  if (branch === '' || branch === baseBranch) return null;
  const pr = await gh.findOpenPrForBranch(repo, branch);
  if (pr == null) return null;

  let touchedFiles: string[] = [];
  let diffPatch = '';
  try {
    touchedFiles = await gh.prDiffNames(repo, pr.number);
  } catch {
    touchedFiles = [];
  }
  try {
    diffPatch = await gh.prDiffPatch(repo, pr.number);
  } catch {
    diffPatch = '';
  }
  return { prUrl: pr.url, touchedFiles, diffPatch };
}

async function readSpecArtifacts(
  cwd: string,
  branch: string,
  issueNumber: number,
): Promise<{ spec: ArtifactOutput | null; plan: ArtifactOutput | null }> {
  const specDir = await findSpecDir(cwd, branch, issueNumber);
  if (specDir == null) return { spec: null, plan: null };
  return {
    spec: await readArtifact(join(specDir, 'spec.md')),
    plan: await readArtifact(join(specDir, 'plan.md')),
  };
}

async function findSpecDir(
  cwd: string,
  branch: string,
  issueNumber: number,
): Promise<string | null> {
  const specsRoot = resolve(cwd, 'specs');
  if (branch !== '' && existsSync(join(specsRoot, branch))) {
    return join(specsRoot, branch);
  }
  try {
    const stats = await stat(specsRoot);
    if (!stats.isDirectory()) return null;
  } catch {
    return null;
  }
  const prefix = `${issueNumber}-`;
  let entries: string[];
  try {
    entries = await readdir(specsRoot);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.startsWith(prefix)) {
      return join(specsRoot, entry);
    }
  }
  return null;
}

async function readArtifact(path: string): Promise<ArtifactOutput | null> {
  try {
    const body = await readFile(path, 'utf-8');
    return { path, body };
  } catch {
    return null;
  }
}

function defaultGetBranch(runner: CommandRunner): () => Promise<string> {
  return async () => {
    const res = await runner('git', ['branch', '--show-current']);
    if (res.exitCode !== 0) return '';
    return res.stdout.trim();
  };
}

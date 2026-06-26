/**
 * `generacy cockpit clarify-context <issue>` — gather context for an open
 * clarification request and emit a stable JSON document to stdout.
 *
 * Refuses (exit 3) if the issue is not in `waiting-for:clarification`.
 * Read-only against GitHub (AD-7).
 */
import { execFile } from 'node:child_process';
import { Command } from 'commander';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadCockpitConfig, type CommandRunner } from '@generacy-ai/cockpit';
import { getLogger } from '../../utils/logger.js';
import { parseIssueRef, type IssueRef } from './issue-ref.js';
import { createCockpitGh, type CockpitGh } from './gh-ext.js';
import { findClarificationComment } from './clarification-comment-finder.js';
import { gatherCodeReferences, type CodeReferences } from './code-references.js';
import { CockpitExit, isCockpitExit } from './exit.js';

export interface ClarificationCommentOutput {
  body: string;
  author: string;
  createdAt: string;
  url: string;
}

export interface ArtifactOutput {
  path: string;
  body: string;
}

export interface ClarifyContextOutput {
  issue: string;
  clarificationComment: ClarificationCommentOutput | null;
  spec: ArtifactOutput | null;
  plan: ArtifactOutput | null;
  codeReferences: CodeReferences | null;
}

export interface ClarifyContextDeps {
  runner?: CommandRunner;
  gh?: CockpitGh;
  loadConfig?: typeof loadCockpitConfig;
  /** Override `git branch --show-current`. */
  getBranch?: () => Promise<string>;
  /** Root of the repo for `specs/<branch>/spec.md` lookup. */
  cwd?: string;
  baseBranch?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export function clarifyContextCommand(deps: ClarifyContextDeps = {}): Command {
  const cmd = new Command('clarify-context');
  cmd
    .description('Emit JSON containing the clarification comment, spec.md, plan.md, and code references.')
    .argument('<issue>', 'Issue ref — <number>, <owner>/<repo>#<n>, or full URL.')
    .action(async (issue: string) => {
      try {
        await runClarifyContext(issue, deps);
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

export async function runClarifyContext(
  issue: string,
  deps: ClarifyContextDeps,
): Promise<ClarifyContextOutput> {
  const log = getLogger();
  const print = deps.stdout ?? ((line) => process.stdout.write(`${line}\n`));

  const loaded = await (deps.loadConfig ?? loadCockpitConfig)({});
  for (const w of loaded.warnings) log.warn(w);

  let ref: IssueRef;
  try {
    ref = parseIssueRef(issue, { config: loaded.config });
  } catch (err) {
    throw new CockpitExit(2, `Error: cockpit clarify-context: ${(err as Error).message}`);
  }

  const runner = deps.runner ?? defaultRunner();
  const gh = deps.gh ?? createCockpitGh(runner);

  let labels: string[];
  try {
    labels = (await gh.fetchIssueLabels(ref.nwo, ref.number)).labels;
  } catch (err) {
    throw new CockpitExit(
      1,
      `Error: cockpit clarify-context: gh issue view: ${(err as Error).message}`,
    );
  }

  if (!labels.includes('waiting-for:clarification')) {
    throw new CockpitExit(
      3,
      `Error: cockpit clarify-context: gate refusal: issue ${ref.nwo}#${ref.number} is not in waiting-for:clarification`,
    );
  }

  let comment;
  try {
    comment = await findClarificationComment(gh, ref.nwo, ref.number);
  } catch (err) {
    throw new CockpitExit(
      1,
      `Error: cockpit clarify-context: clarification lookup: ${(err as Error).message}`,
    );
  }

  const branch = await (deps.getBranch ?? defaultGetBranch(runner))();
  const cwd = deps.cwd ?? process.cwd();

  const { spec, plan } = await readSpecArtifacts(cwd, branch, ref.number);

  let codeReferences: CodeReferences | null;
  try {
    codeReferences = await gatherCodeReferences(
      { repo: ref.nwo, branch, baseBranch: deps.baseBranch ?? 'develop' },
      gh,
      runner,
    );
  } catch (err) {
    throw new CockpitExit(
      1,
      `Error: cockpit clarify-context: code references: ${(err as Error).message}`,
    );
  }

  const payload: ClarifyContextOutput = {
    issue: `${ref.nwo}#${ref.number}`,
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

  print(JSON.stringify(payload));
  return payload;
}

async function readSpecArtifacts(
  cwd: string,
  branch: string,
  issueNumber: number,
): Promise<{ spec: ArtifactOutput | null; plan: ArtifactOutput | null }> {
  const specsRoot = resolve(cwd, 'specs');

  // Primary: specs/<branch>/{spec,plan}.md
  let specDir: string | null = null;
  if (branch !== '' && existsSync(join(specsRoot, branch))) {
    specDir = join(specsRoot, branch);
  } else {
    // Fallback: scan specs/ for a dir starting with `<n>-`
    specDir = await scanSpecsForIssueDir(specsRoot, issueNumber);
  }

  if (specDir == null) {
    return { spec: null, plan: null };
  }

  const spec = await readArtifact(join(specDir, 'spec.md'));
  const plan = await readArtifact(join(specDir, 'plan.md'));
  return { spec, plan };
}

async function scanSpecsForIssueDir(specsRoot: string, issueNumber: number): Promise<string | null> {
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

function defaultRunner(): CommandRunner {
  return (cmd, args, opts) =>
    new Promise((resolve) => {
      execFile(
        cmd,
        args,
        {
          env: opts?.env != null ? { ...process.env, ...opts.env } : process.env,
          cwd: opts?.cwd,
          timeout: opts?.timeoutMs ?? 30_000,
          maxBuffer: 10 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const stdoutStr = typeof stdout === 'string' ? stdout : Buffer.from(stdout).toString('utf-8');
          const stderrStr = typeof stderr === 'string' ? stderr : Buffer.from(stderr).toString('utf-8');
          let exitCode = 0;
          if (error) {
            const e = error as NodeJS.ErrnoException & { code?: number | string };
            exitCode = typeof e.code === 'number' ? e.code : 1;
          }
          resolve({ stdout: stdoutStr, stderr: stderrStr, exitCode });
        },
      );
    });
}

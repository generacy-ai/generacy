/**
 * Cockpit resolver — parses issue arguments and resolves them to a live
 * `{ ref, repo, gh }` bundle:
 *
 *   - `IssueRef`               — owner/repo/number/nwo
 *   - `parseIssueRef(input)`   — pure; throws on bare number
 *   - `resolveIssueContext(x)` — parses the ref (or infers repo from git origin
 *                                for a bare number) and returns a live
 *                                `{ ref, repo, gh }` bundle.
 *
 * Errors are loud (`parse issue: <reason>`) so callers can prefix
 * `Error: cockpit <verb>: ` per cli-surface.md.
 */
import {
  GhCliWrapper,
  nodeChildProcessRunner,
  type CommandRunner,
  type GhWrapper,
} from '@generacy-ai/cockpit';

export interface IssueRef {
  /** GitHub owner login (e.g. "generacy-ai") */
  owner: string;
  /** GitHub repo name (e.g. "generacy") */
  repo: string;
  /** GitHub issue/PR number */
  number: number;
  /** "owner/repo" — convenience for gh CLI calls */
  nwo: string;
}

export interface ResolveIssueContextInput {
  /** The `<issue>` argument as typed by the caller. */
  issue: string;
  /** Optional programmatic override — never exposed as a CLI flag on `context`. */
  repo?: string;
  /** Working directory; defaults to `process.cwd()` for git-origin inference. */
  cwd?: string;
  /** Injected runner (tests only). */
  runner?: CommandRunner;
}

export interface ResolvedIssueContext {
  ref: IssueRef;
  /** Same as `ref.nwo` — retained for legacy call-site compatibility. */
  repo: string;
  gh: GhWrapper;
}

const OWNER_REPO_HASH = /^([^/\s]+)\/([^/\s#]+)#(\d+)$/;
const ISSUE_URL = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)(?:[/?#].*)?$/;
const BARE_NUMBER = /^\d+$/;

function fail(reason: string): never {
  throw new Error(`parse issue: ${reason}`);
}

function makeRef(owner: string, repo: string, number: number): IssueRef {
  if (!owner || owner.includes('/') || /\s/.test(owner)) {
    fail(`invalid owner "${owner}"`);
  }
  if (!repo || repo.includes('/') || /\s/.test(repo)) {
    fail(`invalid repo "${repo}"`);
  }
  if (!Number.isInteger(number) || number <= 0) {
    fail(`issue number must be a positive integer, got "${number}"`);
  }
  return { owner, repo, number, nwo: `${owner}/${repo}` };
}

/**
 * Pure parser. Accepts:
 *   - `owner/repo#123`
 *   - `https://github.com/owner/repo/issues/123`
 *   - `https://github.com/owner/repo/pull/123`
 *
 * Bare-number shorthand ("123") is intentionally rejected — the caller must
 * pipe it through `resolveIssueContext`, which falls back to `git remote
 * get-url origin` inference.
 */
export function parseIssueRef(input: string): IssueRef {
  const trimmed = input.trim();
  if (trimmed === '') {
    fail('issue argument is required');
  }

  const ownerRepoHash = OWNER_REPO_HASH.exec(trimmed);
  if (ownerRepoHash) {
    const [, owner, repo, num] = ownerRepoHash;
    return makeRef(owner!, repo!, Number.parseInt(num!, 10));
  }

  const url = ISSUE_URL.exec(trimmed);
  if (url) {
    const [, owner, repo, num] = url;
    return makeRef(owner!, repo!, Number.parseInt(num!, 10));
  }

  if (BARE_NUMBER.test(trimmed)) {
    fail(
      `bare issue number "${trimmed}" is not accepted — repos are not configured, ` +
        `so a bare number is ambiguous. Use <owner>/<repo>#${trimmed} or the full URL.`,
    );
  }

  fail(
    `unrecognized issue ref "${input}". ` +
      `Use <n>, <owner>/<repo>#<n>, or https://github.com/<owner>/<repo>/issues/<n>.`,
  );
}

async function inferRepoFromGitOrigin(
  runner: CommandRunner,
  cwd: string | undefined,
): Promise<string> {
  const result = await runner('git', ['remote', 'get-url', 'origin'], cwd != null ? { cwd } : {});
  if (result.exitCode !== 0) {
    fail(
      `could not infer owner/repo: 'git remote get-url origin' failed ` +
        `(exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  const url = result.stdout.trim();
  const match = /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/.exec(url);
  if (!match || !match[1] || !match[2]) {
    fail(`could not infer owner/repo from git origin URL: ${url}`);
  }
  return `${match[1]}/${match[2]}`;
}

/**
 * Resolve an issue argument to a full `{ ref, repo, gh }` bundle.
 *
 * Strategy:
 *   1. Try `parseIssueRef(input.issue)` — succeeds for `owner/repo#N` or URL.
 *   2. On bare-number rejection (only), try `input.repo` first, then fall back
 *      to `git remote get-url origin` inference. Re-parse as `<inferred>#<n>`.
 *
 * The `input.repo` override exists for programmatic callers; the `context`
 * verb intentionally does not expose it as a CLI flag (spec Q5 → A).
 */
export async function resolveIssueContext(
  input: ResolveIssueContextInput,
): Promise<ResolvedIssueContext> {
  const runner = input.runner ?? nodeChildProcessRunner;

  try {
    const ref = parseIssueRef(input.issue);
    return { ref, repo: ref.nwo, gh: new GhCliWrapper(runner) };
  } catch (err) {
    const message = (err as Error).message;
    // Only fall through for the bare-number case; other parse failures are fatal.
    if (!/bare issue number/.test(message)) throw err;
  }

  const trimmed = input.issue.trim();
  const number = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(number) || number <= 0) {
    fail(`bare issue number "${trimmed}" is not a positive integer`);
  }

  const repoNwo = input.repo ?? (await inferRepoFromGitOrigin(runner, input.cwd));
  const parts = repoNwo.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    fail(`inferred repo "${repoNwo}" is not in <owner>/<repo> form`);
  }
  const ref = makeRef(parts[0]!, parts[1]!, number);
  return { ref, repo: ref.nwo, gh: new GhCliWrapper(runner) };
}

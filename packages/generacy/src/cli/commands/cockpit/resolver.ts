/**
 * Cockpit resolver — parses issue arguments and resolves them to a live
 * `{ ref, repo, gh }` bundle:
 *
 *   - `IssueRef`               — owner/repo/number/nwo
 *   - `parseIssueRef(input)`   — @internal; strict qualified-forms parser
 *                                (owner/repo#N and URL only). Cockpit callers
 *                                MUST go through `resolveIssueContext`.
 *   - `resolveIssueContext(x)` — gates bare numbers via cwd-origin inference,
 *                                delegates qualified forms to `parseIssueRef`,
 *                                and returns a live `{ ref, repo, gh }` bundle.
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
 * @internal — cockpit callers MUST use `resolveIssueContext` instead. This
 * function is exported only for its unit tests. Enforced by ESLint
 * `no-restricted-imports` (see `.eslintrc.json`). See #850.
 *
 * Strict qualified-forms parser. Accepts:
 *   - `owner/repo#123`
 *   - `https://github.com/owner/repo/issues/123`
 *   - `https://github.com/owner/repo/pull/123`
 *
 * Bare numbers ("123") fall through to the `unrecognized issue ref` throw —
 * they are NOT a special case here. The bare-number remedy (cwd-origin
 * inference) lives in `resolveIssueContext`.
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
 *   1. Bare numbers ("123"): resolve owner/repo from `input.repo` or cwd git
 *      origin inference, then build the ref directly via `makeRef`.
 *   2. Qualified forms (`owner/repo#N`, URLs): delegate to `parseIssueRef`.
 *
 * The `input.repo` override exists for programmatic callers; the `context`
 * verb intentionally does not expose it as a CLI flag (spec Q5 → A).
 */
export async function resolveIssueContext(
  input: ResolveIssueContextInput,
): Promise<ResolvedIssueContext> {
  const runner = input.runner ?? nodeChildProcessRunner;
  const trimmed = input.issue.trim();

  if (BARE_NUMBER.test(trimmed)) {
    const number = Number.parseInt(trimmed, 10);
    let repoNwo: string;
    try {
      repoNwo = input.repo ?? (await inferRepoFromGitOrigin(runner, input.cwd));
    } catch (err) {
      const innerReason = (err as Error).message.replace(/^parse issue: /, '');
      throw new Error(
        `parse issue: bare issue number "${trimmed}" is not accepted here. ` +
          `Accepted: <owner>/<repo>#${trimmed}, a full issue URL, or a bare number inside a ` +
          `checkout with a resolvable GitHub origin. ` +
          `(cwd-origin inference failed: ${innerReason})`,
      );
    }
    const parts = repoNwo.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      fail(`inferred repo "${repoNwo}" is not in <owner>/<repo> form`);
    }
    const ref = makeRef(parts[0]!, parts[1]!, number);
    return { ref, repo: ref.nwo, gh: new GhCliWrapper(runner) };
  }

  const ref = parseIssueRef(input.issue);
  return { ref, repo: ref.nwo, gh: new GhCliWrapper(runner) };
}

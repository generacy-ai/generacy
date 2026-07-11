/**
 * Normalize `IssueRefInput` (object | string) into a resolved
 * `{ ref, gh }` bundle for the tool handlers.
 *
 * Object form is validated via `IssueRefObjectSchema`; string form is passed
 * through `resolveIssueContext` — inherits bare-number cwd-inference (#850),
 * qualified `owner/repo#N`, and URL forms.
 *
 * PR-kind gate (subsumes generacy#906): when `expects === 'issue'`, the
 * resolved number must NOT resolve to a PR. Inspected via `gh.getIssue()`'s
 * URL — a `/pull/<n>` path is a pull request. Symmetric enforcement in
 * `cockpit_merge`, which expects a PR and rejects issues.
 */
import type { CommandRunner, GhWrapper, Issue } from '@generacy-ai/cockpit';
import { resolveIssueContext, type IssueRef } from '../resolver.js';
import type { ToolErrorResult } from './errors.js';
import { IssueRefObjectSchema, type IssueRefInput } from './schemas.js';
import { GhCliWrapper } from '@generacy-ai/cockpit';

export interface NormalizedRef {
  ref: IssueRef;
  gh: GhWrapper;
}

export type NormalizeResult =
  | { ok: true; value: NormalizedRef }
  | { ok: false; error: ToolErrorResult };

export type RefKind = 'issue' | 'pr';

export interface NormalizeOptions {
  /** What the tool expects. Used to gate the PR-vs-issue kind check. */
  expects: RefKind;
  /** Optional injected wrapper — used by tests to short-circuit the kind check. */
  gh?: GhWrapper;
  runner?: CommandRunner;
}

/**
 * Detect PR vs issue from an `Issue` object. Mirrors `isPullRequest` in
 * status.ts — the `/pull/<n>` URL segment is the authoritative marker.
 */
function isPullRequest(issue: Pick<Issue, 'url' | 'labels'>): boolean {
  if (issue.url != null && /\/pull\/\d+/.test(issue.url)) return true;
  return issue.labels.includes('type:pr');
}

/** Convert an object form into a live `{ ref, gh }` bundle. */
function fromObject(input: {
  owner: string;
  repo: string;
  number: number;
}, runner: CommandRunner | undefined): NormalizedRef {
  const ref: IssueRef = {
    owner: input.owner,
    repo: input.repo,
    number: input.number,
    nwo: `${input.owner}/${input.repo}`,
  };
  const gh = runner ? new GhCliWrapper(runner) : new GhCliWrapper();
  return { ref, gh };
}

export async function normalizeIssueRef(
  input: IssueRefInput,
  options: NormalizeOptions,
): Promise<NormalizeResult> {
  let normalized: NormalizedRef;

  if (typeof input === 'string') {
    try {
      const resolved = await resolveIssueContext({
        issue: input,
        ...(options.runner != null ? { runner: options.runner } : {}),
      });
      normalized = { ref: resolved.ref, gh: options.gh ?? resolved.gh };
    } catch (err) {
      return {
        ok: false,
        error: {
          status: 'error',
          class: 'invalid-args',
          detail: err instanceof Error ? err.message : String(err),
        },
      };
    }
  } else {
    const parsed = IssueRefObjectSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          status: 'error',
          class: 'invalid-args',
          detail: parsed.error.issues.map((i) => i.message).join('; '),
        },
      };
    }
    const built = fromObject(parsed.data, options.runner);
    normalized = { ref: built.ref, gh: options.gh ?? built.gh };
  }

  const kindCheck = await classifyRefKind(normalized);
  if (kindCheck.kind === 'error') {
    return { ok: false, error: kindCheck.error };
  }

  if (options.expects === 'issue' && kindCheck.kind === 'pr') {
    return {
      ok: false,
      error: {
        status: 'error',
        class: 'wrong-kind',
        detail:
          `expected an issue, but ${normalized.ref.nwo}#${normalized.ref.number} is a pull request`,
        hint: 'pass a PR ref to `cockpit_merge`; issue tools require an issue number',
      },
    };
  }

  if (options.expects === 'pr' && kindCheck.kind === 'issue') {
    return {
      ok: false,
      error: {
        status: 'error',
        class: 'wrong-kind',
        detail:
          `expected a pull request, but ${normalized.ref.nwo}#${normalized.ref.number} is an issue`,
        hint: 'pass an issue ref to `cockpit_context`/`cockpit_advance`; `cockpit_merge` requires a PR number',
      },
    };
  }

  return { ok: true, value: normalized };
}

interface KindOk {
  kind: RefKind;
}
interface KindErr {
  kind: 'error';
  error: ToolErrorResult;
}

/** Classify a resolved ref as issue or PR via `gh.getIssue()`. */
async function classifyRefKind(normalized: NormalizedRef): Promise<KindOk | KindErr> {
  try {
    const issue = await normalized.gh.getIssue(normalized.ref.nwo, normalized.ref.number);
    return { kind: isPullRequest(issue) ? 'pr' : 'issue' };
  } catch (err) {
    return {
      kind: 'error',
      error: {
        status: 'error',
        class: 'transport',
        detail: `gh issue view: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

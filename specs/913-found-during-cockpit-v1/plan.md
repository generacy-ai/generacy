# Implementation Plan: cockpit merge — resilient tier-1 resolver against gh CLI shape drift (#913)

**Feature**: Decouple `queryTier1ClosingRefs` from gh's `--json` `closedByPullRequestsReferences[]` serializer shape drift by (a) fetching `state`/`headRefName`/`isDraft` via a single explicit `gh api graphql` selection set, (b) shipping a `--pr <number>` escape hatch on `cockpit merge <ref>` that skips resolution but keeps every safety precondition (`closingIssuesReferences` linkage + `completed:validate` + green checks), and (c) making parse-failure errors self-identify version-skew by including the gh version and up to 512 chars of the offending payload.
**Branch**: `913-found-during-cockpit-v1`
**Status**: Complete

## Summary

`generacy cockpit merge`'s tier-1 resolver hard-requires `state`, `headRefName`, and `headRefName`-adjacent fields on every `closedByPullRequestsReferences[]` entry (`packages/cockpit/src/gh/wrapper.ts:771–793`). gh 2.96.0 (2026-07-02) narrowed that serializer to `{id, number, repository, url}` for the GraphQL-backed field union, so today's zod parse fails on every invocation with `expected string, received undefined`. During tetrad-development#92's snappoll run the operator had to fall back to raw `gh pr merge` for 11 merges because no sanctioned bypass existed.

This PR ships three coupled fixes, in the exact ordering the spec's clarifications converged on:

1. **Tier-1 fetch strategy split** (FR-001 / FR-002 / FR-002a / FR-004). The initial `gh issue view --json closedByPullRequestsReferences` call is preserved but its schema is loosened to accept the 2.96.0 minimal shape (`number` required; `url` accepted as fallback per the `parseResolveIssueToPr` sibling at `wrapper.ts:478–520`). A **new second call** — a single `gh api graphql` request selecting exactly `{ number, state, headRefName, isDraft, url }` — supplies the fields the merge caller needs. Retry-once-with-1s-backoff, then hard-fail (never fall through to tier-2, never filter to a "successful subset") per clarify Q4→D and Q5→B.
2. **`--pr <number>` escape hatch** on `cockpit merge` (FR-005 / FR-006 / FR-006a / FR-006b / FR-007 / FR-008). When present, the tier-1/2/3 chain is skipped entirely. A single `gh api graphql` call selects `{ state, headRefName, isDraft, mergeStateStatus, closingIssuesReferences { nodes { number, repository { nameWithOwner } } } }` on the PR. Gate order (documented in the refusal message so operators know which gate tripped):
   1. **FR-006a linkage** — the PR's `closingIssuesReferences` must include `<ref>`; empty refs or mismatch → exit 3 with "add via Development sidebar" guidance.
   2. **FR-006b state** — `MERGED` → exit 0 idempotent no-op; `CLOSED` (unmerged) → exit 3; `OPEN` → continue.
   3. **FR-007 `completed:validate`** — checked on `<ref>` (not the PR; workflow labels are issue-scoped per #807-Q2 — the existing `runMerge` invariant at `merge.ts:32–35`).
   4. **FR-007 check-classification** — reuses `classifyChecks` from `shared/required-checks.ts` verbatim.
3. **Version-skew self-identification** (FR-009 / FR-010). Parse-failure error messages emitted by `queryTier1ClosingRefs` (both the initial-shape parse and the new graphql-follow-up parse) include the first line of `gh --version` and up to **512 chars** (Q2→B) of the offending payload. Version-capture failure degrades to `gh version: unknown` and preserves the underlying parse error.

Regression fixtures (FR-011 / FR-012 / FR-012a / FR-012b / FR-012c / FR-013) cover: (a) 2.96.0 minimal-shape resolution succeeds, (b) 2.95.x prior-shape resolution still succeeds, (c) `--pr` refuses on missing `completed:validate`, (d) `--pr` refuses on linkage mismatch/empty refs, (e) `--pr` is idempotent on MERGED and refuses CLOSED-unmerged, (f) FR-002 graphql failure retries exactly once then exits 1 without tier-2 fall-through, (g) parse-failure error text names the gh version.

## Technical Context

- **Language**: TypeScript (strict), ESM, Node ≥22
- **Packages touched**:
  - `@generacy-ai/cockpit` — `packages/cockpit/src/gh/wrapper.ts` (tier-1 rewrite, new `GhWrapper.getPullRequestGraphqlDetail` method, version-capture helper); tests under `packages/cockpit/src/gh/__tests__/`.
  - `@generacy-ai/generacy` — `packages/generacy/src/cli/commands/cockpit/merge.ts` (`--pr` flag + new `runMerge` branch); tests under `packages/generacy/src/cli/commands/cockpit/__tests__/`.
- **Runtime dependencies**: none new. `zod` (already present), `commander` (already present), no new `gh` features (graphql API is stock since 2.0).
- **Loggers, exit codes, CockpitExit**: reuses `getLogger()` and the existing `CockpitExit` class at `packages/generacy/src/cli/commands/cockpit/exit.ts`. Exit-code convention (per spec Assumptions §): 0 success, 2 arg-parse (malformed `--pr`), 3 refusal (any gate), 1 transport (parse failure / graphql failure after retry).
- **CLI surface**: `cockpit merge <issue> [--repo owner/name] [--pr <number>]`. `--pr` requires `<issue>` — it is the authorization source. Missing `--repo` still infers from cwd via the existing `resolveIssueContext` bundle.
- **GraphQL selection sets**: two, both documented in `contracts/graphql-selection-set.md`.
  - `TIER1_FOLLOWUP_QUERY(repo, issue)` — enumerates the issue's closing PRs by number and returns per-PR `{ number, state, headRefName, isDraft, url }`.
  - `PR_DETAIL_QUERY(repo, pr)` — returns `{ state, headRefName, isDraft, mergeStateStatus, closingIssuesReferences { nodes { number, repository { nameWithOwner } } } }`.
- **Interaction with existing `resolveIssueToPR`** (`wrapper.ts:697–712`): unrelated. That method (used outside merge) already tolerates the minimal shape via `parseResolveIssueToPr`. This PR touches only the *ref-shaped* variant `resolveIssueToPRRef` and its private `queryTier1ClosingRefs`. Tier-2 (`queryTier2BranchName`) and tier-3 (`queryTier3PrBody`) are untouched per spec's Out-of-Scope §.
- **Interaction with existing sibling wrapper methods**:
  - `getPullRequestDetail` / `getPullRequest` — still used by the resolver-driven path. `--pr` uses a **new** `getPullRequestGraphqlDetail` method that returns the specific selection-set fields FR-006 requires. We do NOT reuse `getPullRequestDetail` for `--pr` because it is `gh pr view --json`-backed (the exact contract class #913 is escaping) and does not carry `closingIssuesReferences`.
  - `fetchIssueState` (used by `runMerge` for `completed:validate` today) is unchanged. `--pr` reuses it verbatim for FR-007 — labels come from the issue, not the PR, per the `merge.ts:32–35` invariant.

## Project Structure

Changes localize to two packages. Six files modified, no new files in `src/` beyond the graphql-query constants (which live inline in `wrapper.ts` next to the retry helper — see rationale below). Two test files extended, one new test file added.

```
packages/cockpit/src/gh/
├── wrapper.ts                                          [MODIFY]
│   - Loosen initial-shape tier-1 zod (accept 2.96.0 minimal shape: number required, others optional)
│   - Add `queryTier1FollowupGraphql(repo, issueNumbers): Promise<Map<number, PullRequestRef>>`
│   - Rewrite `queryTier1ClosingRefs` as: parse initial → collect numbers → graphql follow-up (with retry-once) → assemble PullRequestRef[] → filter to OPEN
│   - Add `GhWrapper.getPullRequestGraphqlDetail(repo, prNumber): Promise<PullRequestGraphqlDetail>` (new method on interface + impl)
│   - Add `captureGhVersion(runner): Promise<string>` — reads first line of `gh --version`, degrades to `'unknown'` on failure
│   - Rewrap parse-failure `throw` sites in `queryTier1ClosingRefs` (initial + graphql-followup) via new `formatShapeMismatchError(rawPayload, err, ghVersion)` helper — 512-char excerpt
│   - Add `sleep(ms)` helper (module-private) — 1s backoff for FR-002a retry
└── __tests__/
    ├── wrapper.tier1-shape-drift.test.ts              [ADD]  FR-011 fixture + FR-002a retry + FR-013 version-string
    └── wrapper.pr-graphql-detail.test.ts              [ADD]  getPullRequestGraphqlDetail schema + FR-006 selection-set assertion

packages/generacy/src/cli/commands/cockpit/
├── merge.ts                                            [MODIFY]
│   - Add `--pr <number>` option (Commander), integer parser (exit 2 on non-int / non-positive)
│   - Extract `assertCompletedValidateAndMerge(...)` shared with runMerge — the precondition-check + merge tail; both the resolver-driven and --pr paths call it
│   - Add `runMergeWithExplicitPr(input)` — the FR-005..FR-008 branch:
│       1. gh.getPullRequestGraphqlDetail(repo, prNumber)
│       2. FR-006a linkage guard vs. `<ref>` → exit 3 on mismatch/empty
│       3. FR-006b state classifier → exit 0 on MERGED, exit 3 on CLOSED-unmerged
│       4. FR-007 delegate to assertCompletedValidateAndMerge
│   - Action handler routes to runMerge (no `--pr`) or runMergeWithExplicitPr (`--pr` present)
└── __tests__/
    └── merge.pr-flag.test.ts                          [ADD]  FR-012, FR-012a, FR-012b regression fixtures

specs/913-found-during-cockpit-v1/
├── spec.md                                             [read-only]
├── clarifications.md                                   [read-only]
├── plan.md                                             [THIS FILE]
├── research.md                                         [ADD]
├── data-model.md                                       [ADD]
├── quickstart.md                                       [ADD]
└── contracts/
    ├── graphql-selection-set.md                        [ADD]  Two selection-sets + retry contract
    └── pr-flag-cli.md                                  [ADD]  --pr flag semantics + gate ordering
```

**Files NOT changing:**

- `packages/cockpit/src/gh/wrapper.ts` `queryTier2BranchName` / `queryTier3PrBody` / `resolveIssueToPR` / `parseResolveIssueToPr` — untouched (Out-of-Scope §).
- `packages/generacy/src/cli/commands/cockpit/resolver.ts` — untouched. `resolveIssueContext` is the entry point for `<ref>`; `--pr` uses `ctx.gh` and `ctx.ref` unchanged.
- `packages/generacy/src/cli/commands/cockpit/shared/required-checks.ts` — `classifyChecks` is the authoritative gate for both paths (Assumptions § — "Existing checkers reused, not re-implemented").
- `packages/generacy/src/cli/commands/cockpit/shared/failing-check-json.ts` — `--pr` reuses `serializeFailingCheckJson` and `buildFailingCheckPayload` verbatim for its failure surfaces.
- All other cockpit verbs (`advance`, `queue`, `merge`'s non-`--pr` path signature, `resume`, `watch`, `status`, `context`). `merge <issue>` (no `--pr`) is behavior-preserving under the fix; only the internal fetch strategy changes.

## Code changes in detail

### `packages/cockpit/src/gh/wrapper.ts` — modifications

#### New module-private constants (near existing schemas, ~line 290)

```ts
/**
 * FR-002 — explicit GraphQL selection set for the tier-1 follow-up.
 * Fetches per-PR `state`, `headRefName`, `isDraft` in a single call regardless
 * of PR count. Chosen over `gh pr view --json ...` per clarify Q5→B: the whole
 * moral of #913 is that `--json` shape drifts under us; GraphQL selection sets
 * are versioned and deprecation-cycled.
 */
const TIER1_FOLLOWUP_QUERY = /* graphql */ `
  query CockpitTier1Followup($owner: String!, $repo: String!, $numbers: [Int!]!) {
    repository(owner: $owner, name: $repo) {
      pullRequests: pullRequests(first: 50, orderBy: {field: CREATED_AT, direction: DESC}) {
        # NB — we filter client-side by `$numbers` after fetch. The alternative
        # `pullRequest(number: $n)` per-N aliased-fields query is documented in
        # contracts/graphql-selection-set.md; we opted for the simpler bounded-
        # pagination form here because closedByPullRequestsReferences is bounded
        # by GitHub's UI to ~10 PRs per issue in practice.
        nodes { number state headRefName isDraft url }
      }
    }
  }
`;
```

Actual implementation uses the **`pullRequest(number:)` aliased-fields variant** (documented in `contracts/graphql-selection-set.md` §2 as the primary form) — the sketch above is illustrative; the real query is built dynamically in `buildTier1FollowupQuery(numbers)` to alias `pr0: pullRequest(number: N0) { … }` per requested number. This avoids the pagination surface entirely and is deterministic per input.

```ts
/** FR-006 — explicit selection set for the `--pr` PR detail fetch. */
const PR_DETAIL_QUERY = /* graphql */ `
  query CockpitPrDetail($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        state
        headRefName
        isDraft
        mergeStateStatus
        closingIssuesReferences(first: 20) {
          nodes {
            number
            repository { nameWithOwner }
          }
        }
      }
    }
  }
`;

/** FR-002a — single-shot retry backoff. Extracted as a constant for test override. */
const TIER1_RETRY_BACKOFF_MS = 1000;

/** FR-009 — payload excerpt cap per clarify Q2→B (fits 2–3 minimal-shape refs). */
const SHAPE_MISMATCH_EXCERPT_CHARS = 512;
```

#### New schemas (adjacent to existing `PullRequestRefRawSchema`, ~line 225)

```ts
/**
 * FR-004 — the 2.96.0 minimal shape. Only `number` is required; `url` is
 * accepted as a fallback path for number recovery (mirrors parseResolveIssueToPr
 * at wrapper.ts:478–520). `state`, `headRefName`, `isDraft` all `.optional()` —
 * they are supplied by the follow-up graphql call, not by this initial parse.
 */
const Tier1InitialRefSchema = z
  .object({
    number: z.number().int().optional(),
    url: z.string().optional(),
  })
  .passthrough();

const Tier1InitialResponseSchema = z
  .object({
    closedByPullRequestsReferences: z.array(Tier1InitialRefSchema).default([]),
  })
  .passthrough();

/** FR-002 — per-PR nodes returned by TIER1_FOLLOWUP_QUERY. */
const Tier1FollowupRefSchema = z.object({
  number: z.number().int(),
  state: z.string(),
  headRefName: z.string(),
  isDraft: z.boolean(),
  url: z.string(),
});

/** FR-006 — return shape of getPullRequestGraphqlDetail. */
const PrGraphqlDetailSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        state: z.string(),                         // 'OPEN' | 'CLOSED' | 'MERGED'
        headRefName: z.string(),
        isDraft: z.boolean(),
        mergeStateStatus: z.string(),
        closingIssuesReferences: z.object({
          nodes: z.array(
            z.object({
              number: z.number().int(),
              repository: z.object({ nameWithOwner: z.string() }),
            }),
          ),
        }),
      }).nullable(),
    }),
  }),
});
```

#### Version-capture helper (module-private, near `failIfNonZero`)

```ts
async function captureGhVersion(runner: CommandRunner): Promise<string> {
  try {
    const r = await runner('gh', ['--version']);
    if (r.exitCode !== 0) return 'unknown';
    // FR-010 — first line of `gh --version`, defensively trimmed.
    return (r.stdout.split('\n')[0] ?? 'unknown').trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function formatShapeMismatchError(
  siteLabel: string,      // e.g. 'resolveIssueToPRRef tier1 initial'
  rawPayload: string,
  errorMessage: string,
  ghVersion: string,
): Error {
  const excerpt = rawPayload.slice(0, SHAPE_MISMATCH_EXCERPT_CHARS);
  return new Error(
    `gh ${siteLabel} JSON shape mismatch: ${errorMessage} ` +
      `(gh version: ${ghVersion}; payload excerpt: ${excerpt})`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

`formatShapeMismatchError` is a pure function — trivially unit-testable and reused at every parse-failure site touched by FR-009.

#### `queryTier1ClosingRefs` — rewrite (replaces `wrapper.ts:748–803`)

```ts
private async queryTier1ClosingRefs(
  repo: string,
  issue: number,
): Promise<PullRequestRef[]> {
  const [owner, name] = repo.split('/');
  if (!owner || !name) {
    throw new Error(`queryTier1ClosingRefs: repo must be "owner/name", got: ${repo}`);
  }

  // (1) FR-004 — initial call: parse only what the 2.96.0 minimal shape guarantees.
  const initial = await this.runner('gh', [
    'issue', 'view', String(issue),
    '--repo', repo,
    '--json', 'closedByPullRequestsReferences',
  ]);
  failIfNonZero(initial, 'issue view (resolveIssueToPRRef tier1 initial)');

  let initialParsed: unknown;
  try { initialParsed = JSON.parse(initial.stdout); }
  catch {
    const ghVer = await captureGhVersion(this.runner);
    throw formatShapeMismatchError('resolveIssueToPRRef tier1 initial JSON.parse',
      initial.stdout, 'malformed JSON', ghVer);
  }

  const initialShape = Tier1InitialResponseSchema.safeParse(initialParsed);
  if (!initialShape.success) {
    const ghVer = await captureGhVersion(this.runner);
    throw formatShapeMismatchError('resolveIssueToPRRef tier1 initial shape',
      initial.stdout, initialShape.error.message, ghVer);
  }

  // Extract PR numbers (number-first, url-fallback per parseResolveIssueToPr pattern).
  const numbers: number[] = [];
  for (const ref of initialShape.data.closedByPullRequestsReferences) {
    if (typeof ref.number === 'number') { numbers.push(ref.number); continue; }
    const fromUrl = extractPrNumberFromUrl(ref.url);
    if (fromUrl != null) numbers.push(fromUrl);
  }

  // Fast path: no closing refs → tier-1 returns no candidates, resolver falls
  // through to tier-2 as it always has. (This is NOT the FR-002a fall-through
  // path — no follow-up call is made, no failure occurred.)
  if (numbers.length === 0) return [];

  // (2) FR-002 — follow-up graphql call with FR-002a single-shot retry.
  const perPr = await this.queryTier1FollowupGraphql(owner, name, numbers);

  // (3) FR-003 — filter to OPEN before returning refs to the merge caller.
  const refs: PullRequestRef[] = [];
  for (const n of numbers) {
    const detail = perPr.get(n);
    if (detail == null) continue;   // graphql omitted the number (deleted PR, etc.)
    if (normalizePullRequestState(detail.state) !== 'OPEN') continue;
    refs.push({
      number: detail.number,
      url: detail.url,
      state: 'OPEN',
      draft: detail.isDraft,
      headRefName: detail.headRefName,
    });
  }
  return refs;
}

private async queryTier1FollowupGraphql(
  owner: string,
  name: string,
  numbers: number[],
): Promise<Map<number, { number: number; state: string; headRefName: string; isDraft: boolean; url: string }>> {
  // FR-002a — one retry, 1s backoff, then hard-fail. Never fall through to
  // tier-2 (would risk selecting a different PR); never filter to a
  // "successful subset" (silent-wrong outcome).
  try {
    return await this.tier1FollowupOnce(owner, name, numbers);
  } catch (first) {
    await sleep(TIER1_RETRY_BACKOFF_MS);
    try {
      return await this.tier1FollowupOnce(owner, name, numbers);
    } catch (second) {
      // Bubble the *second* error; the first is discardable transient noise
      // by construction of the retry policy. Message names the site so the
      // FR-009 style is preserved end-to-end.
      throw new Error(
        `gh resolveIssueToPRRef tier1 follow-up graphql failed after 1 retry: ${
          (second as Error).message
        }`,
      );
    }
  }
}
```

`tier1FollowupOnce` — the single-attempt helper — issues the aliased-fields query, parses via `Tier1FollowupRefSchema`, wraps parse failures via `formatShapeMismatchError` (FR-009 covers the follow-up parse too). Documented shape in `contracts/graphql-selection-set.md` §2.

#### `GhWrapper` interface + `getPullRequestGraphqlDetail` impl

```ts
export interface PullRequestGraphqlDetail {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  headRefName: string;
  isDraft: boolean;
  mergeStateStatus: string;
  closingIssuesReferences: Array<{
    number: number;
    /** Full `owner/name` — for FR-006a cross-repo linkage comparison. */
    nameWithOwner: string;
  }>;
}

// Interface addition (near line 165):
getPullRequestGraphqlDetail(repo: string, prNumber: number): Promise<PullRequestGraphqlDetail>;
```

Impl — new method on `GhCliWrapper`, invokes `gh api graphql -F owner=… -F repo=… -F number=… -f query="$PR_DETAIL_QUERY"`, parses via `PrGraphqlDetailSchema`. `null` `pullRequest` returned by the API → `Error("PR #<n> not found in <owner>/<repo>")` (transport-class exit 1). See `contracts/graphql-selection-set.md` §3.

### `packages/generacy/src/cli/commands/cockpit/merge.ts` — modifications

#### `--pr` flag registration

```ts
cmd
  .description(...)
  .argument('<issue>', 'GitHub issue number')
  .option('--repo <repo>', 'Owner/name (inferred from cwd if absent)')
  .option(
    '--pr <number>',
    'Escape hatch — target this PR directly, skipping issue→PR resolution. ' +
      'Requires <issue> as the authorization source for completed:validate. ' +
      'Enforces linkage verification + all safety preconditions; never bypasses safety.',
    parsePrFlag,          // Commander parser — exit 2 on non-integer/non-positive
  )
  .action(async (issueArg, opts: { repo?: string; pr?: number }) => { … });
```

`parsePrFlag` — pure helper, unit-tested — parses to a positive integer or throws `CockpitExit(2, "merge: --pr must be a positive integer, got: <input>")`. Follows the existing exit-2 shape.

#### Action handler branches

```ts
const ctx = await resolveIssueContext({ issue: issueArg, repo: opts.repo });
const result = opts.pr != null
  ? await runMergeWithExplicitPr({ gh: ctx.gh, issue: ctx.ref.number, repo: ctx.repo, prNumber: opts.pr, logger })
  : await runMerge({ gh: ctx.gh, issue: ctx.ref.number, repo: ctx.repo, logger });
```

`runMerge`'s signature is unchanged — its internal call to `gh.resolveIssueToPRRef` still runs (the resolver internals changed under it), but the outer semantics are identical.

#### `runMergeWithExplicitPr(input)` — new function

Shape mirrors `runMerge`'s return type (`{ exitCode, stdout }`); reuses `serializeFailingCheckJson`/`buildFailingCheckPayload` for failure surfaces.

```ts
export async function runMergeWithExplicitPr(input: RunMergeWithExplicitPrInput): Promise<RunMergeResult> {
  const { gh, issue, repo, prNumber, logger } = input;
  const issueRef = parseIssueRef(repo, issue);

  const pr = await gh.getPullRequestGraphqlDetail(repo, prNumber);

  // Gate 1 — FR-006a linkage.
  const declares = pr.closingIssuesReferences.some(
    (l) => l.nameWithOwner === repo && l.number === issue,
  );
  if (!declares) {
    const kind = pr.closingIssuesReferences.length === 0 ? 'empty-refs' : 'mismatch';
    logger.error({ pr: prNumber, issue, repo, kind }, `--pr linkage refused: ${kind}`);
    return {
      exitCode: 3,          // NB — runMerge tops out at 0|1; --pr introduces 3.
      stdout: serializeFailingCheckJson(
        buildFailingCheckPayload({
          reason: 'pr-flag-linkage-refused',
          pr: { number: prNumber, url: '' /* url unknown from graphql payload; enrich below */ },
          issue: issueRef,
        }),
      ),
    };
  }

  // Gate 2 — FR-006b state classifier.
  const state = pr.state as 'OPEN' | 'CLOSED' | 'MERGED';
  if (state === 'MERGED') {
    logger.info({ pr: prNumber }, 'PR already merged, no-op');
    return { exitCode: 0, stdout: `PR #${prNumber} already merged, no-op\n` };
  }
  if (state === 'CLOSED') {
    logger.error({ pr: prNumber }, 'PR is closed without merge');
    return { exitCode: 3, stdout: /* pr-flag-closed-unmerged reason */ };
  }
  // state === 'OPEN' → continue.

  // Gates 3 & 4 — delegate to assertCompletedValidateAndMerge (shared with runMerge tail).
  return assertCompletedValidateAndMerge({ gh, issueRef, prNumber, logger });
}
```

The `assertCompletedValidateAndMerge` extraction — the second refactor of this PR — collapses the runMerge tail (lines ~217–295 today: label check, required-checks fetch, classifier, `mergePullRequest`, branch deletion) into a shared helper both paths call. The extraction is behavior-preserving for `runMerge` (a plain `runMerge` invocation is equivalent to today's code) and satisfies FR-007 for `--pr` by construction.

`RunMergeResult`'s `exitCode` type widens from `0 | 1` to `0 | 1 | 2 | 3` (or a distinct `RunMergeWithExplicitPrResult` with `0 | 1 | 3`). The Commander action handler already uses `process.exit(result.exitCode)` — no wire changes.

### Test file changes

#### `packages/cockpit/src/gh/__tests__/wrapper.tier1-shape-drift.test.ts` (new)

Sub-suites:

1. **`queryTier1ClosingRefs — gh 2.96.0 minimal-shape (FR-011, SC-001)`**
   - Mock `CommandRunner`: initial `gh issue view` returns `{closedByPullRequestsReferences:[{id:'…',number:912,repository:{…},url:'https://github.com/x/y/pull/912'}]}` (2.96.0 shape). Follow-up `gh api graphql` returns `{data:{repository:{pr0:{number:912,state:'OPEN',headRefName:'foo',isDraft:false,url:'…'}}}}`.
   - Assert `resolveIssueToPRRef(...)` → `{kind:'resolved', ref:{number:912, state:'OPEN', draft:false, headRefName:'foo', …}, linkMethod:'closing-refs'}`.
2. **`queryTier1ClosingRefs — gh 2.95.x prior-shape (SC-002)`**
   - Initial returns the pre-2.96.0 rich shape (`state`, `headRefName` inline). Follow-up graphql still runs (the schema doesn't care about the extra initial fields — the passthrough tolerates them). Assert same successful resolution.
3. **`queryTier1ClosingRefs — FR-002a retry-once-then-fail (FR-012c, SC-009)`**
   - Initial succeeds → returns 2 PR numbers. Follow-up graphql fails twice (transport-level `Error`). Assert:
     - Exactly 2 `gh api graphql` invocations against the runner spy.
     - Exactly `~1000ms` between them (jest fake timers, or a lenient tolerance).
     - Method throws (which surfaces as exit 1 in the CLI).
     - **Zero calls to `gh pr list --search` (tier-2)** — the fall-through must not happen.
4. **`queryTier1ClosingRefs — FR-009 parse-failure includes gh version (FR-013, SC-005)`**
   - Feed the initial parser malformed JSON. Mock `gh --version` runner → `gh version 2.96.0 (…)`. Assert thrown error message matches `/gh version: gh version 2\.96\.0/` and contains `payload excerpt:` with the malformed body substring.
   - Additional case: `gh --version` returns exit 1 → assert error message contains `gh version: unknown` and preserves the underlying parse-failure text (FR-010).
5. **Excerpt cap = 512 chars**
   - Feed a 10 KB malformed payload. Assert excerpt length is exactly 512.

#### `packages/cockpit/src/gh/__tests__/wrapper.pr-graphql-detail.test.ts` (new)

- `getPullRequestGraphqlDetail` end-to-end schema test with the two payload shapes: (a) `closingIssuesReferences.nodes` populated (linked issue), (b) empty nodes (no linkage — FR-006a will refuse downstream).
- Runner-spy assertion: the `gh api graphql` args include `-F owner=…`, `-F repo=…`, `-F number=…`, and the query string contains the exact selection-set token `mergeStateStatus` (guards against silent drift).

#### `packages/generacy/src/cli/commands/cockpit/__tests__/merge.pr-flag.test.ts` (new)

- **FR-012 (SC-003, SC-004)** — `runMergeWithExplicitPr` merges when `completed:validate` + linkage + green checks; refuses (exit 3, message names `completed:validate`) when the label is missing.
- **FR-012a (SC-007)** — `runMergeWithExplicitPr` refuses (exit 3, message names `pr-flag-linkage-refused`) when `closingIssuesReferences` doesn't include `<ref>`, and when it's empty. Refusal message includes the "Development sidebar link" phrase.
- **FR-012b (SC-008)** — `runMergeWithExplicitPr` exits 0 (idempotent) on `MERGED` with linkage verified, and exits 3 on `CLOSED` (unmerged) with linkage verified.
- **Argument parsing** — `parsePrFlag('abc')` → throws `CockpitExit(2, …)`; `parsePrFlag('0')` → throws; `parsePrFlag('-3')` → throws; `parsePrFlag('42')` → 42.
- **Gate order** — supply a fixture that fails multiple gates simultaneously (empty linkage AND missing `completed:validate` AND red checks); assert refusal message names linkage (the first failing gate per FR-008), not the later gates. This proves the order is documented behavior, not accidental.

## Constitution check

No project-level constitution file (`.specify/memory/constitution.md`) is present. Implicit cross-checks:

- **Zod-only external validation** — every gh boundary parse in the diff uses `zod` schemas defined adjacent to existing ones (`Tier1InitialRefSchema`, `Tier1InitialResponseSchema`, `Tier1FollowupRefSchema`, `PrGraphqlDetailSchema`). No hand-rolled JSON traversal on parsed payloads.
- **No secrets in logs** — new log lines carry `pr`, `issue`, `repo`, `kind` (`empty-refs` | `mismatch`), `linkMethod`, `state`. No token, no header, no PR body content.
- **Fail-loud on internal boundary errors** — every parse-failure path throws (never `null` returns); the FR-002a retry has a documented finite bound and hard-fails on exhaustion (Q4→D).
- **No new npm dependencies** — `zod`, `commander`, `pino` all already present. `gh api graphql` is stock since gh 2.0; no bundle/pinning.
- **Types-only imports** — kept identical to today's pattern in `wrapper.ts` (`import { z } from 'zod'`; `import type { CommandRunner } from './command-runner.js'`).
- **File-size discipline** — `wrapper.ts` net delta: ~+180 LOC (new schemas, new helper, new `queryTier1FollowupGraphql`, new `getPullRequestGraphqlDetail` + interface entry, new formatter). `merge.ts` net delta: ~+120 LOC (new `runMergeWithExplicitPr` + `parsePrFlag` + shared-helper extraction). Test files: ~350 LOC total across the three files. All within the existing package's size budget (`wrapper.ts` is 1296 LOC today).
- **Exit-code discipline** — 0 / 1 / 2 / 3 semantics documented in `contracts/pr-flag-cli.md` and consistent with `packages/generacy/src/cli/commands/cockpit/exit.ts`.

## Rollout notes

- **No config, no migration.** All changes are in-process TypeScript. Users on gh 2.95.x and gh 2.96.0+ both hit the fixed path — the initial-shape schema is a superset of both.
- **`cockpit merge <ref>` behavior parity** — the no-`--pr` path is behavior-preserving except for the *implementation* of tier-1 resolution. The public output shape (`buildFailingCheckPayload` reasons, exit codes) is unchanged; the tier-1 failure surface now uses the FR-002a retry semantics instead of the tier-1's prior "throw on shape mismatch" mode.
- **`--pr` is an escape hatch, not a preferred path** (Assumptions §). Help text (`--pr <number>` option description above) documents that; no CLAUDE.md addition, no README bump — the flag is visible via `cockpit merge --help` and lives adjacent to the sanctioned resolver-driven path.
- **Cross-repo consistency**: the FR-006a linkage check compares `nameWithOwner` case-sensitively. GitHub's canonical case is server-provided; both `<ref>` and the graphql response use the same source, so no normalizer is needed. Note: `resolveIssueContext` may accept mixed-case owner in the CLI input — if this becomes a support burden, a follow-up (out of scope for #913) can normalize both sides. FR-012a covers exact-match today.
- **Retry-window telemetry**: the FR-002a retry does not currently emit its own log line (retry is silent; only exhaustion throws). If future ops surface needs visibility, a `logger.debug({event:'tier1-followup-retry'…})` at the retry site is a one-line addition; deferred as not requested by spec.
- **No new `gh` version pin** — the fix explicitly does not pin gh (Out-of-Scope §). The self-identifying error message is what makes future drift diagnosable, not preventable.
- **Cross-tier hardening deferred** (Out-of-Scope §) — tier-2 and tier-3 could plausibly drift too, but this spec fixes the one that broke. Follow-up audit is a separate finding, not blocked by this PR.

## Suggested next step

`/speckit:tasks` to generate the task list from this plan.

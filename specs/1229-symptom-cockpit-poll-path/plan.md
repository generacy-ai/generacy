# Implementation Plan: Scope cockpit poll events to the epic's resolved ref set

**Feature**: Scope cockpit poll events to the epic's resolved ref set
**Branch**: `1229-symptom-cockpit-poll-path`
**Status**: Complete
**Issue**: [generacy#1229](https://github.com/generacy-ai/generacy/issues/1229) | **Type**: Bug

## Summary

`runOnePoll` (`packages/generacy/src/cli/commands/cockpit/watch/poll-loop.ts`) currently
lists issues via `queryForRepo` → `gh search issues repo:<owner/repo> <n> <n> …`, where bare
numbers are free-text terms. Any issue that merely *mentions* an in-scope number is
snapshotted and diffed, so foreign issues leak onto the epic event bus and `/cockpit:auto`
dispatches on work it does not own. The same search form also implies `is:issue`, so PR refs
in the epic body are never returned and the poll path's PR branch is dead.

Per clarify Q1=A / Q2=C / Q3=A, the fix is:

1. **Exact-lookup query** — new `GhWrapper` method `batchLookupIssuesOrPrs(repo, numbers)`
   in `packages/cockpit`, one batched aliased-GraphQL `issueOrPullRequest(number:)` call per
   repo (reusing the `buildTier1FollowupQuery` / `tier1FollowupOnce` pattern in
   `wrapper.ts`). Structurally cannot match free text, and returns PRs — reviving the
   existing PR branch (`buildPrSnapshot`, `derivePrLifecycle`, `derivePrChecksNeeded`).
2. **Defensive post-filter** — a shared helper drops any fetched item whose `repo#number` is
   not in the resolved ref set before snapshotting. Also applied to `status.ts:83`, which
   builds the same free-text query.
3. **Budget** — one GraphQL call per repo per cycle *replaces* paginated REST search
   (`listAllIssues`), so per-repo search/list calls do not increase (they decrease). Gated
   per-PR calls (check-runs, pr-view) are the intended cost of live PR polling and stay
   pinned by `cockpit-graphql-budget.integration.test.ts`.

All four `runOnePoll` callers (`watch.ts`, `mcp/event-bus-registry.ts`
`runRealCycle`, `doorbell/aggregate-on-demand.ts`, tests) inherit the fix — no caller-side
logic changes beyond the `PollDeps` slimming below.

## Technical Context

- **Language/runtime**: TypeScript (ESM), Node >= 22, vitest.
- **Packages touched**:
  - `packages/cockpit` — new `GhWrapper` interface method + `GhCliWrapper` implementation
    (`src/gh/wrapper.ts`), unit tests.
  - `packages/generacy` — `watch/poll-loop.ts`, `status.ts`, new shared filter helper,
    `__tests__/helpers/fake-gh.ts`, test updates.
- **No new dependencies.** `zod` (already present in `packages/cockpit`) validates the
  GraphQL response shape.
- Cross-package imports resolve to built `dist/` — rebuild `@generacy-ai/cockpit` before
  typechecking/testing `packages/generacy`.
- Full stack notes: `specs/1229-symptom-cockpit-poll-path/stack.md`.

## Design

### 1. `packages/cockpit/src/gh/wrapper.ts` — `batchLookupIssuesOrPrs`

New interface method + implementation:

```ts
// GhWrapper interface
batchLookupIssuesOrPrs(repo: string, numbers: number[]): Promise<Issue[]>;
```

- Empty `numbers` → resolves `[]` with **zero** subprocess calls.
- Builds one aliased query per chunk of ≤100 numbers (`r0: issueOrPullRequest(number: N0)
  { … }`) via a `buildBatchLookupQuery(numbers)` builder mirroring
  `buildTier1FollowupQuery` (wrapper.ts:413). Numbers come from the epic-body parse
  (integers), so injection surface is zero. One chunk = one `gh api graphql` call; typical
  epics (≪100 refs) get exactly one call per repo.
- Inline fragments select the fields needed to construct the existing `Issue` shape
  (see `contracts/batch-lookup-graphql.md` and `data-model.md`):
  - `... on Issue { number title url state stateReason body createdAt author { login } labels(first: 100) { nodes { name } } }`
  - `... on PullRequest { number title url state body createdAt author { login } labels(first: 100) { nodes { name } } }`
- Mapping to `Issue`: PR `state: 'MERGED'` → `'CLOSED'` (matches how merged PRs surface
  from today's search path; `derivePrLifecycle` still detects merged via
  `getPullRequest`); PR `stateReason` → `null`; label nodes → `string[]`. Issues now carry
  a real `stateReason` (search could never return it) — `diff.ts` does not diff
  `stateReason`, so no new event class is introduced.
- **Missing refs are tolerated**: `gh api graphql` exits non-zero when the response carries
  a GraphQL `errors` array but still prints `data`. On non-zero exit, parse stdout anyway;
  if every error is `type: "NOT_FOUND"`, proceed with the partial data (nonexistent refs
  are simply absent from the result). Any other error → throw with the existing
  `formatShapeMismatchError` / `failIfNonZero` conventions. Zod-validates the envelope;
  `null` aliases are skipped.
- No internal retry: the poll loop already retries every cycle and `runPollLoop` catches
  and logs per-cycle errors. (Contrast with `tier1FollowupOnce`, whose one-shot caller
  needed a retry.)

### 2. `poll-loop.ts` — exact lookup + post-filter

- Delete `queryForRepo` (including the zero-result sentinel query) and the
  `listAllIssues` call.
- Per repo: `numbers = refs for repo` → skip repo if empty → `issues = await
  gh.batchLookupIssuesOrPrs(repo, numbers)`.
- Apply the defensive post-filter (below) to `issues` before the snapshot loop. Filtering
  the fetched list before snapshotting is the same guarantee as filtering `curr` (curr is
  built solely from this list) and additionally prevents wasted per-PR calls
  (`getPullRequest`, check-runs) for out-of-scope PRs.
- Slim `PollDeps`: remove `safetyCap`, `pageSize` (pagination is gone — result size is
  structurally bounded by the ref set), and `epicOwnerRepo` (existed only as the zero-refs
  sentinel target; zero refs now means zero calls). Update the four callers and
  `reposFromRefs` accordingly. `watch.ts`'s `--safety-cap` plumbing into `runOnePoll` is
  dropped; `listAllIssues` (still used by `status.ts` and the shared pagination helper)
  keeps its own cap.
- Everything downstream (`classifyIssue`, `isPullRequest`, PR branch, `computeTransitions`)
  is unchanged.

### 3. Shared post-filter — `shared/ref-set-filter.ts` (new, `packages/generacy`)

```ts
export function filterToRefSet(
  issues: Issue[],
  repo: string,
  refs: IssueRef[],
  logger?: { debug?: (msg: string) => void },
): Issue[];
```

Membership key: `${repo.toLowerCase()}#${number}` (matching `snapshotKey`'s lowercase-repo
normalization from #1106). Dropped items get a `logger.debug` line. Used by:

- `poll-loop.ts` (defence-in-depth behind the exact lookup — pins FR-001's "both").
- `status.ts:~109` — filter `listAllIssues` results against `resolved.parsed.allRefs`
  before building rows. Status keeps its search query (one-shot command, not the rate-limit
  hot spot; per FR-001's note the post-filter is what covers it). Status's own PR-visibility
  gap is unchanged and out of scope.

### 4. Tests (FR-005)

- **`packages/cockpit`** (`src/gh/__tests__/`): query-builder shape; response parsing and
  `Issue` mapping (issue, open PR, merged PR → `CLOSED`); NOT_FOUND-tolerant partial data;
  non-NOT_FOUND error throws; chunking at >100 numbers; empty input makes no call.
- **`FakeGh`** (`__tests__/helpers/fake-gh.ts`): implement `batchLookupIssuesOrPrs`,
  scripted like `listIssues` (reuse `issuesScript`/add `lookupByRepo` callback), so
  existing poll-loop/epic-walk/no-mutations tests migrate mechanically.
- **Out-of-scope drop (SC-001)**: FakeGh lookup returns an extra foreign issue (simulating
  a misbehaving/free-text backend) → assert no snapshot and no event. This pins the
  post-filter independently of the query form.
- **In-scope transition (SC-002)**: existing label-change test keeps passing through the
  new path.
- **PR refs (SC-004/FR-003)**: existing "classifies PRs via URL match" test now exercises
  the lookup path; add an assertion that a PR ref reaches the PR branch (lifecycle +
  checks rollup populated).
- **Budget (SC-003/FR-004)**: update `cockpit-graphql-budget.integration.test.ts`'s
  scripted runner to intercept `api graphql` lookups; assert exactly 1 lookup call per
  repo per cycle, **0** `search issues` calls on the poll path, and the existing per-PR
  bounds (≤30 check fetches, ≤6 pr-view per 120 cycles for 4 PRs) unchanged.
- **status**: a search result matching only on free text is dropped from rows.

### 5. Changeset (CI gate)

New file `.changeset/1229-cockpit-poll-scope.md`:

- `@generacy-ai/cockpit`: **minor** — new public `GhWrapper.batchLookupIssuesOrPrs`.
- `@generacy-ai/generacy`: **patch** — defect fix (spurious dispatch / dead PR branch).

## Project Structure

```
packages/cockpit/src/gh/
  wrapper.ts                     # + batchLookupIssuesOrPrs (interface + impl + builder + zod)
  __tests__/…                    # + builder/parse/tolerance/chunking tests
packages/generacy/src/cli/commands/cockpit/
  watch/poll-loop.ts             # exact lookup, post-filter, PollDeps slimmed
  shared/ref-set-filter.ts       # NEW — filterToRefSet
  status.ts                      # post-filter listAllIssues results
  watch.ts                       # stop passing safetyCap/epicOwnerRepo
  mcp/event-bus-registry.ts      # stop passing epicOwnerRepo
  doorbell/aggregate-on-demand.ts# stop passing epicOwnerRepo
  __tests__/helpers/fake-gh.ts   # + batchLookupIssuesOrPrs
  __tests__/…                    # updated + new scope/PR/budget tests
.changeset/1229-cockpit-poll-scope.md
```

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo — N/A. Repo-level invariants that
apply (from CLAUDE.md): changeset gate (handled above); no repo-root agent-context file
edits in spec phases; cockpit CLI verbs keep resolving refs via `resolveIssueContext`
(untouched here).

## Risks & Mitigations

- **GraphQL error semantics of `gh api graphql`** (non-zero exit with partial data): pinned
  by dedicated wrapper tests; only NOT_FOUND is tolerated.
- **Merged-PR state mapping**: `MERGED → CLOSED` preserves today's observable snapshot
  shape; lifecycle detection stays in `derivePrLifecycle`. Pinned by a wrapper mapping test
  and the existing pr-merged diff tests.
- **Reviving the PR branch adds gated per-PR calls**: accepted by clarify Q3=A, already
  bounded by `derivePrChecksNeeded` and pinned by the budget test.
- **`PollDeps` slimming touches all callers**: mechanical; the compiler enforces
  completeness.

## Next Step

Run `/speckit:tasks` to generate the dependency-ordered task list.

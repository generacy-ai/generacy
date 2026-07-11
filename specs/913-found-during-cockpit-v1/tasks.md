# Tasks: cockpit merge — resilient tier-1 resolver against gh CLI shape drift (#913)

**Input**: Design documents from `/specs/913-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/graphql-selection-set.md, contracts/pr-flag-cli.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Wrapper helpers & schemas (foundational)

- [X] T001 [US1][US3] Add module-private constants + helpers to `packages/cockpit/src/gh/wrapper.ts` near the existing schema block (~line 225–290): `TIER1_RETRY_BACKOFF_MS = 1000`, `SHAPE_MISMATCH_EXCERPT_CHARS = 512`, `PR_DETAIL_QUERY` template literal, `buildTier1FollowupQuery(numbers: number[])` builder (aliased `pr<i>: pullRequest(number: N)` form per `contracts/graphql-selection-set.md` §2), plus `sleep(ms)`, `captureGhVersion(runner)` (returns `'unknown'` on non-zero exit / thrown), and `formatShapeMismatchError(siteLabel, rawPayload, errorMessage, ghVersion)` (single-line message with 512-char excerpt).

- [X] T002 [US1] Add new zod schemas to `packages/cockpit/src/gh/wrapper.ts` adjacent to `PullRequestRefRawSchema` (~line 225):
  - `Tier1InitialRefSchema` — `{ number?: int, url?: string }.passthrough()` (FR-004)
  - `Tier1InitialResponseSchema` — `{ closedByPullRequestsReferences: array(Tier1InitialRefSchema).default([]) }.passthrough()`
  - `Tier1FollowupRefSchema` — `{ number, state, headRefName, isDraft, url }` (all required — no passthrough)
  - `Tier1FollowupResponseSchema` — `{ data: { repository: object.catchall(Tier1FollowupRefSchema.nullable()) } }`
  - `PrGraphqlDetailSchema` — full FR-006 selection set with `pullRequest.nullable()`

## Phase 2: Wrapper rewrites (depends on Phase 1)

- [X] T003 [US1] Rewrite `queryTier1ClosingRefs` in `packages/cockpit/src/gh/wrapper.ts` (~line 748–803) per plan §"queryTier1ClosingRefs — rewrite":
  1. Initial `gh issue view --json closedByPullRequestsReferences` call, parse with `Tier1InitialResponseSchema`; on JSON.parse or zod failure, throw via `formatShapeMismatchError` with `captureGhVersion` (FR-009/FR-010).
  2. Extract PR numbers (number-first, `extractPrNumberFromUrl` fallback per `parseResolveIssueToPr` pattern at wrapper.ts:478–520).
  3. Fast-path: empty numbers → return `[]` (resolver falls through to tier-2 naturally; NOT the FR-002a hard-fail path).
  4. Call new `queryTier1FollowupGraphql(owner, name, numbers)` (T004).
  5. FR-003 filter to `state === 'OPEN'` before returning `PullRequestRef[]`.

- [X] T004 [US1] Add `queryTier1FollowupGraphql(owner, name, numbers)` and `tier1FollowupOnce(owner, name, numbers)` private methods to `GhCliWrapper` in `packages/cockpit/src/gh/wrapper.ts`. `queryTier1FollowupGraphql` implements FR-002a: try once, on failure `sleep(TIER1_RETRY_BACKOFF_MS)` then retry, on second failure throw `Error('gh resolveIssueToPRRef tier1 follow-up graphql failed after 1 retry: ...')`. Never fall through to tier-2, never filter to survivors. `tier1FollowupOnce` invokes `gh api graphql -F owner=... -F repo=... -f query=<buildTier1FollowupQuery(numbers)>`, parses via `Tier1FollowupResponseSchema`, wraps parse failures via `formatShapeMismatchError` (FR-009), returns `Map<number, {...}>`.

- [X] T005 [US2] Add `PullRequestGraphqlDetail` exported interface and `getPullRequestGraphqlDetail(repo, prNumber)` method to `GhWrapper` interface + `GhCliWrapper` impl in `packages/cockpit/src/gh/wrapper.ts`. Impl invokes `gh api graphql -F owner=... -F repo=... -F number=... -f query=<PR_DETAIL_QUERY>`, parses via `PrGraphqlDetailSchema`, throws `Error('PR #<n> not found in <repo>')` when `data.repository.pullRequest === null`, otherwise maps to `PullRequestGraphqlDetail` shape (flattening `closingIssuesReferences.nodes` to `{ number, nameWithOwner }[]`).

## Phase 3: Wrapper tests (depends on Phase 2)

- [X] T006 [P] [US1][US3] Add `packages/cockpit/src/gh/__tests__/wrapper.tier1-shape-drift.test.ts` covering:
  - `resolveIssueToPRRef` succeeds against gh 2.96.0 minimal shape `{id, number, repository, url}` (FR-011, SC-001).
  - `resolveIssueToPRRef` still succeeds against gh 2.95.x rich shape with inline `state`/`headRefName` (SC-002).
  - FR-002a: on graphql-follow-up transport failure, exactly 2 `gh api graphql` invocations with ≥990ms / ≤1500ms gap (FR-012c, SC-009); on second failure the method throws AND zero calls to `gh pr list --search` occur.
  - FR-009: parse-failure error message contains `gh version: <first line of gh --version>` and `payload excerpt:` substrings (FR-013, SC-005).
  - FR-010: when `gh --version` exits non-zero, error message contains `gh version: unknown` and the underlying parse-failure text is preserved.
  - Excerpt cap: feed a 10KB malformed payload, assert excerpt length is exactly 512.

- [X] T007 [P] [US2] Add `packages/cockpit/src/gh/__tests__/wrapper.pr-graphql-detail.test.ts` covering:
  - `getPullRequestGraphqlDetail` schema-parses fixtures with populated `closingIssuesReferences.nodes` and with empty nodes.
  - Runner-spy assertion: `gh api graphql` args include `-F owner=`, `-F repo=`, `-F number=`, and the query string contains the exact tokens `mergeStateStatus`, `closingIssuesReferences`, `nameWithOwner` (per `contracts/graphql-selection-set.md` §5).
  - When `data.repository.pullRequest === null`, method throws `Error('PR #<n> not found in <repo>')`.

## Phase 4: Merge CLI wiring (depends on Phase 2)

- [X] T008 [US2] Extend `packages/generacy/src/cli/commands/cockpit/merge.ts` with the `--pr <number>` flag registration on the Commander command (help text per `contracts/pr-flag-cli.md` §7), and export `parsePrFlag(input)` per `contracts/pr-flag-cli.md` §2 (trim → `/^\d+$/` regex → `Number.parseInt` → `Number.isSafeInteger && > 0`; throws `new CockpitExit(2, 'merge: --pr must be a positive integer, got: "<input>"')` on any rejection).

- [X] T009 [US2] Refactor `runMerge` tail in `packages/generacy/src/cli/commands/cockpit/merge.ts` (lines ~217–295): extract `assertCompletedValidateAndMerge({ gh, issueRef, prNumber, logger, exitPolicy, linkMethod? })` shared helper covering `fetchIssueState` + `completed:validate` check + required-checks fetch + `classifyChecks` + `mergePullRequest` + `classifyAndDeleteBranch`. `exitPolicy: 'resolver' | 'pr-flag'` parameter selects exit code 1 vs 3 for missing-label / failing-checks refusals per `contracts/pr-flag-cli.md` §5. `runMerge` calls this with `exitPolicy: 'resolver'` — behavior-preserving.

- [X] T010 [US2] Widen `RunMergeResult.exitCode` union from `0 | 1` to `0 | 1 | 2 | 3` in `packages/generacy/src/cli/commands/cockpit/merge.ts` per `data-model.md` §"RunMergeResult". Add `RunMergeWithExplicitPrInput` type.

- [X] T011 [US2] Add `runMergeWithExplicitPr(input: RunMergeWithExplicitPrInput)` to `packages/generacy/src/cli/commands/cockpit/merge.ts`. Sequence per plan §"runMergeWithExplicitPr":
  1. `gh.getPullRequestGraphqlDetail(repo, prNumber)`.
  2. **Gate 1 (FR-006a linkage)**: `pr.closingIssuesReferences.some(l => l.nameWithOwner === repo && l.number === issue)`; on false, refuse with exit 3, `reason: 'pr-flag-linkage-refused'`, `kind: 'empty-refs' | 'mismatch'`, message includes remediation string ("Add via the PR's Development sidebar link") per `contracts/pr-flag-cli.md` §4. Reuse `serializeFailingCheckJson` + `buildFailingCheckPayload`.
  3. **Gate 2 (FR-006b state)**: `MERGED` → exit 0 with log `PR #<n> already merged, no-op`; `CLOSED` → exit 3, `reason: 'pr-flag-closed-unmerged'`; `OPEN` → continue.
  4. Delegate to `assertCompletedValidateAndMerge` with `exitPolicy: 'pr-flag'`.

- [X] T012 [US2] Route the Commander action handler in `packages/generacy/src/cli/commands/cockpit/merge.ts`: when `opts.pr != null`, call `runMergeWithExplicitPr`; otherwise call `runMerge` (unchanged signature). Ensure `<issue>` still routes through `resolveIssueContext` regardless of `--pr` presence.

## Phase 5: Merge CLI tests (depends on Phase 4)

- [X] T013 [P] [US2] Add `packages/generacy/src/cli/commands/cockpit/__tests__/merge.pr-flag.test.ts` covering:
  - **FR-012 / SC-003 / SC-004**: `runMergeWithExplicitPr` merges when linkage OK + `completed:validate` present + green checks; refuses (exit 3, message names `completed:validate`) when label missing.
  - **FR-012a / SC-007**: refuses (exit 3, `pr-flag-linkage-refused`) when `closingIssuesReferences` does not include `<ref>` (mismatch kind) AND when it is empty (empty-refs kind); refusal message contains "Development sidebar".
  - **FR-012b / SC-008**: exit 0 idempotent on `MERGED` with linkage verified; exit 3 on `CLOSED`-unmerged with linkage verified.
  - `parsePrFlag`: `'abc'`, `'0'`, `'-3'`, `'1.5'`, `''`, `' '`, `'1e6'`, `'42abc'` all throw `CockpitExit(2, ...)`; `'42'` returns `42`; value > `Number.MAX_SAFE_INTEGER` throws.
  - **Gate-order test**: fixture that fails linkage AND missing label AND red checks simultaneously — refusal message names linkage (first failing gate per FR-008), not later gates.

## Dependencies & Execution Order

**Sequential phases:**
- Phase 1 (T001, T002) → Phase 2 (T003, T004, T005) → Phase 3 (T006, T007) — wrapper tests need the impl to exist.
- Phase 2 → Phase 4 (T008–T012) — merge CLI depends on `getPullRequestGraphqlDetail` from T005.
- Phase 4 → Phase 5 (T013) — merge tests need `runMergeWithExplicitPr`.

**Within-phase parallelism:**
- Phase 1: T001 and T002 both edit `wrapper.ts` — sequential (same file).
- Phase 2: T003 depends on T002 (schemas) and T004 (follow-up method); T004 depends on T001 (helpers) and T002 (schemas); T005 depends on T001 (query constant) and T002 (schemas). Same file — sequential.
- Phase 3: T006 [P] and T007 [P] are independent test files — parallel.
- Phase 4: T008–T012 all edit `merge.ts` — sequential (same file), and T009 must precede T011 (runMergeWithExplicitPr calls the extracted helper).
- Phase 5: only T013.

**Critical path:** T001 → T002 → T003 → T004 → T005 → T008 → T009 → T010 → T011 → T012 → (T006 ∥ T007 ∥ T013).

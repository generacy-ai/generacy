# Tasks: Scope cockpit poll events to the epic's resolved ref set

**Input**: Design documents from `/specs/1229-symptom-cockpit-poll-path/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/batch-lookup-graphql.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = scope filter, US2 = PR refs, US3 = API budget)

## Phase 1: Setup

- [ ] T001 Establish a green baseline: `pnpm install`, then `pnpm --filter @generacy-ai/cockpit build`, then run the affected suites listed in `quickstart.md` to confirm they pass before changes (cross-package imports resolve to built `dist/` — the cockpit build must precede any `packages/generacy` typecheck/test).

## Phase 2: Core — `packages/cockpit` exact-lookup wrapper (US2, enables US1)

- [ ] T002 [US2] In `packages/cockpit/src/gh/wrapper.ts`, add `batchLookupIssuesOrPrs(repo: string, numbers: number[]): Promise<Issue[]>` to the `GhWrapper` interface with the doc comment from `data-model.md` (empty `numbers` → `[]` with no subprocess call; NOT_FOUND tolerated; chunks at ≤100).
- [ ] T003 [US2] In `packages/cockpit/src/gh/wrapper.ts`, add `buildBatchLookupQuery(numbers)` mirroring `buildTier1FollowupQuery` (:413): one index-suffixed alias `rN: issueOrPullRequest(number: N)` per number, with the exact `__typename` + `... on Issue` / `... on PullRequest` inline-fragment selection from `contracts/batch-lookup-graphql.md`.
- [ ] T004 [US2] In `packages/cockpit/src/gh/wrapper.ts`, add the zod `BatchLookupNodeSchema` (discriminated on `__typename`, nullable) and `BatchLookupResponseSchema` alongside `Tier1FollowupResponseSchema` per `data-model.md`.
- [ ] T005 [US2] In `packages/cockpit/src/gh/wrapper.ts`, implement `GhCliWrapper.batchLookupIssuesOrPrs`: chunk numbers at ≤100, one `gh api graphql -F owner= -F repo= -f query=` call per chunk (site label `api graphql (batchLookupIssuesOrPrs)`), zod-validate the envelope, skip `null` aliases, map nodes → `Issue` (PR `MERGED → 'CLOSED'`, PR `stateReason: null`, `labels.nodes[].name → string[]`, null `author` omitted). Non-zero exit with all-`NOT_FOUND` errors → accept partial `data`; any other error / unparseable stdout → throw via `failIfNonZero` / `formatShapeMismatchError`. No internal retry.

## Phase 3: Core — `packages/generacy` poll path, filter, and status (US1, US2)

<!-- Phase boundary: Phase 2 wrapper (interface + impl) must exist before the poll path can call it and before FakeGh can implement it. -->

- [ ] T006 [US1] Create `packages/generacy/src/cli/commands/cockpit/shared/ref-set-filter.ts` exporting `filterToRefSet(issues, repo, refs, logger?)`: membership key `` `${repo.toLowerCase()}#${issue.number}` `` vs `` `${ref.repo.toLowerCase()}#${ref.number}` `` (mirrors `snapshotKey`'s #1106 lowercase normalization); pure, no API calls, one `logger.debug` line per dropped item.
- [ ] T007 [US1] [US2] Rewrite `runOnePoll` in `packages/generacy/src/cli/commands/cockpit/watch/poll-loop.ts`: delete `queryForRepo` (and its zero-result sentinel) and the `listAllIssues` call; per repo build `numbers` from refs, skip repo when empty, call `gh.batchLookupIssuesOrPrs(repo, numbers)`, apply `filterToRefSet` to the fetched list before the snapshot loop. Leave `classifyIssue`, `isPullRequest`, the PR branch, and `computeTransitions` unchanged.
- [ ] T008 [US1] Slim `PollDeps` in `packages/generacy/src/cli/commands/cockpit/watch/poll-loop.ts`: remove `safetyCap`, `pageSize`, and `epicOwnerRepo`; update `reposFromRefs` accordingly (per `data-model.md`).
- [ ] T009 [US1] In `packages/generacy/src/cli/commands/cockpit/status.ts` (~:83/~:109), apply `filterToRefSet` to the `listAllIssues` results against `resolved.parsed.allRefs` before building rows. Keep the existing search query (status is a one-shot command, not the poll hot spot; PR-visibility gap stays out of scope).

## Phase 4: Caller updates (compiler-driven from the `PollDeps` slimming)

- [ ] T010 [US1] Update `runOnePoll` callers to stop passing removed `PollDeps` fields: `watch.ts` (drop `--safety-cap` plumbing into `runOnePoll`; `listAllIssues`/`status.ts` keep their own cap), `mcp/event-bus-registry.ts` `runRealCycle` (drop `epicOwnerRepo`), and `doorbell/aggregate-on-demand.ts` (drop `epicOwnerRepo`). All under `packages/generacy/src/cli/commands/cockpit/`.

## Phase 5: Tests (FR-005)

<!-- Phase boundary: implementation (Phases 2-4) lands before pinning tests to the new contract. -->

- [ ] T011 [P] [US2] `packages/cockpit/src/gh/__tests__/` — cover `buildBatchLookupQuery` shape; response parsing + `Issue` mapping (issue, open PR, merged PR → `CLOSED`); NOT_FOUND-tolerant partial data; non-NOT_FOUND error throws; chunking at >100 numbers; empty input makes zero subprocess calls.
- [ ] T012 [US1] [US2] Implement `batchLookupIssuesOrPrs` in `packages/generacy/src/cli/commands/cockpit/__tests__/helpers/fake-gh.ts`, scripted like `listIssues` (reuse `issuesScript` / add a `lookupByRepo` callback) so existing poll-loop / epic-walk / no-mutations tests migrate mechanically.
- [ ] T013 [US1] Out-of-scope drop test (SC-001) in `packages/generacy/src/cli/commands/cockpit/__tests__/watch.poll-loop.test.ts`: FakeGh lookup returns an extra foreign issue → assert no snapshot and no event (pins the post-filter independently of the query form).
- [ ] T014 [US1] In-scope transition test (SC-002) in `watch.poll-loop.test.ts`: confirm the existing label-change/genuine-transition test still emits its event through the new lookup path.
- [ ] T015 [US2] PR-ref test (SC-004 / FR-003) in `watch.poll-loop.test.ts`: a PR ref from the epic body reaches the PR branch — assert `derivePrLifecycle` + checks rollup are populated (no dead branch remains).
- [ ] T016 [US3] Update `packages/generacy/src/cli/commands/cockpit/__tests__/cockpit-graphql-budget.integration.test.ts`: intercept `api graphql` lookups; assert exactly 1 lookup call per repo per cycle, **0** `search issues` calls on the poll path, and the existing per-PR bounds (≤30 check fetches, ≤6 pr-view per 120 cycles for 4 PRs) unchanged.
- [ ] T017 [P] [US1] status free-text-drop test: a `listAllIssues` result matching only on free text is dropped from `cockpit status` rows (new/updated test under `packages/generacy/src/cli/commands/cockpit/__tests__/`).

## Phase 6: Changeset & Verification

- [ ] T018 Add `.changeset/1229-cockpit-poll-scope.md` (newly added file — CI gate greps `--diff-filter=A`): `@generacy-ai/cockpit` **minor** (new public `GhWrapper.batchLookupIssuesOrPrs`), `@generacy-ai/generacy` **patch** (defect fix).
- [ ] T019 Rebuild + full verify: `pnpm --filter @generacy-ai/cockpit build`, then typecheck and run the `quickstart.md` suites plus `pnpm --filter @generacy-ai/generacy test -- src/cli/commands/cockpit`; code-review that no dead PR branch remains on the poll path (SC-004).

## Dependencies & Execution Order

**Sequential backbone**:
- Phase 1 (baseline) → Phase 2 (wrapper) → Phase 3 (poll/filter/status) → Phase 4 (callers) → Phase 5 (tests) → Phase 6 (changeset/verify).
- Within Phase 2: T002 (interface) → T003/T004 (builder + schemas, independent of each other) → T005 (impl, depends on T003+T004).
- Phase 3: T006 (filter helper) has no intra-phase deps; T007 depends on T002+T006; T008 pairs with T007 (same file); T009 depends on T006.
- Phase 4: T010 depends on T008 (the removed fields must exist as removed before callers compile).
- Phase 5: T012 (FakeGh) depends on T002 and unblocks T013/T014/T015/T016; T011 depends only on the Phase 2 wrapper impl.

**Parallel opportunities**:
- T003 and T004 can be written in parallel (builder vs zod schemas), then both feed T005.
- T011 (cockpit wrapper tests) is [P] — different package from the generacy poll-loop tests; can proceed once Phase 2 impl lands, concurrent with Phase 3/4.
- T017 (status test) is [P] — different file/target from the poll-loop tests.

**Cross-package build note**: after any `packages/cockpit` change (T002–T005, T011), rebuild `@generacy-ai/cockpit` before typechecking/testing `packages/generacy`, or you get spurious "no exported member 'batchLookupIssuesOrPrs'" errors.

# Tasks: `cockpit merge` reads `completed:validate` from the linked issue and blocks CLOSED issues

**Input**: Design documents from `/specs/853-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/merge-command.md, contracts/failing-check-payload.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = issue-scoped label; US2 = issue ref in payload; US3 = CLOSED-issue guard)

## Phase 1: Type & Schema Extensions (foundational — everything below imports these types)

- [X] T001 [P] [US1] Extend `IssueStateResult` and `IssueStateRawSchema` in `packages/cockpit/src/gh/wrapper.ts`: add `stateReason: string | null` field to the interface; add `stateReason: z.string().nullable().optional()` to the Zod schema; add `stateReason` to `fetchIssueState`'s `--json` gh arg (`'state,stateReason,closedAt,labels,assignees,title'`); map `shape.data.stateReason ?? null` in the return construction. Per `data-model.md` §"`IssueStateResult`" and `research.md` Decision 5.

- [X] T002 [P] [US2, US3] Extend `FailingCheckPayload` and `BuildFailingCheckInput` in `packages/generacy/src/cli/commands/cockpit/shared/failing-check-json.ts`: add `IssueRefWithState` interface (`{owner, repo, number, state?: 'OPEN'|'CLOSED', stateReason?: string | null}`); add optional `issue?: IssueRefWithState` to both `FailingCheckPayload` and `BuildFailingCheckInput`; wire the new field through the pass-through in `buildFailingCheckPayload` (payload gets `issue` from `input.issue` if present, no synthesis); add invariant I-6 runtime check (if `input.issue.state` set, `input.issue.stateReason` must also be set — throw otherwise). Preserve all existing invariants for `reason`/`pr`/`failingChecks`. Per `data-model.md` §"`FailingCheckPayload`" and `contracts/failing-check-payload.md`.

- [X] T003 [P] [US2, US3] Relax the shared JSON schema at `specs/789-epic-generacy-ai-tetrad/contracts/failing-check.schema.json`: add optional `issue` property (`$ref: '#/$defs/IssueRefWithState'`) to `properties`; add `$defs.IssueRefWithState` object with required `owner`/`repo`/`number` and optional `state` (enum `['OPEN','CLOSED']`) and `stateReason` (`['string','null']`), with `additionalProperties: false` on the sub-schema. Do NOT add `issue` to top-level `required`. Do NOT touch the `allOf` conditional block. Per `contracts/failing-check-payload.md` §"Schema-file diff".

## Phase 2: Behavioral change in `runMerge` (depends on T001, T002)

- [X] T010 [US1, US2, US3] Rewrite `packages/generacy/src/cli/commands/cockpit/merge.ts` decision tree per `contracts/merge-command.md` §"Decision tree (happy path) — After":
  1. Derive `{owner, repo: name, number}` from `RunMergeInput.repo` (split on `/`) and `input.issue` once at function entry; hold as `issueRef` to thread into every red payload.
  2. Steps 1–2 (`resolveIssueToPRRef` → OPEN check) unchanged in ordering; extend their payloads to include `issue: issueRef`.
  3. Keep step 3 `getPullRequestDetail` unchanged (bubbling `getPullRequestDetail` errors is intentional — Out-of-Scope per spec).
  4. **NEW step 4**: wrap `await gh.fetchIssueState(repo, issue)` in a try/catch. On throw: log via pino (`logger.error({ issue, repo, err }, 'Failed to fetch issue state')`) and return `{status:'red', reason:'unresolved', pr:null, issue: issueRef, failingChecks:[]}`. The raw gh error text goes to stderr via the existing pino serializer (do not swallow).
  5. **NEW step 5 (CLOSED-issue guard, Q3→A)**: if `issueState.state === 'CLOSED'`, log `logger.error({ issue, repo, state, stateReason }, 'Issue is CLOSED')` and return `{status:'red', reason:'unresolved', pr:{number,url}, issue:{...issueRef, state, stateReason}, failingChecks:[]}`. Runs BEFORE step 6 label check (CLOSED is a stronger predicate than "unlabeled").
  6. **REPLACED step 6**: replace `pr.labels.includes(COMPLETED_VALIDATE_LABEL)` with `issueState.labels.includes(COMPLETED_VALIDATE_LABEL)`. Rewrite the log line to `logger.error({ issue, repo, missingLabel: 'completed:validate' }, 'Issue missing completed:validate label')`. Payload includes `issue: issueRef`.
  7. Step 7 (`getRequiredCheckNames`/`getPullRequestCheckRuns` → `classifyChecks`) unchanged in behavior; extend the `checks-failing` payload to include `issue: issueRef`.
  8. Step 8 (`mergePullRequest`) unchanged — exit 0, empty stdout, no `issue` field.
  Per `plan.md` §"Behavioral change" and `contracts/merge-command.md` §"Decision tree" + invariants I-1..I-7.

## Phase 3: Test updates (depends on T001–T010 landing production shape)

- [X] T020 [US1, US3] Update `fakeGh` factory and fixtures in `packages/generacy/src/cli/commands/cockpit/__tests__/merge.test.ts`:
  - Add `overrides.fetchIssueState?: IssueStateResult` seam to `fakeGh` factory; default to `{state:'OPEN', stateReason:null, closedAt:null, labels:['completed:validate'], assignees:[], title:''}` (this default keeps happy-path tests green under the new issue-scoped label behavior).
  - Remove `labels: ['completed:validate']` from the `greenPr` fixture (set to `[]` or delete the `labels` field). This is the SC-004 fix.
  - Per `plan.md` §"Test changes" and `contracts/merge-command.md` §"Test signals".

- [X] T021 [US2] Update existing tests in `merge.test.ts` to assert `payload.issue` presence:
  - `SC-002 missing-label` test: retitle from "PR without completed:validate" to "ISSUE without completed:validate"; override becomes `fetchIssueState: { …, labels: [] }`; assert `payload.issue === {owner:'o', repo:'r', number:7}`; assert `payload.pr` remains non-null; assert `mergePullRequest` NOT called.
  - `unresolved (PR not found)` case: assert `payload.issue: {owner:'o', repo:'r', number:7}` in addition to existing `pr:null` assertion.
  - `unresolved (PR not OPEN)` case: assert `payload.issue: {owner:'o', repo:'r', number:7}` in addition to existing assertions.
  - `checks-failing` cases: assert `payload.issue: {owner:'o', repo:'r', number:7}` in addition to existing check assertions.
  - `short-circuits: missing-label is reported before checks are fetched` case: preserve — `getRequiredCheckNames`/`getPullRequestCheckRuns` MUST still not be called on the label-missing branch (verifies step 6 runs before step 7).
  - Per `plan.md` §"Test updates (existing cases)" and `contracts/merge-command.md` invariant I-7.

- [X] T022 [US1] Add new regression test in `merge.test.ts` — **FR-007a (SC-001) counterexample fixture**: issue labeled `completed:validate` + PR unlabeled (`labels: []` on the `PullRequestDetail` fixture) + PR checks green → `mergePullRequest` called once, `result.exitCode === 0`, `result.stdout === ''`. This is the test that would have caught #853 in review — reverting the fix (to `pr.labels.includes(...)`) makes this test fail. Per `contracts/merge-command.md` §"Test signals SC-001" and `research.md` Decision 6.

- [X] T023 [US2] Add new regression test in `merge.test.ts` — **FR-007b (SC-002)**: issue unlabeled (`fetchIssueState: {labels: []}`) + PR fixture unlabeled → payload is `{status:'red', reason:'missing-label', pr: {...non-null...}, issue: {owner:'o', repo:'r', number:7}, failingChecks:[]}`; assert `mergePullRequest` NOT called. Deleting the `issue` field extension makes this test fail. Per `contracts/merge-command.md` §"Test signals SC-002".

- [X] T024 [US3] Add new regression test in `merge.test.ts` — **FR-007c (SC-003) CLOSED-issue guard**: `fetchIssueState` returns `{state:'CLOSED', stateReason:'completed', labels:['completed:validate'], …}` + PR OPEN + checks green → payload `{status:'red', reason:'unresolved', pr:{number,url}, issue:{owner:'o', repo:'r', number:7, state:'CLOSED', stateReason:'completed'}, failingChecks:[]}`; assert `mergePullRequest` NOT called; assert `getPullRequestCheckRuns` NOT called (CLOSED guard short-circuits before checks). Per `contracts/merge-command.md` §"Test signals SC-003" and invariant I-3.

- [X] T025 [US2] Add new regression test in `merge.test.ts` — **Q2→B path (fetchIssueState throws)**: `fakeGh.fetchIssueState = () => { throw new Error('gh network error'); }` → payload `{status:'red', reason:'unresolved', pr:null, issue:{owner:'o', repo:'r', number:7}, failingChecks:[]}`; assert the raw error passes through pino (spy on `logger.error` for `'Failed to fetch issue state'`). Per `contracts/merge-command.md` §"Failure modes" and invariant I-4.

- [X] T026 [US1] Add SC-004 meta-test in `merge.test.ts` — a one-line assertion iterating every exported `PullRequestDetail` fixture in the module and asserting `expect(fixture.labels ?? []).not.toContain('completed:validate')`. Prevents a future contributor from re-encoding the same tests-encode-the-bug pattern (#800/#826/#836) on a new fixture. Per `plan.md` §"Test changes (SC-004 guard)" and `research.md` Decision 6.

- [X] T027 [US2, US3] Extend ajv schema-validation assertions in `merge.test.ts` (if the existing test rig compiles `failing-check.schema.json` — grep confirms usage): assert every emitted red payload validates against the relaxed schema; add a positive assertion that the CLOSED-issue payload's `issue.state` and `issue.stateReason` fields validate. Per `contracts/failing-check-payload.md` §"Test rig".

## Phase 4: Verification (depends on Phase 3 tests passing)

- [X] T030 Run `pnpm --filter @generacy-ai/generacy test src/cli/commands/cockpit/__tests__/merge.test.ts` — all cases (existing + new T022/T023/T024/T025/T026/T027) pass. Fix any regressions. Per `quickstart.md` §"Running the tests".

- [X] T031 Run `pnpm --filter @generacy-ai/cockpit test` (if `packages/cockpit` has tests touching `fetchIssueState`) — existing callers of `fetchIssueState` continue to work with the new optional-nullable `stateReason` field. Per `data-model.md` §"Types referenced (unchanged)" and `plan.md` §"Non-changes".

- [X] T032 Run `pnpm --filter @generacy-ai/generacy typecheck` (or the repo's canonical typecheck command) — no type errors from the extended interfaces. Per `plan.md` §"Technical Context — TypeScript 5.x".

## Dependencies & Execution Order

**Phase 1 (T001, T002, T003)** is foundational — all three tasks touch different files and can run in **parallel**. Everything else imports these types/schemas.

**Phase 2 (T010)** depends on **all** of Phase 1: `runMerge` imports the extended `IssueStateResult.stateReason` (T001), the extended `BuildFailingCheckInput.issue` (T002), and the payloads it emits must satisfy the relaxed schema (T003).

**Phase 3 (T020–T027)** depends on Phase 2: tests exercise the new `runMerge` decision tree and assert payload shapes matching the extended types. Within Phase 3:
- T020 (fixtures + fakeGh seam) MUST land first — every subsequent test in the phase uses it.
- T021 (existing-test updates) is independent of T022–T026 (new tests) but shares the test file — coordinate merges to avoid conflicts.
- T022, T023, T024, T025, T026, T027 all touch the same `merge.test.ts` file — they are NOT parallelizable at the file level, but individual writers can prepare each block separately before merging in sequence.

**Phase 4 (T030–T032)** is the verification gate — all three commands run after Phase 3 lands.

**Parallel opportunities**:
- T001, T002, T003 — three different files, no cross-dependencies.
- T031 and T032 can run in parallel with T030 once the test file compiles.

**Sequential rails**:
- T001+T002+T003 → T010 → T020 → (T021, T022, T023, T024, T025, T026, T027 serialized on `merge.test.ts`) → T030+T031+T032.

---

*Generated by speckit — 12 tasks (3 setup, 1 core, 8 test, 3 verify), standard mode.*
*Next step: `/speckit:implement` to begin execution.*

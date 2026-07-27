# Tasks: Prevent worker from resurrecting deleted branches and cross-contaminating issues after PR merge

**Input**: Design documents from `/specs/1051-problem-after-speckit-pr/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/ (push-guard.md, find-pr-for-branch-any-state.md, closed-issue-dispatch-gate.md, repo-checkout-prune.md), quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1..US4)

## Phase 1: workflow-engine helper (blocks FR-002)

- [ ] T001 [US2] Add `findPRForBranchAnyState(owner, repo, branch): Promise<PullRequest | null>`
  method declaration to `GitHubClient` interface in
  `packages/workflow-engine/src/actions/github/client/interface.ts`.
  Signature verbatim per `contracts/find-pr-for-branch-any-state.md`. Do NOT modify
  `findPRForBranch`'s signature (five other call sites depend on the open-only default —
  Q2 clarification, R2, invariant I-2).

- [ ] T002 [US2] Implement `findPRForBranchAnyState` in
  `packages/workflow-engine/src/actions/github/client/gh-cli.ts` immediately after the
  existing `findPRForBranch` method (currently at `:890-926`). Copy that method's shape
  verbatim except add `--state all` to the `gh pr list` argv. Preserve the existing
  lowercase state normalization (`MERGED`→`'merged'`, `CLOSED`→`'closed'`, `OPEN`→`'open'`);
  inline `mapState` if not already private. `--limit 1` is retained (returns newest by
  `created_at DESC`, most diagnostic).

- [ ] T003 [P] [US2] Create `packages/workflow-engine/src/actions/github/client/__tests__/gh-cli.find-pr-any-state.test.ts`.
  Mocked-runner unit test covering all six cases in `contracts/find-pr-for-branch-any-state.md § Test surface`:
  empty list → `null`; OPEN / MERGED / CLOSED variants → object with matching `state`;
  non-zero exit → `null`; static argv assertion that `--state all` is present in the
  `executeGh` call.

- [ ] T004 [P] [US2] Regression assertion: add a case to the existing
  `packages/workflow-engine/src/actions/github/client/__tests__/gh-cli.test.ts` (or the
  file that already covers `findPRForBranch`) asserting `--state all` is **not** present
  in the argv passed by `findPRForBranch`. Protects invariant I-2 (Q2 clarification).

## Phase 2: FR-001 — prune fetch (independent)

- [ ] T010 [US1] Add `--prune` to the multi-ref `git fetch origin` in
  `packages/orchestrator/src/worker/repo-checkout.ts::switchBranch()` (current line ~109):
  `['fetch', 'origin']` → `['fetch', 'origin', '--prune']`. Per
  `contracts/repo-checkout-prune.md`.

- [ ] T011 [US1] Same change in
  `packages/orchestrator/src/worker/repo-checkout.ts::updateRepo()` (current line ~224).
  Both sites MUST land in the same commit — one-of-two leaves the other path live
  (spec AC on US1).

- [ ] T012 [US1] Verify `fetchBase()` at `:143` is NOT touched — it is a single-ref
  `git fetch origin <baseBranch>` and `--prune` there has no effect (research R1,
  invariant I-3).

- [ ] T013 [US1] Extend `packages/orchestrator/src/worker/__tests__/repo-checkout.test.ts`:
  add SC-005 static assertions using the existing `execFile` mock — invoke `switchBranch`
  and `updateRepo` and assert the argv passed to `git fetch` on both paths includes
  `--prune`. Add a negative assertion that the `fetchBase` argv (single-ref fetch of the
  base branch) does **not** include `--prune`.

## Phase 3: FR-002/003 — pre-push guard (depends on Phase 1)

- [ ] T020 [US2] Create `packages/orchestrator/src/worker/push-guard.ts` implementing the
  exact public surface in `contracts/push-guard.md`: `PushGuardInput`, `PushGuardDecision`
  (discriminated union), `evaluatePushGuard(input): Promise<PushGuardDecision>`.
  - Run `github.findPRForBranchAnyState` and `git.remoteBranchExists` in parallel
    (`Promise.all`).
  - Apply the six-row decision matrix in the contract's exact order — rows 1–2
    (merged/closed) short-circuit before row 3 (branch-missing).
  - Failure isolation: if either lookup throws, return `{ kind: 'allow' }` (fail open
    per contract § Failure isolation).
  - Emit NO logs from inside the guard — the caller owns the `event: 'push-refused'`
    log line (contract § Log side-effects; enforces SC-002 single-line assertion,
    invariant I-4).
  - Default `git.remoteBranchExists` implementation may live here or in a sibling
    helper — call `execFileAsync('git', ['ls-remote', '--heads', 'origin', branch])`
    and return `stdout.trim() !== ''`. Same idiom already used by
    `GhCliGitHubClient.branchExists(branch, true)` at `gh-cli.ts:1094-1097`.

- [ ] T021 [US2] Create `packages/orchestrator/src/worker/__tests__/push-guard.test.ts`
  covering the full SC-002 seven-case decision matrix (contract § Test surface) plus the
  two failure-isolation cases (either lookup throws → allow). Assert the
  `PushGuardDecision` shape field-by-field (`kind`, `reason`, `prNumber`, `branch`, `owner`,
  `repo`, `issueNumber`). No log assertions here — the guard emits none.

- [ ] T022 [US2] Wire the guard into
  `packages/orchestrator/src/worker/pr-feedback-handler.ts` immediately before the push
  at `:670`. On `refuse`:
  - Log exactly one line at `warn`: `logger.warn({ event: 'push-refused', reason,
    prNumber, branch, owner, repo, issueNumber }, '...')`. Structured fields per FR-003a
    and data-model.md `PushGuardDecision`.
  - Apply FR-003b label state: fetch `issue.state` (via `github.getIssue` — piggyback
    on any already-loaded issue where available per FR-008 budget). `closed` → clear
    `agent:in-progress` only. `open` → clear `agent:in-progress` AND add `agent:error`.
    Never add `failed:<phase>` (invariant I-6, R5).
  - Exit the handler without calling `commitAndPushChanges`.

- [ ] T023 [US2] Wire the guard into `packages/orchestrator/src/worker/pr-manager.ts`
  immediately before `commitAndPush`/`commitPushAndEnsurePr` (current push site ~ `:114`).
  Same log + label semantics as T022.

- [ ] T024 [US2] Wire the guard into `packages/orchestrator/src/worker/phase-loop.ts`
  immediately after `switchBranch` and before phase-execute — this is the second
  invocation site per phase that closes the `hasChanges: false` no-op hole
  (research R3, Q5 clarification). Same log + label semantics as T022.

- [ ] T025 [P] [US2] Create
  `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.push-guard.test.ts`.
  Integration test covering the refusal path in `pr-feedback-handler`:
  - guard returns `refuse{pr-merged}` + `issue.state='closed'` → exactly one `warn`
    log emitted with FR-003a fields, `agent:in-progress` removed, `agent:error` NOT
    added, `commitAndPushChanges` NOT called (SC-002).
  - guard returns `refuse{pr-merged}` + `issue.state='open'` → same log, plus
    `agent:error` added.
  - guard returns `refuse{branch-missing, prNumber: null}` → refusal path fires with
    `prNumber: null` in the log.
  - guard returns `allow` → normal push flow proceeds (regression guard for
    happy-path).

## Phase 4: FR-005 — dispatch-time closed-issue gate (independent)

- [ ] T030 [US4] Modify `packages/orchestrator/src/services/label-monitor-service.ts`
  per `contracts/closed-issue-dispatch-gate.md`:
  - Insert the gate immediately after `fetchedIssue` is populated (current site
    `:322-333`) and before the queue-item build.
  - Gate: `if (fetchedIssue && fetchedIssue.state === 'closed') { … return false; }`.
    Applies to BOTH `type === 'process'` AND `type === 'resume'` (Q1 clarification,
    R7).
  - Emit exactly one `info` log with structured fields `{ dropped: 'issue-closed',
    issueNumber, eventType: type, phase: parsedName, owner, repo }`.
  - Zero mutations on drop (no `enqueue`, no `markProcessed`, no label mutation) —
    invariant I-5, SC-004.
  - Fallback: if `fetchedIssue === null` (swallowed fetch error), gate does NOT fire —
    event proceeds to enqueue. Documented in contract § Fallback.

- [ ] T031 [P] [US4] Create
  `packages/orchestrator/src/services/__tests__/label-monitor-service.closed-issue.test.ts`
  covering the five cases in `contracts/closed-issue-dispatch-gate.md § Test surface`:
  - `type: 'process'` + closed → drop + log fires with `eventType: 'process'` + zero
    mutations.
  - `type: 'resume'` + closed → drop + log fires with `eventType: 'resume'` + zero
    mutations.
  - `type: 'process'` + open → proceed to enqueue (no drop log).
  - `type: 'resume'` + open → proceed to enqueue (no drop log).
  - `github.getIssue` throws → `fetchedIssue` is `null`, event proceeds to enqueue
    (no drop, no crash).
  - Spy assertions on `queueManager.enqueue`, `phaseTracker.markProcessed`,
    `client.addLabels`, `client.removeLabels` — all called 0 times on drop paths.

## Phase 5: FR-004 — cross-issue contamination regression (independent)

- [ ] T040 [US3] Create
  `packages/orchestrator/src/__tests__/repo-checkout-cross-issue.test.ts` per plan
  §Test strategy SC-003. Seed a reused checkout with issue-B files staged (per
  quickstart.md troubleshooting: **stage** the files but do not commit — `git reset
  --hard HEAD` will drop them, exercising the invariant). Then run the phase-commit
  path for issue A. Assert issue A's HEAD commit contains **only** issue-A-scoped
  files (path prefix check + `specs/A-*/` directory check). No source changes for
  FR-004 — the existing `git reset --hard HEAD` + `git clean -fd` inside
  `switchBranch` (`:106-107`) and `updateRepo` (`:220-221`) already provide the
  invariant (research R4); this test is the regression guard.

## Phase 6: SC-001 integration test (depends on Phase 2 landing)

- [ ] T050 [US1] Create
  `packages/orchestrator/src/__tests__/repo-checkout-branch-resurrection.integration.test.ts`
  per `contracts/repo-checkout-prune.md § Test surface`:
  - Fixture uses a real ephemeral git repo (mktemp): create bare `origin.git`, clone
    to `checkoutA`, create branch `feature`, push, commit files.
  - Clone to `checkoutB`, delete `feature` from `origin.git` (simulates PR merge
    with `--delete-branch`).
  - Return to `checkoutA`, run `switchBranch(checkoutA, 'feature')`.
  - Assert `git ls-remote origin feature` on `origin.git` returns empty — branch
    NOT recreated (SC-001).
  - Repeat via the `updateRepo` code path (invoke through `ensureCheckout` with an
    existing checkout).
  - Both `switchBranch` and `updateRepo` paths MUST be exercised — SC-005 static
    check alone won't catch a semantic regression here.

## Phase 7: Changeset + verification

- [ ] T060 [P] Create `.changeset/1051-branch-resurrection-fix.md` per plan Project
  Structure: bumps `@generacy-ai/workflow-engine` **patch** (internal `findPRForBranchAnyState`
  method, not re-exported at the public boundary — orchestrator-only wire per CLAUDE.md
  changeset rule "new exports NOT re-exported from the package's public `index.ts` are
  internal surface → `patch`") + `@generacy-ai/orchestrator` **patch** (bug fix, no new
  exports). Single file listing both packages.

- [ ] T061 Run the quickstart.md grep sanity checks:
  - `grep -n "fetch.*origin.*--prune\|fetch.*--prune.*origin" packages/orchestrator/src/worker/repo-checkout.ts`
    → expect exactly 2 matches (switchBranch + updateRepo).
  - `grep -rn "event: 'push-refused'" packages/orchestrator/src/worker`
    → expect matches ONLY in pr-feedback-handler.ts, pr-manager.ts, phase-loop.ts.
  - `grep -n "dropped: 'issue-closed'" packages/orchestrator/src/services/label-monitor-service.ts`
    → expect exactly 1 match.
  - `grep -n "async findPRForBranch(.*state" packages/workflow-engine/src/actions/github/client/gh-cli.ts`
    → expect NO match (invariant I-2 holds).
  - `grep -n "fetch.*origin.*<baseBranch>.*--prune\|fetch.*--prune.*<baseBranch>" packages/orchestrator/src/worker/repo-checkout.ts`
    → expect NO match (invariant I-3 holds — fetchBase untouched).

- [ ] T062 Run the full regression suite per quickstart.md:
  `pnpm --filter @generacy-ai/orchestrator test` and
  `pnpm --filter @generacy-ai/workflow-engine test`. All pre-existing tests plus the
  new tests must pass. SC-006 explicitly targets speckit-feature and speckit-bugfix
  happy-path e2e tests — verify they are still green.

## Dependencies & Execution Order

**Hard dependencies**:
- **Phase 1 → Phase 3**: `findPRForBranchAnyState` (T001, T002) must land before the
  guard implementation (T020) can import it. T003/T004 can run in parallel with T020
  as long as T001/T002 landed.
- **Phase 2 landing → Phase 6**: SC-001 integration test (T050) assumes `--prune` is
  in place; run it after T010/T011 land, otherwise it fails by construction.
- **Phase 3 wiring order**: T020 → T022/T023/T024 (wiring depends on the guard module
  existing). T025 requires T022.

**Order-independent (may land in any order after their phase dependencies)**:
- FR-001 (Phase 2), FR-004 (Phase 5), FR-005 (Phase 4) have no interdependencies with
  each other or with Phase 3. Per plan §Sequencing / dependency notes.
- Defense-in-depth composes at runtime (FR-005 → FR-002 → FR-001), but the code
  changes are additive and independent.

**Parallel opportunities**:
- Within Phase 1: T003, T004 in parallel after T001/T002.
- Across phases: once Phase 1 lands, Phase 2 (T010–T013), Phase 3 (T020 onward),
  Phase 4 (T030), Phase 5 (T040) can proceed in parallel. Phase 6 (T050) waits on
  Phase 2. Phase 7 (T060) can be drafted at any time; T061/T062 run last.

**Non-negotiable**: all four fix families (FR-001, FR-002/003, FR-004, FR-005) MUST
ship together per plan §Sequencing — the failure-mode compose only breaks if all
four contributors are eliminated.

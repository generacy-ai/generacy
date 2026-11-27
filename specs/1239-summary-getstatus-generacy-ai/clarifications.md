# Clarifications: getStatus rename/copy entries break staging and silently lose phase work

**Issue**: #1239 | **Branch**: `1239-summary-getstatus-generacy-ai`

---

## Batch 1 — 2026-11-27

### Q1: FR-005 — downstream behavior of a surfaced staging/commit error

**Context**: FR-005 says a genuine staging/commit error in `commitAndPush` SHOULD surface "as a distinct, visible outcome rather than being swallowed as `no-changes`", and the spec notes the scope is to be confirmed in clarify. Today the catch at `pr-manager.ts:275-282` logs a warning and returns `{ kind: 'no-changes' }`, and the phase loop treats that as success-with-nothing-to-push. The outcome union already has a precedent for a caller-visible abort: `{ kind: 'refused' }` (PR #1052) stops the workflow. What the phase loop should *do* with a new error outcome decides whether this PR touches phase-loop control flow or only observability. Note a hard phase failure triggers a retry from a fresh checkout, which also discards the working tree — so failing the phase buys visibility, not work preservation; the actual work loss is fixed by FR-001/FR-002.

**Question**: When `commitAndPush` hits a genuine staging or commit error, what should the phase loop do with the new distinct outcome?

**Options**:
- A: Treat it like `refused` — abort the phase visibly (phase fails with a commit/push error reason; operator sees it; retry policy applies)
- B: Observability only — new `{ kind: 'error' }` outcome is logged/emitted prominently (e.g. warning with error kind in the phase result), but the phase loop continues as today (non-fatal)
- C: Defer FR-005 entirely to a follow-up issue; this PR fixes only the `getStatus()` parsing (FR-001–FR-004)

**Answer**: A — Treat it like `refused`: abort the phase visibly (the phase fails with a commit-error reason the operator can see), and the normal retry policy applies. Rationale: for `implement`, option B still ends in a failed phase — the product-code guard fails it as `no-product-code-changes` with "Own-commit files: []", the misleading symptom this issue reports — so B makes the run harder to debug without keeping it alive. A gives the failure its real reason, reuses the existing `refused` handling in the phase loop, and matches the goal of turning silent work loss into a visible failure. (Answered by @christrudelpw via GitHub, 2026-11-27)

---

### Q2: FR-005 — which failures inside commitAndPush get the distinct outcome

**Context**: The swallowing `try/catch` wraps the *entire* `commitAndPush` body: status read, staging, commit, agent-context revert bookkeeping, remote-branch queries, the push guard, and the push itself (`pr-manager.ts:131-283`). US2/FR-005 talk about "staging or commit" errors specifically, but a push failure or remote-query failure in the same body is equally collapsed into `no-changes` today. Narrow coverage keeps push best-effort (its failure modes — transient network, missing remote — are more routine); broad coverage makes every silent collapse observable but changes behavior for failure modes unrelated to this bug.

**Question**: Should the distinct error outcome cover only staging/commit failures, or any failure currently swallowed by the `commitAndPush` catch (including push and remote-query errors)?

**Options**:
- A: Staging/commit only — wrap stage+commit narrowly; push/remote-query failures keep today's non-fatal log-and-`no-changes` behavior
- B: Whole body — any throw inside `commitAndPush` yields the distinct error outcome instead of `no-changes`

**Answer**: A — Staging/commit only: wrap `getStatus` → `stageFiles` → `commit` narrowly. Push and remote-query failures keep today's non-fatal log-and-`no-changes` behavior. Rationale: once the commit exists locally, a failed push loses nothing — the next `commitAndPush` sees it through the `hasUnpushed` check (`getCommitsBetween`) and pushes it, so keeping push best-effort costs no work and transient network errors don't fail phases. Stage/commit failures are the only kind that lose work, which is this bug. The narrow scope also leaves the push-guard/`refused` paths untouched. (Answered by @christrudelpw via GitHub, 2026-11-27)

---

### Q3: Verification depth for SC-001 (rename-only phase commits its work)

**Context**: SC-002/SC-003 are explicitly unit-level (`gh-cli.get-status` tests). SC-001's measurement is "Repro scenario: phase with `git mv` produces a commit containing the renamed paths" — ambiguous between a manual one-time verification and an automated test. An automated end-to-end check would exercise `getStatus → stageFiles → commit` against a real temp git repo containing ` M`/`R `/`RM` entries (the observed failure shape), which pins the cross-package contract (workflow-engine parsing feeding orchestrator staging) rather than just the parser.

**Question**: Does SC-001 require an automated test exercising the stage→commit path against a real git repo with rename entries, or are unit tests on `getStatus()` parsing plus updated `pr-manager` mock-level tests sufficient?

**Options**:
- A: Unit-level is sufficient — `getStatus()` parsing tests over real/simulated porcelain output plus existing `pr-manager` test updates; SC-001 verified once manually
- B: Add an automated integration-style test — temp git repo with `git mv` + modifications, assert `getStatus()` output stages and commits cleanly end-to-end

**Answer**: B — Add an automated test on a temp git repo that does `git mv` plus a modification (giving `RM`, `R ` and ` M` entries), checking that `getStatus()` → `stageFiles()` → `commit()` makes a commit containing both the source and destination paths. Rationale: the bug lived in the contract between the parser and staging, which mock-level `pr-manager` tests cannot see — mocks return clean path arrays, which is how the `old -> new` string got through. The package already has a test against a real temp repo (`gh-cli.revert-paths.test.ts`), so this is cheap and follows an existing pattern. (Answered by @christrudelpw via GitHub, 2026-11-27)

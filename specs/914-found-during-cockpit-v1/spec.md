# Feature Specification: orchestrator: pre-phase base-merge runs before every spawned command — second invocation wipes node_modules installed by the pre-validate step; behind-main branches always fail validate 127

**Branch**: `914-found-during-cockpit-v1` | **Date**: 2026-07-11 | **Status**: Draft

## Summary

Found during the cockpit v1.5 auto-mode integration smoke test (generacy-ai/tetrad-development#92), finding #54 — snappoll full-epic run.

## Observed

Any branch that is **behind main** fails validate with `exit 127` (`vitest: not found`) no matter how many times it is requeued — because the pre-phase base-merge hook (#864) runs **before each spawned command in the validate cycle**, and its cleanup wipes the dependencies the install step just installed.

Worker-log sequence for snappoll#4 (workerId d874dd03, 22:42Z), a pre-scaffold branch:

1. `Base-merge: ephemeral merge succeeded (no commit)` → workspace tree now has the scaffold.
2. `Spawning pre-validate install command` → `npm ci` **succeeds** (14.9s, real install, node_modules populated).
3. `Base-merge: starting` **again** (second pre-phase hook, before the validate command): `performBaseMerge` resets the uncommitted ephemeral merge away — the tree reverts to the branch's own state, whose committed `.gitignore` (pre-scaffold) does **not** ignore `node_modules` — then runs `git clean -fd` (base-merge.ts:107), which now deletes `node_modules` as untracked non-ignored, then re-merges.
4. `Spawning validation command` → dies in 126ms: `sh: 1: vitest: not found`, exit 127.

The failure is invisible as such: the alert says only "vitest: not found", the operator/auto session diagnosed "branch isn't base-synced", and the only working remediation was a **manual committed** merge of origin/main into the branch (after which the second hook's merge is a no-op, nothing is reset, `.gitignore` is committed, and validate passes — which is exactly why the workaround "worked" and masked the real mechanism). Requeue/resume alone is structurally futile for this state, and this will hit the **first phase of every epic** on any project whose scaffold lands as an issue (sibling branches all fork pre-scaffold).

## Fix

Run the pre-phase base-merge **once per phase execution cycle**, before the install step — not before every spawned command. The install and validate commands must run against the same merged tree. (Independently defensible hardening: the ephemeral-merge cleanup should not `git clean -fd` between commands of the same cycle; but hoisting the hook makes the mid-cycle clean unreachable, which is the one-mechanism fix.)

## Regression tests

- Fixture: branch behind base, branch's `.gitignore` lacks `node_modules`, base adds it; validate cycle = install → validate. Assert exactly **one** base-merge invocation per cycle and that validate sees the installed toolchain (no exit-127).
- Fixture: branch up-to-date with base — unchanged behavior.
- Assert install-step artifacts (untracked, ignored-by-merged-base) survive to the validate command.


## User Stories

### US1: Behind-main branches pass validate after install without stranding

**As a** cockpit auto-mode operator (or a developer whose feature branch was forked before a base-branch scaffold landed),
**I want** the pre-phase base-merge hook to run exactly once per validate cycle, before the pre-validate install step, so that dependencies installed by `npm ci` survive to the validate command,
**So that** validate no longer dies with `exit 127` (`vitest: not found`) on any branch that is behind main, and requeue/resume are not structurally futile for this state.

**Acceptance Criteria**:
- [ ] For a branch behind base whose `.gitignore` (committed) does NOT ignore `node_modules` but base's does, a validate cycle (`install → validate`) invokes `performBaseMerge` **exactly once** — before install — not before validate.
- [ ] `node_modules` populated by the pre-validate install command survives to the validate command's spawn (no intervening `git reset --hard` / `git clean -fd`).
- [ ] The validate command runs against the same merged worktree the install ran against (identical `HEAD`, identical index state, identical untracked-file set for install-produced artifacts).
- [ ] Requeue/resume of a validate failure on a behind-main branch is no longer structurally blocked by the double-merge cleanup — a re-run reproduces the same single-merge, install-then-validate sequence.

### US2: Up-to-date branches see no behavior change

**As a** cockpit auto-mode operator whose branch is already up-to-date with base,
**I want** the hoisted single-invocation base-merge to preserve existing behavior on the happy path,
**So that** the fix does not regress branches that were passing validate today.

**Acceptance Criteria**:
- [ ] For a branch up-to-date with base, the validate cycle produces the same phase result and side-effects as today (no additional resets, no changed commit topology, no new log lines beyond the removed second invocation).
- [ ] Existing base-merge conflict paths (`{ ok: false, conflictedPaths }`) continue to abort the phase in the same way at the single hoisted call site.
- [ ] Implement-phase base-merge behavior (committed merge, per #864 FR-013) is untouched by this fix — only the pre-validate/validate ephemeral flow changes.

### US3: Silent failure mode is eliminated from the alerting surface

**As a** cockpit auto-mode operator triaging a validate failure,
**I want** validate failures on behind-main branches to stop presenting as `sh: 1: vitest: not found` / exit 127,
**So that** I do not misdiagnose "branch isn't base-synced" and waste cycles manually merging origin/main into the branch as the only working remediation.

**Acceptance Criteria**:
- [ ] After the fix, on the regression fixture from US1, the alert produced by a validate cycle is not `exit 127` — either validate passes cleanly, or the failure represents a genuine test/toolchain failure with the correct exit signal, not a phantom dependency-missing error.
- [ ] Operator-visible remediation for a legitimately red validate no longer requires a manual `git merge origin/main` on the feature branch to unstick the pipeline.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The validate phase MUST invoke the pre-phase base-merge hook exactly once per phase execution cycle, before the pre-validate install step runs. The second invocation (currently at `phase-loop.ts:311-325`, immediately before the validate command spawn) is removed. | P1 | Single-mechanism fix — hoisting the hook makes the mid-cycle clean unreachable by construction. |
| FR-002 | Pre-validate install artifacts (untracked, ignored-by-merged-base) MUST survive from the install command's exit to the validate command's spawn, without any intervening `git reset --hard` / `git clean -fd`. | P1 | The `node_modules` symptom is the observable; the invariant is broader — install → validate is one cycle sharing one worktree. |
| FR-003 | When the single hoisted base-merge fails with a conflict, the phase MUST abort in the same way it does today when either the current first or second invocation reports a conflict — no new failure modes, no new evidence shape. | P1 | Preserves existing conflict-handling contract from #864. |
| FR-004 | The implement-phase base-merge (committed, per #864 FR-013) MUST NOT be affected by this fix. Only the pre-validate/validate ephemeral flow (`runPreValidateBaseMerge` call sites) changes. | P1 | Blast radius constraint. |
| FR-005 | Regression coverage MUST include: (a) branch behind base + branch `.gitignore` lacks `node_modules` + base adds it → validate cycle asserts exactly one `baseMergeRunner` invocation and that validate sees the installed toolchain (no exit 127); (b) branch up-to-date with base → unchanged behavior; (c) install-step artifacts (untracked, ignored-by-merged-base) survive to the validate command. | P1 | Fixtures verbatim from the issue's "Regression tests" section. |
| FR-006 | The fix MUST ship as a single atomic PR that modifies `phase-loop.ts` (call-site hoist) and adds the regression fixtures. No changes to `base-merge.ts`'s internals (reset / clean / fetch / merge sequence). | P2 | Scoping decision — the reset-and-clean inside `performBaseMerge` is defensible on its own; the fix mechanism is at the call-site level. |
| FR-007 | [NEEDS CLARIFICATION] When the pre-validate install command is absent (`config.preValidateCommand` unset), does the single hoisted base-merge still run before the validate command spawn, or is it skipped entirely for that variant? Today the code runs a base-merge before install (when install is present) and another before validate; if install is absent the current code still runs a base-merge before validate. Post-fix, ensure the "no install command" case still merges once before validate. | P1 | Edge case for phases without a `preValidateCommand`. |
| FR-008 | [NEEDS CLARIFICATION] Is a "long-running validate" edge case in scope where base advances *between* install completion and validate spawn on the same cycle? Today the double-merge would re-sync (destructively); the fix intentionally accepts a slightly staler tree at validate time in exchange for install-artifact survival. Confirm this trade-off is acceptable or spec a different mechanism (e.g. keeping install-produced paths across a re-merge). | P2 | The issue's "one-mechanism fix" framing implies this is the accepted trade-off; recording as clarification for the plan phase. |
| FR-009 | Log lines MUST make the fix visible: a single `Base-merge: starting` per validate cycle (currently two per cycle on behind-base branches), matched to a single `Base-merge: ephemeral merge succeeded (no commit)` or conflict result. | P2 | Observability signal — makes the "one per cycle" contract auditable in worker logs. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Snappoll-incident regression fixture (branch behind base, branch `.gitignore` lacks `node_modules`, base adds it, install → validate cycle) invokes `performBaseMerge` exactly once. | 1 invocation per validate cycle | Unit test in `phase-loop.test.ts` with an injected `baseMergeRunner` spy that counts calls. |
| SC-002 | Validate command on the SC-001 fixture sees `node_modules` populated at spawn time. | 0 exit-127 failures | Integration-style test spawns validate against a worktree where install just wrote `node_modules/.bin/vitest`; assert the file is still present at validate spawn. |
| SC-003 | Up-to-date-with-base branch regression fixture produces the same phase result and same call sequence as the pre-fix code minus the removed second invocation. | 100% (deterministic) | Snapshot test on the phase-loop invocation trace for the up-to-date-branch case. |
| SC-004 | Implement-phase base-merge behavior is unchanged. | 0 test failures in the implement-phase base-merge suite | Existing `base-merge.test.ts` and `phase-loop.test.ts` implement-phase cases pass unmodified. |
| SC-005 | Operator-visible remediation for a behind-main branch to pass validate no longer requires a manual `git merge origin/main` on the feature branch. | 0 manual-merge remediations required in the smoke-test fixture | Auto-mode smoke test rerun (or equivalent scripted repro) of the snappoll#4 sequence passes validate without operator intervention. |
| SC-006 | Log-line count for `Base-merge: starting` per validate cycle drops from 2 to 1 on behind-base branches. | 1 (was 2) | Log-scan assertion on the worker-log fixture from the regression suite. |

## Assumptions

- The current double invocation is unintentional — `runPreValidateBaseMerge` was added at both call sites in #864 defensively, and hoisting to a single call is a behavioral fix, not an architectural change.
- `performBaseMerge`'s internal `git reset --hard origin/<branch>` + `git clean -fd` sequence (base-merge.ts:104-107) is correct on its own; the fault is exclusively that this sequence runs *between* two commands of the same phase cycle, not that the sequence itself is wrong.
- The single hoisted invocation's ephemeral merge (`opts.commit: false`) will persist for the duration of both spawned commands (install and validate) because no other code path between them touches `git reset` / `git clean`. Confirmed by inspection of `phase-loop.ts:255-332`.
- Long-running validate races (base advances between install and validate on the same cycle) are rare enough that a slightly staler validate tree is preferable to install-artifact loss. Recorded in FR-008 for clarification.
- Regression fixtures need only exercise the phase-loop's validate branch; no orchestrator-level end-to-end fixture is required.

## Out of Scope

- Any change to `performBaseMerge`'s internal reset/clean/fetch/merge sequence in `base-merge.ts`. The independently defensible hardening ("ephemeral-merge cleanup should not `git clean -fd` between commands of the same cycle") is explicitly acknowledged in the issue as *independent* — the call-site hoist is the one-mechanism fix and is sufficient.
- Changes to the implement-phase base-merge path (committed merge, #864 FR-013).
- Changes to base-ref derivation (`resolveBaseRef` / `resolveBaseBranch`) or the fetch step.
- New failure modes, evidence shapes, or alert copy — the fix converts a bug into a non-bug on the happy path; existing failure paths for legitimate conflicts / test failures / etc. are unchanged.
- Scaffolder or `.gitignore`-provisioning changes on downstream projects. The bug's frequency multiplier is that scaffolds land as issues and sibling branches fork pre-scaffold, but fixing scaffolding is not this issue's remit — this issue fixes the orchestrator so it stops corrupting the install-then-validate contract regardless of what the branch's `.gitignore` looks like.
- Documentation of the double-invocation history in `base-merge.ts` beyond a code comment on the removed call site.

---

*Generated by speckit*

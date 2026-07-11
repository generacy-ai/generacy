# Clarifications

## Batch 1 — 2026-07-11

### Q1: Pre-validate install command absent (FR-007)
**Context**: FR-007 is flagged `[NEEDS CLARIFICATION]`. Today the code runs a base-merge before the pre-validate install command *and* another before the validate command; if `config.preValidateCommand` is unset the second call still runs before validate. Post-fix, when a phase has no `preValidateCommand`, there is no install step to hoist the merge *before* — so we need an explicit rule for what "once per cycle, before install" collapses to when install is absent. This affects the location of the single call site.
**Question**: When `config.preValidateCommand` is unset (phase has only a validate command), where does the single hoisted base-merge run?
**Options**:
- A: Run the single base-merge before the *first* spawned command of the cycle — install if present, validate otherwise. One call site, guarded by "have I merged this cycle yet?" — semantically "once per cycle, before any spawn."
- B: Run the single base-merge before validate specifically when install is absent; when install is present, run before install. Two call sites in code, mutually exclusive at runtime.
- C: Skip the base-merge entirely when install is absent — validate runs against the un-merged branch tree. Preserves "install and validate share one tree" trivially by having no install to protect.

**Answer**: A — single call site before the cycle's first spawned command, guarded by "merged this cycle yet?". That's "once per cycle" stated as code. B is A with a duplicated call site; C is disqualified outright — skipping the merge when install is absent abandons the merge-preview semantics that are pre-validate base-merge's entire purpose (validate must test the merged result, #864).

### Q2: Long-running validate + base-drift trade-off (FR-008)
**Context**: FR-008 is flagged `[NEEDS CLARIFICATION]`. Today the double-merge would re-sync (destructively) if base advanced between install completion and validate spawn on the same cycle; the fix intentionally accepts a slightly staler validate tree in exchange for install-artifact survival. The issue's "one-mechanism fix" framing implies this is the accepted trade-off, but the plan phase needs an authoritative disposition — the answer determines whether any drift-detection or drift-mitigation code lands in scope.
**Question**: Is any base-drift-between-install-and-validate handling in scope for this fix?
**Options**:
- A: Out of scope — accept the slightly-staler validate tree; no drift detection, no mid-cycle re-merge. This is the "one-mechanism fix" framing verbatim; the trade-off is the whole point.
- B: In scope, detection only — at validate spawn, log a `warn` if `origin/<base>` advanced since the hoisted merge, but do not re-merge. Operator-visible signal, zero behavioral change.
- C: In scope, mitigation — re-merge before validate but preserve install-produced paths across the merge (requires a mechanism to stash-and-restore untracked ignored-by-merged-base files).

**Answer**: A — out of scope; accept the staler tree. The drift window is the install duration (seconds to minutes), and cross-cycle staleness already has an owner: #892's re-validate-on-base-advance re-runs validate when base moves. Mid-cycle re-merge (C) is a rebuild of the exact bug this issue removes; B's warn signals a state with no operator action attached.

### Q3: Same-phase retry re-merge semantics
**Context**: Worker-level retries can re-run a validate phase after failure (e.g., transient network failure in npm ci, retryable validate exit). The spec's "once per phase execution cycle" wording does not define whether a *retry* of the same phase is (i) the same cycle (no re-merge) or (ii) a new cycle (fresh pre-install merge). This affects retry idempotency guarantees and log-line count assertions in FR-009 / SC-006. A wrong choice reintroduces the very destructive-clean-between-commands bug on the retry path.
**Question**: When the validate phase is retried within the same worker execution (before returning to the phase loop's outer dispatch), does the pre-phase base-merge re-run?
**Options**:
- A: A retry re-runs from the same hoisted call site — one merge per retry attempt (i.e., one merge per install→validate pair). Consistent with "once per cycle" if a retry is defined as a new cycle. Simplest to implement (retry loop lives above the hoisted call site).
- B: A retry re-uses the merged tree from the initial attempt — no second merge on retry within the same phase execution. Tightens SC-006 to "1 merge per phase invocation regardless of retries." Requires the retry loop to sit *inside* the hoisted-merge scope.
- C: A retry re-runs install but not the merge — merge is once per phase invocation, install re-runs on retry (matches npm ci's own transient-failure model), validate re-runs after each install.

**Answer**: A — a retry is a new cycle; the install→validate pair re-runs from the hoisted call site, one merge per attempt. The invariant that must survive any answer here is: *a merge may only ever precede an install (or the cycle's first command), never sit between install and validate.* A enforces that mechanically by putting the retry loop above the hoisted site — the pair always travels together, each attempt gets a fresh merge (harmlessly picking up base advances), and SC-006's counting stays simple: merges == attempts. B and C also preserve the invariant but buy nothing for their extra scope-threading.

### Q4: SC-005 test scope vs. Assumptions
**Context**: SC-005 requires "auto-mode smoke test rerun (or equivalent scripted repro) of the snappoll#4 sequence passes validate without operator intervention" — an orchestrator-level, end-to-end assertion. But the Assumptions section states "Regression fixtures need only exercise the phase-loop's validate branch; no orchestrator-level end-to-end fixture is required." These conflict; the plan phase cannot both add and not add an end-to-end fixture. The answer determines which test surfaces land in tasks.
**Question**: How is SC-005 discharged given the Assumptions constraint against orchestrator-level end-to-end fixtures?
**Options**:
- A: SC-005 is discharged by the SC-001 + SC-002 unit-level fixtures alone — "equivalent scripted repro" is interpreted as the unit-level phase-loop fixture; no orchestrator-level rerun ships. Drop the smoke-test wording from SC-005; keep the "0 manual-merge remediations" target as an implicit outcome of SC-001+SC-002.
- B: SC-005 stands as written and the Assumption is relaxed — add one orchestrator-level fixture that scripts the snappoll#4 sequence (behind-base branch, pre-scaffold `.gitignore`, install → validate, no operator intervention). Blast radius grows one file.
- C: SC-005 is discharged by a manual smoke-test rerun tracked out-of-band (e.g., a checklist item in the PR body, verified by the operator before merge), not by an automated test.

**Answer**: A — SC-005 is discharged by the SC-001/SC-002 unit fixtures; reword it to say so. One note keeps this honest: the true end-to-end verification is the next smoke-test epic, whose P1 scaffold-plus-siblings phase reproduces the snappoll#4 sequence by construction — that run happens as standing practice (generacy-ai/tetrad-development#92) and its ledger records the result post-merge. That gets the e2e evidence without blocking the PR on a manual checklist (C) or hand-building an orchestrator-level fixture (B) for a sequence the ongoing test program exercises for free.

### Q5: Fix locality across phases
**Context**: The bug reproduces on the validate phase; FR-004 explicitly protects the implement phase's committed-merge flow. But `phase-loop.ts` may have similar pre-command hooks for other phases (specify/plan/tasks) where an install-then-command shape *could* exhibit the same double-merge-clean bug in the future. The spec does not say whether the fix is a narrow per-phase branch removal or a general "at most once per cycle" rule that immunizes other phases prophylactically. This determines the shape of the change in `phase-loop.ts` and the regression fixture matrix.
**Question**: Is the fix scoped narrowly to the validate phase, or does it generalize to any phase with a pre-command hook?
**Options**:
- A: Narrow — modify only the validate branch of `phase-loop.ts`; remove the second `runPreValidateBaseMerge` call at lines 311-325 and nowhere else. Other phases with pre-command hooks are inspected but not touched. Regression fixtures cover validate only.
- B: General — restructure `phase-loop.ts` so any phase's pre-command hooks call base-merge at most once per cycle via a shared "already merged this cycle?" guard. Regression fixtures cover validate plus at least one other phase for symmetry.
- C: Narrow now, generalize later — validate-only fix in this PR (matches FR-006's "single atomic PR that modifies phase-loop.ts"), file a follow-up issue for the general "at most once per cycle" rule if the same shape appears elsewhere. Regression fixtures cover validate only; add a code comment at the removed site pointing at the follow-up.

**Answer**: B — the general once-per-cycle guard. This is the same change Q1-A already implies: hoisting to a single guarded call site at cycle start *is* the general rule — there is no cheaper narrow variant to prefer, since A (delete the second call) still leaves "don't reintroduce it" as convention rather than structure. B stays inside phase-loop.ts (FR-006's atomic-PR constraint holds) and immunizes any future phase that grows an install-then-command shape. Fixtures: validate plus one symmetry case.

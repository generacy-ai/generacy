# Clarifications

## Batch 2026-08-21

### Q1: Reconciliation baseline vs. already-resolved FRs
**Context**: The spec anchors line references at develop `155b3464` (= #1136 closeout). This branch was actually cut from a newer base (`ea0b2437`, = #1161) into which #1156, #1160, and #1161 have since merged. Those merges already resolved several stale-comment premises: FR-005's target comment "#1124 will supply the reader" no longer exists at `claude-cli-worker.ts` (the reader was wired in #1156); FR-007's `ciWaitTimeoutMs` comment at `worker/config.ts` already documents the per-workflow override precedence accurately (#1160); and FR-006's `remediateTrigger` doc now sits at `phase-loop.ts:132-139` describing only the *undefined default* as dead (a concrete trigger did land in #1124). Following the FR line numbers literally would edit whatever now occupies those regions.
**Question**: How should FRs whose premise is already resolved at current branch HEAD be handled?
**Options**:
- A: Re-anchor the whole audit to current branch HEAD. Treat any FR whose cited inaccuracy is already gone (currently FR-005, FR-007, and the "concrete triggers land later" clause of FR-006) as verify-and-skip no-ops, note them resolved in the PR, and only change what is still inaccurate. (Recommended)
- B: Force each FR's edit literally, rewording whatever comment now occupies the cited region to satisfy the acceptance-criteria wording verbatim.
- C: Drop all three stale-comment FRs (FR-005–FR-007) from scope and ship only the doc-facing (FR-001–FR-004) and enumeration (FR-008–FR-011) FRs.

**Answer**: *Pending*

### Q2: `WAITING_PIPELINE_ORDER` insertion positions (FR-008)
**Context**: In `precedence.ts:26` earlier index wins, so the position of the two new gates determines which pause cockpit surfaces when labels coexist. The list today ends with the review pipeline (`waiting-for:spec-review` … `waiting-for:implementation-review`, `waiting-for:manual-validation`). `remediation-limit` is a review-loop pause; `ci` is the final merge-readiness pause.
**Question**: Where should `waiting-for:remediation-limit` and `waiting-for:ci` be inserted?
**Options**:
- A: `waiting-for:remediation-limit` immediately after `waiting-for:implementation-review`; `waiting-for:ci` at the very end (after `waiting-for:manual-validation`). (Recommended)
- B: Both at the end, in the order `waiting-for:remediation-limit` then `waiting-for:ci`.
- C: Other — specify the exact ordering in the answer.

**Answer**: *Pending*

### Q3: `STAGE_COMPLETE_PIPELINE_ORDER` insertion positions (FR-009)
**Context**: `precedence.ts:71` is "latest-phase-wins" — labels closer to the workflow end come first (lower index wins). The list currently starts `completed:implementation-review, completed:implement, completed:tasks-review, …` and has no `completed:validate` today. In the flow, `review` and `remediate` run between `implement` and `validate`, and `validate` is the last phase.
**Question**: Where should `completed:validate`, `completed:review`, and `completed:remediate` be inserted?
**Options**:
- A: Workflow-end-first: `completed:validate`, `completed:implementation-review`, `completed:remediate`, `completed:review`, `completed:implement`, … (validate at the very top; review/remediate between implementation-review and implement). (Recommended)
- B: `completed:validate` at the top; `completed:review`/`completed:remediate` immediately after `completed:implement`.
- C: Other — specify the exact ordering in the answer.

**Answer**: *Pending*

### Q4: FR-011 seeded-round "mismatch" — actual target
**Context**: FR-011 cites a `round: 0` vs `round: 1` mismatch in `seed-aware-review-executor.ts`. At current HEAD the executor computes `const round = (prior?.round ?? 0) + 1` and stamps *both* each finding's `round` field and the artifact's top-level `round` to that same value — there is no visible `round: 0` anywhere. #1161's artifact collapse may have already unified them.
**Question**: What is the intended FR-011 change?
**Options**:
- A: The mismatch is already resolved at HEAD (single `round` source); treat FR-011 as verify-and-skip and note it resolved. (Recommended)
- B: A real mismatch remains — specify the exact field(s) and the intended value in the answer.

**Answer**: *Pending*

### Q5: FR-004 replacement wording for "retired"
**Context**: `review-remediate-migration.md:140-142` says `waiting-for:remediation-limit` "replaces the retired `blocked:stuck-feedback-loop` dead-end." The label is live on the default flag-OFF PR-feedback path (`pr-feedback-handler.ts`), so "retired" is inaccurate.
**Question**: How should the passage be corrected?
**Options**:
- A: Reword to describe `blocked:stuck-feedback-loop` as the legacy pre-epic (flag-OFF) bounded stop that still applies when the review phase is disabled, and frame `waiting-for:remediation-limit` as the resumable equivalent on the flag-ON path — dropping the "retired"/"replaces" framing. (Recommended)
- B: Delete the "This replaces the retired … terminal block." sentence entirely, leaving only the resumable-pause description above it.

**Answer**: *Pending*

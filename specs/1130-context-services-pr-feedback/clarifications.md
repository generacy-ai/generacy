# Clarifications

## Batch 1 — 2026-08-20

### Q1: Remediate entry mechanism
**Context**: `remediate` is an off-sequence phase entered only via `remediateTrigger(context)` after a successful `review` phase, where the trigger reads the findings-artifact verdict (`phase-loop.ts:124,1270`). The monitor today enqueues `command: 'address-pr-feedback'` (`pr-feedback-monitor-service.ts:529`) into the legacy fixer. FR-003 requires external feedback to drive the *shared* remediate loop instead. The exact entry path is unspecified and blocks implementation.
**Question**: How does external trusted feedback cause the worker to enter the shared review/remediate loop?
**Options**:
- A: Monitor synthesizes the findings artifact from external feedback, then enqueues a `review`-phase re-entry; the existing review→remediate seam takes over (verdict = changes-required → `remediateTrigger` fires).
- B: Add a new enqueue path/command that seeds the artifact and enters `remediate` directly, bypassing a fresh `review` pass.
- C: Monitor enqueues a `review`-phase re-entry with no seeded artifact; the engine review executor re-derives findings from the PR itself.

**Answer**: A — Monitor synthesizes the findings artifact from external feedback, then enqueues a `review`-phase re-entry; the existing review→remediate seam takes over (verdict = changes-required → `remediateTrigger` fires). Rationale: `remediate` is off-sequence and reachable only via `remediateTrigger` after a successful `review`, and even the `remediation-limit` gate resumes at `review`, never at `remediate`; seeding the artifact and re-entering at `review` keeps one code path and avoids a fresh diff review silently dropping body-only asks.

### Q2: Findings-artifact synthesis source for external feedback
**Context**: FR-004 requires findings synthesized from BOTH inline threads AND review bodies (preserving `pr-feedback-handler.ts:249-360` dual-source behavior). The review executor (#1124) writes the artifact from a CLI agent pass, but external GitHub feedback is not agent-authored. Who builds the artifact entries from external threads/bodies must be decided.
**Question**: What component synthesizes the findings artifact from external GitHub feedback?
**Options**:
- A: The monitor (or a small mapper it calls) maps each unresolved external thread + review body directly into findings entries.
- B: A worker-side review-executor pass ingests the external threads/bodies as prompt context and writes findings.
- C: Reuse the legacy fixer's dual-source parser (`pr-feedback-handler.ts:249-360`) as the extraction step, feeding results into the artifact.

**Answer**: C — Reuse the legacy fixer's dual-source parser (`pr-feedback-handler.ts:249-360`) as the extraction step, feeding results into the artifact. Rationale: FR-004 requires preserving the dual-source behavior, and that logic already does trust-filtered extraction from inline threads AND review bodies worker-side where the checkout and trust config live; the monitor is an orchestrator service with no checkout and cannot write the checkout-local sidecar.

### Q3: What resets the remediation counter (FR-006)
**Context**: FR-006 says human intervention MUST reset the remediation counter but leaves "human intervention" undefined. The existing counter-reset site (#1070 D-5) is Case C — all review threads resolved (`pr-feedback-monitor-service.ts:339-344`). The remediation cap lands on `waiting-for:remediation-limit`; the semantics of re-arming the budget determine whether a stuck PR can ever progress.
**Question**: What precisely constitutes the human intervention that resets the remediation counter?
**Options**:
- A: A new human review/comment submitted after the cap is hit (new external feedback = fresh budget).
- B: Operator removing the `waiting-for:remediation-limit` gate label.
- C: Full thread resolution (Case C — all threads resolved), matching the existing #1070 reset site.
- D: Any of the above resets the counter.

**Answer**: A — A new human review/comment submitted after the cap is hit (new external feedback = fresh budget). Rationale: the reset must be gated on genuine human action, authorship-based not content-based; "all threads resolved" is engine-triggerable and purpose-mismatched, and the cited #1070 site resets a different counter (`fixerTimeoutRetryCount`). This also rules out "any of the above".

### Q4: Mixed-thread handling (FR-010)
**Context**: A single unresolved thread can contain both engine-authored comments (marker-matched) and trusted-external human comments. The engine-exclusion filter (FR-001) and the trust filter (FR-002) both operate per-comment. The trigger decision for a mixed thread must be pinned down.
**Question**: How should a thread that mixes engine-authored and trusted-external comments be treated?
**Options**:
- A: Trigger — exclude a thread only when ALL its comments are engine-authored; any external trusted comment keeps the thread live.
- B: Exclude — an engine-authored marker anywhere in the thread suppresses it.

**Answer**: A — Trigger; exclude a thread only when ALL its comments are engine-authored; any external trusted comment keeps the thread live. Rationale: the existing handler already treats a thread as live if ANY comment is trusted, and FR-002 keeps human trust authorship-based and first-class; suppressing on any engine marker would silently drop a human's trusted reply to an engine finding.

### Q5: Legacy fixer disposition (FR-007)
**Context**: FR-007 allows either retiring `pr-feedback-handler.ts` or reducing it to a thin adapter. This is a P2 scope decision that determines how much of the legacy dual-source parsing, untrusted-notice, and disposition logic must be migrated vs. reused in place, and bounds the implementation surface.
**Question**: What is the target end-state for `pr-feedback-handler.ts`?
**Options**:
- A: Delete it entirely; migrate all still-needed dispositions into the shared remediate path.
- B: Reduce to a thin adapter that synthesizes findings + enqueues remediate, deleting the divergent dispositions (notably `blocked:stuck-feedback-loop`).
- C: Keep the handler; only remove `blocked:stuck-feedback-loop` and add engine-thread exclusion, deferring fuller retirement to a follow-up.

**Answer**: B — Reduce to a thin adapter that synthesizes findings + enqueues remediate, deleting the divergent dispositions (notably `blocked:stuck-feedback-loop`). Rationale: FR-007 permits an adapter, and the dual-source extraction is exactly what Q2 reuses; delete-entirely forces re-homing the parse and risks dropping body-only findings, while keeping the handler leaves a second live fix path violating "one loop, one code path".

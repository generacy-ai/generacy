# Clarifications — #845

## Batch 1 — 2026-07-07

### Q1: State-transition wording ("waiting-for:X → completed:X")
**Context**: The arrow-form phrasing appears in three operator-visible surfaces:
1. CLI stdout summary line (`advance.ts:178–181`), which FR-005 says MAY be kept as-is.
2. The manual-advance marker comment body (`manual-advance-marker.ts:30–31`), inherited from #830.
3. Public docs / CLI-surface / quickstart in #788.

Before this fix, the arrow accurately described the *label diff* — `advance` removed `waiting-for:X` and added `completed:X`. After this fix, `advance` no longer removes `waiting-for:X`, so an operator inspecting labels post-advance will see BOTH present. The arrow now describes a *state transition* completed at worker-resume time, not a label diff. That mismatch is the exact failure mode operators just hit (they concluded advance had done "nothing" because both labels sat there).

**Question**: How should the arrow-form wording be updated across these three surfaces?
**Options**:
- A: Keep wording as-is on all three surfaces — treat the arrow as state-transition semantics (FR-005 default; zero downstream changes).
- B: Update only the CLI stdout summary (e.g. `advanced ...: gate "X" marked complete (waiting-for:X preserved for resume)`); leave marker comment + docs unchanged.
- C: Update all three surfaces consistently (stdout + marker comment body + #788 docs) to phrasing that does not imply a label diff.
- D: Other (please specify).

**Answer**: C — update all three surfaces consistently. The arrow phrasing is indistinguishable from a label-diff claim to an operator staring at the labels tab, and a message that describes intent rather than effect is exactly how this smoke test got burned (advance reported success; nothing resumed; the message gave no clue the pair was supposed to persist). Suggested phrasing for all three: "completed:<gate> added — waiting-for:<gate> left in place for the worker to clear on resume". Option B leaves the marker comment — the surface that lives permanently in the issue thread — telling future readers the old story.

---

### Q2: `advance.ts` file-header comment scope (FR-009)
**Context**: `advance.ts:1–14` currently documents the happy path as a 3-step numbered list. FR-009 says the docs "MUST be updated to remove step 3 (the removeLabel step)". Simply deleting step 3 satisfies the letter of FR-009, but leaves future maintainers with no cue about *why* `waiting-for` is intentionally left in place — and this bug demonstrates the risk of "cleaning up" that appears to be dead code.

**Question**: What is the intended scope of the header-comment refactor?
**Options**:
- A: Delete numbered step 3 only. Header comment ends after step 2. (Minimal FR-009 satisfaction.)
- B: Delete step 3 AND add a one-line invariant note pointing to worker-side cleanup, e.g. `Note: Worker's resume path removes waiting-for:<gate> — do not remove it here (see #845).`
- C: Rewrite the header comment to emphasize the label-pair contract (poll-path resume requires BOTH labels present) rather than the numbered steps.
- D: Other (please specify).

**Answer**: C — rewrite the header around the label-pair invariant rather than the numbered steps. The steps framing is what invited the bug: a numbered recipe makes the absent removal look like an omission to complete, not a contract to respect. State it as: poll-path resume detection requires BOTH labels present (label-monitor-service returns no resume event for a completed:* without its waiting-for:*); the worker owns clearing waiting-for/completed/agent:paused on resume; do not remove labels here — see #845. That subsumes option B's one-liner and removes the structure that made step 3 look load-bearing.

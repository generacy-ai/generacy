# Clarifications: Cockpit classifier must not treat mid-pipeline `completed:*` labels as terminal

Feature: [#841](https://github.com/generacy-ai/generacy/issues/841)
Branch: `841-found-during-cockpit-v1`

---

## Batch 1 — 2026-07-07

### Q1: FR-003 tier landing

**Context**: FR-003 leaves open how the demoted mid-pipeline `completed:*` labels (e.g., `completed:specify`, `completed:plan`) rank when no higher-tier label is present. This decision determines whether the `CockpitState` union gains a new member and how `cockpit status` renders an issue that briefly carries only a demoted `completed:*` between phase transitions.

**Question**: Where should demoted `completed:*` labels rank when they are the sole workflow-signal label on an issue?

**Options**:
- A: New `stage-complete` tier ranked below `pending` — expands `CockpitState` union by one member; preserves "issue is between phases" as a distinct signal.
- B: Fold into `pending` — no union change; conflates "waiting for setup" with "just finished a phase".
- C: Fold into `unknown` — smallest diff; `classify()` no longer surfaces the "phase complete" signal at all when no other label is present.

**Answer**: *Pending*

### Q2: FR-002 encoding style

**Context**: FR-002 enumerates 3 terminal `completed:*` labels vs. ~13 demoted ones. `label-map.ts` can encode this either as two explicit hard-coded sets, or as a rule (explicit terminal set + everything else `completed:*` defaults to demoted).

**Question**: How should the terminal-vs-demoted split for `completed:*` labels be encoded in `label-map.ts`?

**Options**:
- A: Two explicit hard-coded sets (verbatim FR-002 enumeration). Author must update both when adding a new `completed:*` label; risk of a new label silently becoming `unknown` if forgotten. Fails loud on the *safe* side (never accidentally promotes a mid-pipeline label to terminal).
- B: Rule form — explicit set of terminal `completed:*`; every other `completed:*` demotes automatically. New `completed:*` labels default to demoted; safer for the classifier's dashboard-visibility goal, but risks silently reclassifying a future genuinely-terminal label the author forgot to add to the terminal set.

**Answer**: *Pending*

### Q3: New-tier name and TIER_RANK slot (only if Q1=A)

**Context**: If Q1 lands on option A, the added `CockpitState` union member needs a name and a slot in `TIER_RANK` (currently ends `pending: 4, unknown: 5`). `compareSourceLabels()` and every `TIER_RANK[state]` lookup depends on this slot.

**Question**: If Q1=A, what should the new state member be called, and where does it slot in `TIER_RANK`?

**Options**:
- A: `stage-complete`; rank 5 (between `pending` and `unknown`), with `unknown` moved to 6.
- B: `stage-complete`; rank 6 (below `unknown`), `unknown` stays at 5 — treats stage-complete as strictly lower-signal than unknown.
- C: Different name (please specify, e.g., `phase-complete`, `stale-completion`) and rank position.

**Answer**: *Pending*

### Q4: Intra-tier tie-break within the demoted `completed:*` set

**Context**: When multiple demoted `completed:*` labels are simultaneously present on an issue (e.g., `completed:specify` + `completed:plan` during a phase transition window), the classifier must pick one as `sourceLabel`. Every other non-`waiting` tier currently tie-breaks by `workflowLabelIndex` (position in `WORKFLOW_LABELS`).

**Question**: For source-label selection when multiple demoted `completed:*` labels co-occur (in whichever tier Q1 lands them), use the standard `workflowLabelIndex` tie-break?

**Options**:
- A: Yes — reuse the existing `workflowLabelIndex` tie-break for consistency with every other non-`waiting` tier. Winner is whichever demoted label appears first in `WORKFLOW_LABELS`.
- B: No — prefer the latest phase (e.g., `completed:plan` beats `completed:specify`) so the dashboard surfaces the most-recent milestone as the source label. Requires a custom order table analogous to `WAITING_PIPELINE_ORDER`.

**Answer**: *Pending*

---

*Managed by speckit `/clarify`.*

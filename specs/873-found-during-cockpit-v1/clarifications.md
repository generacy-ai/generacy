# Clarifications — #873

## Batch 1 (2026-07-09T02:57:52Z)

### Q1: Status render treatment for closed children
**Context**: FR-004 requires closed children to be visually distinct from open, actionable rows inside their phase group but explicitly defers the concrete treatment (glyph, colour, text) to the plan phase. The plan phase needs this decided so `renderStatus` / `buildStatusRow` / colour helpers can be sized. The issue text suggests `✓ merged/closed`.
**Question**: How should a closed child render in the plain-text `cockpit:status` output within its phase group?
**Options**:
- A: Prepend `✓` glyph and replace the state label with `merged/closed`, coloured green — matches the issue's suggested text verbatim
- B: Prepend `✓` glyph, keep phase-derived state label, apply a "dim" colour (grey) to the whole row so open rows visually pop
- C: Move all closed rows to a dedicated `— Done —` sub-section rendered above (or below) each phase group, leaving open rows under the phase header
- D: Prepend `✓` glyph, suffix the title with ` (closed)`, no colour change — minimal visual delta

**Answer**: A — `✓ merged/closed`, green, in place within the phase group. B keeps the stale label-derived state text on a closed row, which is exactly the residue this fix stops honoring — don't render it. C fragments the phase view; keeping done rows under their phase header is what makes `status` read as epic progress (P1: 3/3 ✓).

### Q2: Machine-readable "closed" signal in `StatusRow` / JSON envelope
**Context**: FR-006 offers three shapes for the machine-readable field JSON consumers use to detect closed-vs-open without re-parsing labels. Choice affects the JSON envelope contract (SC-002 asserts the envelope must expose this signal) and downstream consumers reading `renderJsonEnvelope`.
**Question**: Which shape should `StatusRow` carry?
**Options**:
- A: Add raw `issueState: 'OPEN' | 'CLOSED'` field to `StatusRow` (mirrors the snapshot type; caller derives their own `done` flag)
- B: Add derived `done: boolean` to `StatusRow` (single-purpose, hides the raw source data)
- C: Introduce a new `CockpitState` value (e.g. `'closed-done'`) — reuses the existing `state` field but expands the enum (touches `@generacy-ai/cockpit` types)
- D: Both A and B — carry raw `issueState` and derived `done` (small extra field, most consumer-friendly, no enum change)

**Answer**: A — raw `issueState: 'OPEN' | 'CLOSED'` on `StatusRow`. It mirrors the snapshot, bakes in no interpretation, and `done` is a one-expression derivation for any consumer. A derived boolean carried *alongside* the raw field (D) is two fields with an invariant between them — a drift surface for no gain — and C expands a shared enum in `@generacy-ai/cockpit` types, conflating GitHub issue state with the cockpit's label-derived classification tiers. Composes with Q4: the envelope stays raw-fields-only.

### Q3: Where to codify the "state dominates labels" invariant (FR-007)
**Context**: FR-007 asks the invariant "issue `state: closed` dominates any label-derived actionability tier" to be codified somewhere durable, and lists three candidate locations. Choice affects future refactors' ability to preserve the rule.
**Question**: Where should the invariant live?
**Options**:
- A: JSDoc comment on `isActionableSnapshot()` and on the status-row builder — cheapest, code-local, no shared home
- B: A note in `specs/873-found-during-cockpit-v1/contracts/` — durable, spec-adjacent, but disconnected from the code
- C: Extract to a shared helper (e.g. `isDoneSnapshot(snap)` in a new module) reused by both watch and status — single source of truth, one call site to grep for
- D: All three (comment at each guard site + contract note + shared helper) — belt-and-braces

**Answer**: C — extract `isDoneSnapshot(snap)` as a shared helper consumed by both the watch classifier and the status-row builder; the invariant ("issue `state: closed` dominates any label-derived actionability tier") lives in that helper's JSDoc, so option A comes free at the single place it can't go stale. Skip B: contract notes in completed spec folders are where invariants go to die — the durable homes are the code (this helper) and the label-protocol doc, not spec residue.

### Q4: Closed-because-not-planned vs closed-because-merged (FR-008)
**Context**: FR-008 states behaviour "MUST be identical for closed-because-merged and closed-because-not-planned" but explicitly flags this as a candidate `/clarify` question. GitHub exposes `closedReason` (`completed` for merged, `not_planned` for abandoned). Distinguishing them requires extending the snapshot data plane to carry `closedReason`.
**Question**: Should a `not_planned` child render identically to a merged child?
**Options**:
- A: Yes — identical treatment. Both are "done, not actionable." Matches spec's default position; keeps the snapshot type unchanged.
- B: No — distinguish text only. `merged` renders as `✓ merged/closed` (or whatever Q1 decides); `not_planned` renders as `✗ closed (not planned)`. Requires adding `closedReason?: 'completed' | 'not_planned'` to `IssueSnapshot` and the `gh` wrapper query.
- C: No — distinguish machine-readable signal only. Render text is identical, but the JSON envelope surfaces `closedReason` for downstream consumers. Same snapshot-plane cost as B, no render change.

**Answer**: B — distinguish the text: `✓ merged/closed` for `COMPLETED`, `✗ closed (not planned)` for `NOT_PLANNED`. A `✓` on abandoned scope misreports epic progress — an operator scanning status should not read cut work as delivered work. The cost is one `stateReason` field on `IssueSnapshot` plus the gh query addition, and once the field exists, surfacing it in the JSON envelope (option C's ask) is free — B subsumes C. Behavior for *actionability* stays identical (both are done, no suggestions); only the rendering differs.

# Research: Cockpit classifier `completed:*` demotion

**Feature**: #841 | **Branch**: `841-found-during-cockpit-v1`

## Decision log

### D1 — Encoding style: rule (Q2 → B)

**Decision**: `label-map.ts` encodes the split as an explicit set `TERMINAL_COMPLETED_LABELS = { 'completed:validate', 'completed:epic-approval', 'completed:children-complete' }`; the pattern `label.startsWith('completed:')` maps to `stage-complete` **unless** the label is a member of that set.

**Rationale**: The bug is asymmetric — the direction that produced #841 (a mid-pipeline `completed:*` silently promoted to `terminal` and hiding an actionable issue) is impossible under a rule where promotion is always an explicit act. The inverse failure mode (a future genuinely-terminal label forgotten under the rule form) fails safely: the issue just renders as `stage-complete` instead of `terminal`; nobody is misled about actionability.

**Alternatives considered**:

- Two explicit hard-coded sets (Q2 → A). Fails loud on the safe side but requires touching two constants for every new `completed:*` — the exact sort of two-places-to-update that decays over time.
- Regex or configurable list. Rejected: unnecessary flexibility; a 3-element frozen `Set` is the diff-minimal encoding.

### D2 — New tier `stage-complete` (Q1 → A)

**Decision**: Introduce a new `stage-complete` member of `CockpitState`.

**Rationale**: "A phase finished and nothing else is happening" is a real, distinct signal. Folding into `pending` (Q1 → B) would render a half-processed issue identically to a never-touched one; folding into `unknown` (Q1 → C) deletes the milestone marker entirely. The union widening is small and additive; consumers that don't recognise the new arm fall through to their default rendering (no crash).

**Alternatives considered**:

- Fold into `pending`. Rejected — semantic collision (Q1 → B).
- Fold into `unknown`. Rejected — deletes the signal (Q1 → C).

### D3 — Rank slot (Q3 → A)

**Decision**: `TIER_RANK.stage-complete = 5`; `TIER_RANK.unknown` moves from `5` to `6`. Full order (lower wins): `terminal:0 < error:1 < waiting:2 < active:3 < pending:4 < stage-complete:5 < unknown:6`.

**Rationale**: Recognised signals must outrank unrecognised ones. Placing `stage-complete` above `unknown` (Q3 → B) would let an arbitrary unmapped label beat a known milestone marker when both co-occur — the exact opposite of the "prefer the informative label" principle already baked into the ranking.

**Alternatives considered**:

- Rank 6 below `unknown` (Q3 → B). Rejected — see rationale.
- Different name (Q3 → C, e.g., `phase-complete`, `stale-completion`). Rejected: `stage-complete` matches the existing "stage" vocabulary in FR-003 and reads naturally in dashboard buckets.

### D4 — Intra-tier tie-break: latest-phase-wins (Q4 → B)

**Decision**: For the `stage-complete` tier, source-label selection uses a `STAGE_COMPLETE_PIPELINE_ORDER` array analogous to `WAITING_PIPELINE_ORDER`. The array orders demoted `completed:*` labels from **latest** phase to **earliest**; earlier index wins, so the most-recent milestone becomes `sourceLabel`.

**Rationale**: When two demoted `completed:*` labels co-occur (typical during phase-transition windows), the informative source label is the most recent milestone. The default `workflowLabelIndex` tie-break (Q4 → A) would surface the stalest one, which is exactly what a dashboard-visibility fix should avoid. The pattern is not novel — the `waiting` tier already uses the same machinery for pipeline-aware intra-tier ordering.

**Alternatives considered**:

- `workflowLabelIndex` tie-break (Q4 → A). Rejected — surfaces the stalest label; contradicts the "informative source label" goal.

### D5 — Terminal set membership

**Decision**: Terminal set = `{ 'completed:validate', 'completed:epic-approval', 'completed:children-complete' }`. Three members.

**Rationale**: Reconciles the spec (FR-001 mentions only `completed:validate`) with clarification Q2 context ("FR-002 enumerates 3 terminal `completed:*` labels vs. ~13 demoted ones") and current `label-map.ts` behaviour (the pre-existing D2 rule already treats `completed:epic-approval` and `completed:children-complete` as terminal). Demoting the two epic-rollup labels would regress the epic surface — an unintended blast radius. FR-001's "only completed:validate" is read as an oversimplification against the Q2-authoritative three-member set.

**Alternatives considered**:

- Strict single-member set `{ 'completed:validate' }`. Rejected — would newly-demote epic rollup states and change dashboard behaviour for closed epics.

## Implementation patterns

- **Mirror the `waiting`-tier pattern**: `STAGE_COMPLETE_PIPELINE_ORDER` is structurally identical to `WAITING_PIPELINE_ORDER`. `compareSourceLabels()` gains one more branch that delegates to the same "listed-beats-unlisted, then index compare" logic, then falls through to `workflowIndex` for unlisted labels. This keeps the two tiers uniform and lowers the cost of a future third pipeline-ordered tier.
- **Terminal set as a module-scoped frozen `Set<string>`**: `const TERMINAL_COMPLETED_LABELS = new Set(['completed:validate', 'completed:epic-approval', 'completed:children-complete'] as const);`. O(1) lookup; single source of truth; grep-friendly.
- **Union widening is additive**: `COCKPIT_STATES = [...prev, 'stage-complete']`; `CockpitState = typeof COCKPIT_STATES[number]`. `TIER_RANK` is a `Record<CockpitState, number>` so TypeScript enforces exhaustiveness — the compiler will flag the missing key until it's added.

## Sources / references

- `packages/cockpit/src/state/label-map.ts` — current pattern-fallback logic.
- `packages/cockpit/src/state/precedence.ts` — current `TIER_RANK` and `WAITING_PIPELINE_ORDER`.
- `packages/cockpit/src/state/classifier.ts` — dispatch loop.
- `packages/cockpit/src/types.ts` — `CockpitState` union.
- `packages/workflow-engine/src/actions/github/label-definitions.ts` (lines 44–60) — canonical list of every `completed:*` label.
- `packages/workflow-engine/src/actions/workflow/update-phase.ts` (lines 33–38) — phase → `completed:*` mapping (source of truth for the pipeline order).
- `docs/label-protocol.md` — rev 3 state table (assumed authoritative per spec Assumption 1; not directly consulted, no changes needed).
- Related issue: #839 startup sweep — has raw-label-scan workaround; simplifying it is out of scope for #841 (Assumption 4).

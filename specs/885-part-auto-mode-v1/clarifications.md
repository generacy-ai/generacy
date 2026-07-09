# Clarifications

## Batch 1 — 2026-07-09

### Q1: Event payload schema

**Context**: The spec shows `{"type":"phase-complete","phase":"<heading>", …}` with an ellipsis, but the ellipsis hides fields consumers (auto mode, README docs, tests SC-001..SC-008) need to lock in before implementation. The existing `CockpitEventSchema` (`packages/generacy/src/cli/commands/cockpit/watch/emit.ts`) requires `ts`, `repo`, `kind`, `number`, `event`, etc. — none of which map cleanly to synthetic aggregate events.

**Question**: What fields (beyond `type`, `phase`, and optional `initial: true`) MUST appear on the emitted `phase-complete` and `epic-complete` NDJSON events?

**Options**:
- A: Minimal — `type`, `phase` (phase-complete only), `initial?`, and `ts` (ISO-8601). No epic ref, no issue counts, no suggestion text in the payload. Consumers derive everything else from their existing state.
- B: Minimal + epic ref — Option A plus `epicRepo` (e.g. `owner/repo`) and `epicNumber` (issue number of the epic). Lets consumers correlate events without threading the CLI arg through their own state.
- C: Rich — Option B plus `closedRefs` (array of `{repo, number}` for the phase or whole epic), `totalCount`, and a `suggestion` string (the human-readable `all P1 — Foundation issues closed — suggested: /cockpit:queue …` / `epic complete 🎉` line).
- D: Other (please specify the exact field set).

**Answer**: *Pending*

### Q2: Assist rendering delivery

**Context**: The spec says (line 22): *"Assist rendering: suggestion lines, e.g. `all P1 — Foundation issues closed — suggested: /cockpit:queue <epic-ref> "P2 — Core functionality"`; `epic complete 🎉` for the terminal event."* — but doesn't specify where these lines go. `watch` writes NDJSON to stdout today and diagnostic strings to stderr. Auto mode (the primary consumer) parses stdout as NDJSON.

**Question**: How should the human-readable suggestion / "epic complete 🎉" lines be delivered?

**Options**:
- A: Stderr only — printed as plain-text lines to stderr alongside existing diagnostics; NDJSON payload on stdout stays machine-only. Auto mode ignores them; humans running `watch` interactively see them.
- B: Inline in the NDJSON payload — the suggestion text becomes a `suggestion: string` field on the same `phase-complete` / `epic-complete` event line (single output channel; consumers pick what they want).
- C: Separate NDJSON events — new event types `phase-complete-assist` / `epic-complete-assist` on stdout, one per synthetic aggregate event, carrying the human-readable text.
- D: Both — payload gets the suggestion inline (Option B) AND stderr echoes the human-readable line (Option A).

**Answer**: *Pending*

### Q3: Empty-phase handling

**Context**: A parsed epic can have a phase heading in its body with **zero** issue refs under it (edge case: authors write the heading before adding tickets). `ParsedPhase.refs` (`packages/cockpit/src/resolver/types.ts`) can be an empty array. The spec's aggregation rule ("last open issue in a phase transitions to closed") doesn't define behavior when the phase has no issues at all.

**Question**: How does an empty phase (heading present, `refs.length === 0`) contribute to aggregation?

**Options**:
- A: Trivially complete — counts as complete for `epic-complete` aggregation; emits a `phase-complete` event at startup with `initial: true` and never fires again.
- B: Trivially complete but silent — counts as complete for `epic-complete` aggregation; NEVER emits a `phase-complete` event (startup or transition). Only phases with ≥1 ref can fire the event.
- C: Blocks epic-complete — treated as incomplete indefinitely; `epic-complete` cannot fire until the phase has at least one ref and all its refs close.
- D: Other (please specify).

**Answer**: *Pending*

### Q4: Event ordering within a single poll cycle

**Context**: One poll cycle can produce multiple events simultaneously: existing per-issue events (`issue-closed`, `pr-merged`, `label-change`), new synthetic events (`phase-complete`, `epic-complete`), and multiple of each. Auto-mode consumers and the SC-005/SC-006 tests need deterministic ordering to reason about the terminal edge (`--exit-on-epic-complete` must exit **after** `epic-complete` is flushed, and consumers may want to see the last-in-phase `issue-closed` before the `phase-complete` it triggers).

**Question**: What ordering do consumers see for events emitted in the same poll cycle?

**Options**:
- A: Per-issue first, then aggregates in phase order, then `epic-complete` last — i.e. all `issue-closed`/`pr-merged`/`label-change` events for the poll, then `phase-complete` events in `parsed.phases` order, then `epic-complete` (if fired). `--exit-on-epic-complete` exits after the `epic-complete` line is flushed.
- B: Aggregates first, then per-issue — `epic-complete` first (if fired), then `phase-complete` in phase order, then per-issue events. (Auto mode gets its termination edge with minimum latency; humans see the summary first.)
- C: Interleaved by issue — for each newly-closed issue, emit its `issue-closed` immediately followed by any `phase-complete` it triggers, and finally `epic-complete` at the end of the poll. Multiple phases completing in one poll interleave with their triggering closures.
- D: Other (please specify the exact ordering rule).

**Answer**: *Pending*

### Q5: Epics with no phase structure

**Context**: An epic body may have zero phase headings — `parsed.phases.length === 0`. Status rendering (`packages/generacy/src/cli/commands/cockpit/status/group.ts:44`) treats this as a single `(no phase)` bucket. The spec (line 18) says `(no phase)` issues are excluded from `phase-complete` and included in `epic-complete`, but doesn't define whether a fully-phase-less epic (all issues in `(no phase)`) can ever emit `epic-complete`, or whether the feature only applies to epics with ≥1 phase heading.

**Question**: What is the behavior for an epic with zero phase headings (all refs in the `(no phase)` group)?

**Options**:
- A: `epic-complete` fires when all `(no phase)` refs close — the feature works even without phase structure; `phase-complete` never fires (nothing to aggregate); `epic-complete` fires when every ref (all in `(no phase)`) closes, honoring `--exit-on-epic-complete`.
- B: No synthetic events at all — feature is opt-in via phase headings; a phase-less epic emits nothing new (no `phase-complete`, no `epic-complete`). `--exit-on-epic-complete` never triggers exit. Existing per-issue events unchanged.
- C: `epic-complete` fires only after last close AND at least one phase heading — feature requires phase structure; phase-less epics get no `epic-complete`.
- D: Other (please specify).

**Answer**: *Pending*

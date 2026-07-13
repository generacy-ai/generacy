# Clarifications

## Batch 1 — 2026-07-13

### Q1: First-sight event shape
**Context**: FR-002 says the bus MUST emit an observable event when a newly joined ref appears in the monitored set, distinguishable from ordinary mid-stream state transitions. The `issue-transition` schema at `packages/cockpit/src/events/emit.ts:5-18` already allows `from: null` (via `z.union([z.enum(COCKPIT_STATES), z.null()])`), so the primitive is representable, but the choice of encoding determines both playbook dispatch ergonomics and downstream consumer compatibility. Under-specifying this blocks FR-002 and SC-001 implementation and forces the auto loop to guess the pattern to `.on()` for the "issue newly joined scope" case (Scenario A + B core primitive).
**Question**: What is the wire shape of the first-sight event that the bus emits when a ref joins the monitored set of a subscribed scope?
**Options**:
- A: Overload `issue-transition` with `from: null` — schema unchanged; existing consumers ignore because `null → <state>` isn't a transition they dispatch on; auto loop pattern-matches on `from === null`. Cheapest wire change; ties "first-sight" to whatever the ref's *first observed* state is (so the event carries the current state too).
- B: Add optional boolean `initial: true` field to `issue-transition` — additive-only schema change; auto loop reads flag; wire carries both current state and first-sight signal explicitly. Distinguishable from any `from: null` case that arises for other reasons (e.g., a ref that legitimately had no prior state in the ledger).
- C: New event type `issue-joined { ref, currentState }` — separate discriminated-union variant in `emit.ts`; semantically cleanest; requires schema update **and** every existing consumer to be extended (or explicitly opt in to ignore). Highest wire-compat cost, lowest ambiguity.

**Answer**: *Pending*

### Q2: Section placement policy for `cockpit scope add`
**Context**: FR-005 says the appended entry is a plain `- [ ] owner/repo#N` in a "determined section", but the two body shapes in scope (planned epic with `## Phase N:` headings vs. flat-list tracking issue with no headings) don't share a canonical insertion locus. This determines the write path in `cockpit_scope_add`, whether the writer must synthesize a heading, and whether the ref's placement survives operator hand-edits to the body (e.g., re-ordering phases). It also affects how `parseEpicBody` recognizes the appended entry on the next poll — a mid-heading insertion changes the "which phase does this ref belong to" question that today's parser answers positionally.
**Question**: Where in the scope issue's body does `cockpit scope add` insert the new task-list entry, for each of (a) an epic body with existing `## Phase N:` sections, and (b) a flat-list body with no phase headings?
**Options**:
- A: Dedicated `## Ad-hoc` section (created if missing) for both body shapes — writer always appends under `## Ad-hoc`; parser reads it out as scope-level (not phase-scoped) refs. Uniform, but adds a heading to bodies that today have no headings.
- B: Epic bodies → append at end of the current/most-recent phase section (last phase whose refs are still open, or last phase heading if none match); flat bodies → append at body tail with no section wrapping. Shape-aware; preserves existing convention on both sides; phase attribution for ad-hoc refs follows placement.
- C: Always append at body tail with no section wrapping, regardless of body shape — simplest writer; ad-hoc refs never carry phase attribution (would be a wart in epic bodies that reason about phase membership from body position); tolerates operator hand-edits since the tail is the least-contested locus.

**Answer**: *Pending*

### Q3: Non-epic body convention (resolver detection vs. explicit marker)
**Context**: FR-007 requires `resolveEpic` / `cockpit_status` / `cockpit_await_events` to accept a scope ref whose body doesn't follow the epic convention (no `## Phase N:` sections). The Assumptions section observes that today's `parseEpicBody` phase-heading walk is the constraint, and `resolveEpic` has no `type:epic` gate. Two shapes solve this differently — auto-detect keeps the resolver input-permissive but couples "is this an epic or a tracking issue" to body content (which can drift); an explicit marker keeps intent authoritative but requires cooperation from every entry point (ad-hoc mode, MCP callers, CLI users). This choice fixes the semantics of `cockpit_status` output (phase-shaped vs. flat) for a given ref and determines whether operators can point auto at *any* task-list-bearing issue or only ones flagged as tracking.
**Question**: How does the resolver decide whether to run phase parsing vs. flat-list parsing on a scope ref's body?
**Options**:
- A: Auto-detect by body content — `parseEpicBody` looks for at least one `## Phase N:` heading; if none, falls back to flat "any body with `- [ ] owner/repo#N` lines". No new label or title convention required; operators can retarget an existing issue into scope by adding task-list refs to its body.
- B: Explicit marker required for flat mode — resolver keys off a `type:cockpit-tracking` label (or `[cockpit-tracking]` title prefix). Ad-hoc mode creates such issues by default; existing issues need the marker added by hand to work as scopes. `cockpit_status` shape is decided by marker presence, not body content.
- C: Auto-detect for read paths (resolver / status / await), explicit marker for ad-hoc-created issues — auto-detect keeps operator retargeting frictionless, and ad-hoc mode still labels the ones *it* creates so downstream tooling (dashboards, cleanup) can find them.

**Answer**: *Pending*

### Q4: `cockpit scope` CLI namespace scope for v1
**Context**: The spec introduces the `cockpit scope` namespace with `add` (FR-004). Two adjacent verbs — `remove` (unchecked/line-deleted stops monitoring, per FR-003, but has no engine-observable event) and `list` (read-out of current monitored set for the scope) — are unspecified. If they ship in v1, operators get a symmetric, typed CLI surface; if they don't, `remove` is `gh issue edit --body ...` (raw string surgery, error-prone) and `list` is `cockpit_status` filtered by the caller. The v1 decision also constrains the MCP tool surface (`cockpit_scope_add` vs. `cockpit_scope_add` + `cockpit_scope_remove` + `cockpit_scope_list`) and the docs/onboarding surface.
**Question**: Which `cockpit scope` verbs ship in v1?
**Options**:
- A: Only `add` (CLI verb + MCP tool). `remove` = operator edits the body by hand; `list` = `cockpit_status`. Minimal surface, smallest test matrix.
- B: `add` + `list` (read-only helper). `list` prints the current monitored set (from `resolveEpic`) for a given scope ref; `remove` deferred to a follow-up once operator experience shows demand.
- C: `add` + `remove` + `list` — full CRUD in v1. `remove` performs a concurrency-safe body edit that unchecks or removes a specified ref line (FR-003 already covers the engine behavior; this just wraps the mutation). Largest surface, but symmetric with `add` and removes the need for raw `gh` edits.

**Answer**: *Pending*

### Q5: Scope-add write-race semantics (verify-loop retry policy)
**Context**: FR-004 mandates concurrency-safe append as "re-read body, insert entry, write, verify" but is silent on what happens when verify detects the body changed between re-read and write (typical case: two `cockpit_scope_add` calls racing, or an operator hand-edit interleaved with a scope-add). SC-005's "10 concurrent scope-add calls produce 10 distinct entries with no lost writes" only holds if the writer retries on verify mismatch — but the retry budget, backoff, and terminal-failure surface are unspecified. Under-specifying this makes SC-005 either trivially satisfiable (retry forever) or trivially failable (never retry) depending on implementer choice, and determines whether callers must implement their own retry loop. GitHub's issue-body update endpoint does not support conditional/ETag writes today, so retry-loop is the only available primitive.
**Question**: On verify mismatch (body changed between re-read and write), what does `cockpit_scope_add` do?
**Options**:
- A: Bounded synchronous retry — up to 5 attempts with exponential backoff (e.g., 100 ms / 250 ms / 500 ms / 1 s / 2 s), then fail with a distinct error code (`SCOPE_ADD_CONTENDED`) and a suggested manual remedy. SC-005's 10-concurrent test tunes count/backoff. Caller can retry the whole call if it wants more.
- B: Retry indefinitely with capped backoff (max ~5 s per attempt) until the write lands — writer never returns "contended" as a terminal state; contention is invisible to callers. SC-005 becomes latency, not correctness. Risk: a runaway hot loop against a scope issue held write-open by a broken client blocks all callers.
- C: Single-attempt, fail on first mismatch — caller (auto playbook, operator CLI) is responsible for retry. Simplest writer, pushes retry policy to callers; SC-005 requires the caller-side loop to satisfy the concurrent-add invariant, and the CLI verb needs its own retry wrapper to match the MCP tool's behavior expectation.

**Answer**: *Pending*

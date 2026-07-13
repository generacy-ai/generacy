# Clarifications

## Batch 1 — 2026-07-09

### Q1: Combined union export
**Context**: FR-003 requires "a single discriminated union on `type` covering both per-issue and aggregate events" so "consumers import one union, not two". Today, `emit.ts` exports `CockpitEventSchema` (per-issue only) and `aggregate-emit.ts` exports `AggregateEventSchema` (aggregates only). The spec's Out of Scope leaves the two files colocated but doesn't say where the exported combined union lives, what it is named, or whether the existing `CockpitEventSchema` name is preserved for the per-issue schema, taken over by the combined union, or retired. This decision drives every downstream import path.
**Question**: Where should the combined discriminated union be exported from, and how should the existing `CockpitEventSchema` name be treated?
**Options**:
- A: Add a new file (e.g., `stream-event.ts`) exporting `CockpitStreamEventSchema` as the union; leave `CockpitEventSchema` as the per-issue schema (extended with `type: 'issue-transition'`); leave `AggregateEventSchema` untouched.
- B: Keep the combined union in one of the two existing files (e.g., `emit.ts` re-exports the union as a new symbol like `CockpitWatchEventSchema`); no rename of `CockpitEventSchema`.
- C: Rename existing `CockpitEventSchema` → `IssueTransitionEventSchema`; take over the `CockpitEventSchema` name for the discriminated union (breaking name change for internal callers).
- D: Export the union from the package root (`@generacy-ai/generacy`) as public API so external consumers can import it.

**Answer**: A, plus a package-root re-export — new `stream-event.ts` defining `CockpitStreamEventSchema` as the discriminated union; `CockpitEventSchema` keeps its name and meaning (per-issue, extended with `type: 'issue-transition'`); `AggregateEventSchema` untouched. No takeover-rename (C churns every internal caller to buy a name), but do re-export the union from the package root: the README already treats the stream grammar as a public contract for auto mode, so the one-line re-export gives external consumers D's benefit without making the root the definition site.

### Q2: `type` injection mechanism on per-issue events
**Context**: FR-004 requires the `type` literal be set in "exactly one place per emit path (no fan-out of literal strings across call sites)". For per-issue events, three concrete mechanisms all satisfy the letter but differ in where the discriminator originates and how `emit()`'s validation behaves: (a) the field is a required part of the schema and every caller of `emit()` (or the `makeEvent` factory in `diff.ts`) supplies it; (b) `emit()` injects the constant into the payload before calling `.parse()`; or (c) the Zod schema uses `.default('issue-transition')` so the parser fills it. Each has different implications for the `CockpitEvent` TypeScript interface in `diff.ts` and for skip-validate consumers (`opts.skipValidate === true` bypasses parse, so a default won't be applied).
**Question**: Where is the `type: 'issue-transition'` literal set for per-issue events?
**Options**:
- A: Inside `emit()` — injected into the payload before validation (works with `skipValidate` if injected before the branch that skips parse).
- B: In `diff.ts`'s `makeEvent()` factory — every constructed `CockpitEvent` already has `type` when it reaches `emit()`; the interface in `diff.ts` gains a required `type: 'issue-transition'` field.
- C: In the Zod schema via `.default('issue-transition')` — parser injects it; `skipValidate` consumers must supply it themselves.

**Answer**: A — `emit()` stamps `type: 'issue-transition'` unconditionally, before the `skipValidate` branch. It is a single choke point regardless of how the payload was constructed (B only holds if literally every event flows through `makeEvent()` — one ad-hoc construction site and the literal fans out), and C is disqualified by its own caveat: a Zod default is skipped exactly on the `skipValidate` path, leaving the discriminator missing on the un-validated emissions — a silent hole in the invariant. Test to pin it: a payload reaching `emit()` without (or with a bogus) `type` still exits the process stamped `issue-transition`.

### Q3: README structure — canonical grammar table vs. supplemental
**Context**: FR-007 requires "one stream-grammar table" enumerating every `type` value, its full field set, and the "every emitted line is a JSON object with a `type` field" invariant. The current README (`packages/generacy/README.md`) has prose sections for `phase-complete` and `epic-complete` under "`cockpit watch` — aggregate events", but no documentation of the per-issue event shape at all (only the enum of `event` values in one sentence). Two shapes for the fix: replace/reorganize the existing prose into a single canonical table (single source of truth, may drop human-friendly prose about `--exit-on-epic-complete`, empty-phase behavior, ordering, etc.), or add the canonical table as an additive section (retains prose but risks the drift the whole change is trying to prevent).
**Question**: How should the README grammar table interact with the existing per-event prose sections?
**Options**:
- A: Additive — add a new "Stream grammar" table section documenting all three `type` values and their fields; keep the existing `phase-complete`/`epic-complete` prose sections unchanged as human-facing narrative.
- B: Restructured — replace the existing per-event prose sections with the single canonical table; move behavioral notes (empty-phase warning, ordering, `--exit-on-epic-complete`, startup sweep) to sibling subsections that reference the table by `type`.
- C: Table + per-type prose subsections — one table listing all `type` values and fields at the top, followed by a subsection per `type` (including `issue-transition`) for behavioral notes; drift check pins the table only.

**Answer**: C — one canonical table at the top (every `type`, full field set, and the "every emitted line is a JSON object with a `type` field" invariant), then a per-type behavioral subsection — **including `issue-transition`, which currently has no documentation at all and is the gap that blinded the auto session**. The FR-008 drift check pins the table only; prose can breathe. A is additive-drift, the disease itself.

### Q4: `issue-transition` documented field set
**Context**: The `CockpitEventSchema` in `emit.ts` already includes `initial: z.literal(true).optional()` on per-issue events (per the code today), but the spec's "Observed" section describes per-issue payloads without `initial`, and the README currently documents `initial: true` only for aggregate events (startup sweep). FR-007 requires the README table to list every `type` value's "full field set". If the table lists `initial` for `issue-transition`, the drift-check test (FR-008) and the discriminated-union schema must agree, and startup-sweep semantics for per-issue events need documentation. If the table omits `initial`, the schema needs to be tightened to drop it from the per-issue variant.
**Question**: Is `initial: true` part of the documented `issue-transition` field set?
**Options**:
- A: Yes — `initial: true` is documented on `issue-transition` too (matches current `emit.ts` schema); the README describes startup-sweep behavior for per-issue events alongside the aggregate startup sweep.
- B: No — drop `initial` from the `CockpitEventSchema` per-issue variant; document `initial` only on `phase-complete`/`epic-complete`; per-issue events never carry it.
- C: Yes but note-only — `initial` stays optional on `issue-transition` at the schema level, and the table lists it, but README defers behavioral description to the aggregate section (single startup-sweep description covers both).

**Answer**: A, with one shared startup-sweep subsection — `initial: true` is real, shipped behavior on per-issue events (that's #839's startup sweep; dropping it per B would break that feature), so the table lists it on all three types. Don't write the sweep behavior twice: one "startup sweep" subsection under Q3-C's structure covers both per-issue (#839) and aggregate (#885) semantics — table per-type complete, behavior described once.

### Q5: FR-009 emit-call-site regression test scope
**Context**: FR-009 says a regression test "MUST assert every emit call site in the package produces a line that parses against the discriminated union". Concretely there are three plausible interpretations, and they trade off maintenance cost against confidence: static call-graph enumeration (grep or ts-morph over the package for every call to `emit()`/`emitAggregate()` and assert each construction site's payload parses); path-exhaustive fixture (a fixture set covering every `event` enum value and every aggregate variant, run through the emit path); or integration/E2E (spin up `cockpit watch` against a synthetic snapshot sequence and pipe stdout through the union parser). The spec assumes one, but doesn't say which.
**Question**: What is the required scope of the FR-009 regression test?
**Options**:
- A: Path-exhaustive fixture — a curated fixture set exercises every `event` enum value (`label-change`, `issue-closed`, `pr-merged`, `pr-closed`, `pr-checks`) plus both aggregate `type` values plus the `initial: true` variants; each is run through `emit()`/`emitAggregate()` and stdout is asserted to parse against the union.
- B: Static call-site enumeration — a test uses ts-morph (or a similar AST walker) to find every call to `emit()` and `emitAggregate()` in the package and asserts each is reachable from a construction path that produces a schema-conformant payload.
- C: Integration/E2E — a synthetic snapshot sequence is fed to the poll loop; captured stdout is asserted to contain N lines all parsing against the union.
- D: Combination — path-exhaustive fixture (A) is the load-bearing coverage; a lighter static grep-for-callers assertion (a lint-style test) guards against a new emit path appearing without a matching fixture.

**Answer**: D — the path-exhaustive fixture set (every `event` enum value, both aggregate types, the `initial` variants) is the load-bearing coverage, and the lint-style static caller check is what makes it durable: a future emit path that doesn't add a fixture fails the guard instead of silently escaping the union. Full E2E (C) duplicates what the existing watch integration tests already exercise; keep FR-009 at the emit boundary.

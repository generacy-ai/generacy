# Research: Uniform `type` discriminator on `cockpit watch` NDJSON stream

## Decision 1: Union export location and naming

**Decision**: New `stream-event.ts` module exports `CockpitStreamEventSchema`; `CockpitEventSchema` retains its name + per-issue meaning (extended); `AggregateEventSchema` untouched. Re-export the union from the package root.

**Rationale (from clarification Q1-A)**: A takeover rename (`CockpitEventSchema` → the union) churns every internal caller for a name (no behavioral gain) and forces a coordinated migration across `watch.ts`, tests, and any downstream consumer of the current `CockpitEventValidated` type. Keeping the existing name pinned to per-issue semantics preserves all internal call sites verbatim. Choosing a new file rather than re-exporting from `emit.ts` avoids the "definition site sprawl" problem where readers of `emit.ts` see both a per-issue schema *and* a discriminated-union re-export in the same file — cleanest signal is one file, one concept.

**Alternatives considered**:
- **B — combined union in `emit.ts` as a new symbol**: rejected. Same-file definition of both per-issue schema and combined union muddies the emit path's mental model.
- **C — rename `CockpitEventSchema` → `IssueTransitionEventSchema`, take over the old name**: rejected. Churns internal callers for a naming decision, breaks import paths in tests and other packages.
- **D-only — export from package root without a new module**: rejected. Package root would become the *definition site* for a schema that logically belongs to the cockpit-watch subtree. Definition next to emitters + re-export from root is the standard pattern (see `AggregateEventSchema`, which is defined in `aggregate-emit.ts` and re-exported through the same file's public surface).

## Decision 2: `type` injection mechanism (per-issue path)

**Decision**: Stamp `type: 'issue-transition'` inside `emit()`, before the `skipValidate` branch. `emit()` unconditionally overwrites any pre-existing `type` on the payload.

**Rationale (from clarification Q2-A)**: `emit()` is the single choke point on the wire — every line originates there. Stamping inside `emit()` closes the invariant regardless of how the payload was constructed: `makeEvent()`-produced events, ad-hoc test payloads, and any future construction site all exit `emit()` with `type: 'issue-transition'`. The alternatives fail on subtle paths:
- Requiring every `makeEvent()` caller to set `type` (Q2-B) only holds if *literally every event flows through `makeEvent()`* — one ad-hoc construction site (as tests already do today) fans out the literal.
- `.default('issue-transition')` on the schema (Q2-C) is skipped exactly on the `skipValidate` path, leaving the discriminator missing on un-validated emissions. That's a silent hole in the invariant.

**Symmetry note**: The same stamping is applied inside `emitAggregate()` as defense-in-depth. Today every aggregate call site already includes `type`, so this is a no-op in practice — but it makes the invariant "every line the watcher emits carries `type`" a shape guaranteed by two symmetric emit functions, not by a spread of construction discipline.

**Alternatives considered**:
- Interface-required `type` at `makeEvent()`: partially adopted for TypeScript ergonomics (the interface will require it, forcing internal call sites to set it). But the runtime guarantee lives in `emit()`, not the interface — TS is not the wire.

## Decision 3: README structure

**Decision**: One canonical stream-grammar table at the top of the `cockpit watch` section, followed by a per-`type` behavioral subsection for each of the three variants — including a **new** `issue-transition` subsection — plus a shared "Startup sweep" subsection covering both per-issue (#839) and aggregate (#885) semantics.

**Rationale (from clarification Q3-C + Q4-A)**: The observed failure was documentation-driven — the auto session assumed `type` was universal because the README only documented aggregate events. An additive table on top of existing prose (Q3-A) *is the drift disease this whole change fights*. Restructuring per Q3-C consolidates the invariant into one auditable location (drift check test pins the table only, so prose can breathe), and adds the `issue-transition` subsection that closes the documentation gap. Q4-A retains `initial: true` on all three types, matching the shipped `#839` startup-sweep semantics — dropping it (Q4-B) would regress the feature; note-only deferral (Q4-C) leaves the field-set table incomplete.

**Alternatives considered**:
- **Q3-A additive**: rejected. The disease itself.
- **Q3-B replace prose with table alone**: rejected. Loses behavioral notes (`--exit-on-epic-complete`, empty-phase warning, ordering) that are load-bearing for consumers. The subsections are where prose lives.

## Decision 4: FR-009 test scope

**Decision**: Hybrid — path-exhaustive fixture set is the load-bearing coverage; a lint-style caller enumeration guards against a future emit path escaping the fixture set.

**Rationale (from clarification Q5-D)**: The observed failure was a shape mismatch at the wire boundary — the right defense proves *every payload shape that crosses `emit()` conforms to the union*, which is exactly path-exhaustive fixture coverage. Static-only (Q5-B) verifies call reachability but doesn't prove the payload shape. Integration/E2E (Q5-C) duplicates existing watch integration tests. The lint-style guard is the durability trick: fixture-only (Q5-A) drifts silently as new emit paths appear; adding a fail-closed enumeration of `emit(` / `emitAggregate(` call sites forces future contributors to add a fixture, making the coverage self-maintaining.

**Alternatives considered**:
- **Q5-A fixture-only**: rejected. No guard against new emit paths.
- **Q5-B static-only**: rejected. Doesn't prove wire-shape.
- **Q5-C E2E**: rejected. Duplicative with existing watch integration coverage.

## Implementation patterns

- **Zod discriminated union**: `z.discriminatedUnion('type', [SchemaA, SchemaB, SchemaC])`. Each variant must be a `z.object` (or `.strict()` object) with a `z.literal(...)` on the discriminator field. All three variants (`CockpitEventSchema`, `PhaseCompleteEventSchema`, `EpicCompleteEventSchema`) already satisfy the literal shape after the FR-001 extension.
- **Read the union's discriminator members** for the drift check: `CockpitStreamEventSchema._def.options.map(opt => opt._def.shape.type._def.value)` yields the exact set `['issue-transition', 'phase-complete', 'epic-complete']`. Assert equality with the README-parsed set.
- **Lint-style caller enumeration**: `readdirSync` (or Vitest's `import.meta.glob`) over `packages/generacy/src/cli/commands/cockpit/**/*.ts` (excluding `__tests__/**`), regex-match `\bemit\(|\bemitAggregate\(`, assert the enclosing file set matches a pinned allow-list. Fail-closed on new emit paths.

## Key sources / references

- **Spec**: `specs/887-found-during-cockpit-v1/spec.md`
- **Clarifications**: `specs/887-found-during-cockpit-v1/clarifications.md`
- **Prior work**:
  - **#885** — introduced S8 aggregates (`phase-complete`, `epic-complete`). Documented the aggregate half of the stream but never required a shared discriminator with the legacy envelope. **This spec closes that gap.**
  - **#839** — introduced startup-sweep semantics for per-issue events (`initial: true`). This spec preserves and documents that behavior.
  - **generacy-ai/tetrad-development#92** — the live smoke test where finding #39 surfaced the `grep '"type"'` silent-drop.
- **Emitters**: `packages/generacy/src/cli/commands/cockpit/watch/{emit,aggregate-emit,diff}.ts`
- **Existing tests**: `packages/generacy/src/cli/commands/cockpit/__tests__/watch.{emit,aggregate-emit}.test.ts`
- **README section to restructure**: `packages/generacy/README.md` lines 205–259.

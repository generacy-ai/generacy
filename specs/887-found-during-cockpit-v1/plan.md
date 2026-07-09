# Implementation Plan: Uniform `type` discriminator on `cockpit watch` NDJSON stream

**Feature**: Add a `type` field to every line the `cockpit watch` NDJSON stream emits, unifying per-issue transitions and S8 synthetic aggregates under one `z.discriminatedUnion('type', …)` schema.
**Branch**: `887-found-during-cockpit-v1`
**Status**: Complete

## Summary

`cockpit watch` currently emits two disjoint schemas on the same stream: per-issue transitions (no `type` field, keyed on `event`) and S8 aggregates (`type: phase-complete | epic-complete`, no `event`). A `grep '"type"'` filter — a reasonable filter against the documented S8 payload shape — silently drops every per-issue line, which blinded an auto-mode consumer in a live run (#885 T-S4).

The fix is additive and back-compat: every per-issue line gains `"type":"issue-transition"`, aggregate lines are untouched, a single `CockpitStreamEventSchema` discriminated union lives in a new `stream-event.ts` module and is re-exported from the package root, and the README grows one canonical stream-grammar table (with `initial: true` shown on all three variants). Regression tests are a path-exhaustive fixture set + a lint-style caller enumeration + a README-vs-schema drift check.

## Technical Context

- **Language / runtime**: TypeScript, Node.js >=22, ESM. Package `@generacy-ai/generacy` (`packages/generacy`).
- **Validation library**: Zod (`z.discriminatedUnion`, `z.literal`).
- **Test runner**: Vitest (`packages/generacy/vitest.config.ts`).
- **New dependencies**: none. All primitives (`ts-morph` for the lint-style caller enumeration is intentionally avoided — a much smaller regex/glob-based scan is sufficient at the two known emit sites, and adding an AST dep for this alone is over-engineering).
- **Files touched** (small, self-contained):
  - `packages/generacy/src/cli/commands/cockpit/watch/emit.ts` — extend schema with `type: z.literal('issue-transition')`; stamp `type` inside `emit()` before the `skipValidate` branch.
  - `packages/generacy/src/cli/commands/cockpit/watch/aggregate-emit.ts` — no schema change (already has `type`); the aggregate literal is stamped inside `emitAggregate()` before the `skipValidate` branch to guarantee the invariant symmetrically (FR-004 spirit).
  - `packages/generacy/src/cli/commands/cockpit/watch/stream-event.ts` — **NEW**. Exports `CockpitStreamEventSchema = z.discriminatedUnion('type', [CockpitEventSchema, PhaseCompleteEventSchema, EpicCompleteEventSchema])` and `type CockpitStreamEvent = z.infer<...>`.
  - `packages/generacy/src/cli/commands/cockpit/watch/diff.ts` — extend `CockpitEvent` interface with `type: 'issue-transition'`. Optional at the interface level would be a regression risk against the invariant; keep it required and let the type follow the emit stamp (interface consumers construct via `makeEvent()`, which will populate it).
  - `packages/generacy/src/index.ts` — re-export `CockpitStreamEventSchema` and `CockpitStreamEvent` from the package root.
  - `packages/generacy/README.md` — replace lines 205–259 with the new structure: canonical stream-grammar table → per-`type` behavioral subsections (`issue-transition`, `phase-complete`, `epic-complete`) → shared "Startup sweep" subsection → "Ordering within a poll cycle" and "Payload discipline" retained.
  - `packages/generacy/src/cli/commands/cockpit/__tests__/watch.emit.test.ts` — extend existing tests to assert `type: 'issue-transition'` is stamped by `emit()` (including on payloads that omit it or supply a bogus value).
  - `packages/generacy/src/cli/commands/cockpit/__tests__/watch.stream-event.test.ts` — **NEW**. Path-exhaustive fixture set + lint-style caller enumeration + README drift check + back-compat `event`-keyed dispatch fixture.

## Constitution Check

No `.specify/memory/constitution.md` exists in the repo — no project-level constitutional constraints to verify. The change respects the standing generacy conventions:

- Additive-only public API (no rename, no removed fields, no transport change).
- Zod schemas as the single source of truth for wire shapes.
- Tests colocated under `packages/generacy/src/cli/commands/cockpit/__tests__/`.
- README as the documented contract surface for cockpit CLI outputs (per `auto.md`'s `--help + README` convention).

## Project Structure

```
packages/generacy/
├── README.md                                          # MODIFIED — new grammar table + per-type subsections
├── src/
│   ├── index.ts                                       # MODIFIED — re-export CockpitStreamEventSchema
│   └── cli/commands/cockpit/
│       ├── watch.ts                                   # UNCHANGED — call sites of emit()/emitAggregate() unchanged
│       ├── watch/
│       │   ├── emit.ts                                # MODIFIED — CockpitEventSchema gains type: 'issue-transition'; emit() stamps type before skipValidate
│       │   ├── aggregate-emit.ts                      # MODIFIED — emitAggregate() stamps type before skipValidate (defense-in-depth)
│       │   ├── stream-event.ts                        # NEW — CockpitStreamEventSchema discriminated union
│       │   └── diff.ts                                # MODIFIED — CockpitEvent.type: 'issue-transition' + makeEvent() sets it
│       └── __tests__/
│           ├── watch.emit.test.ts                     # MODIFIED — type-stamping assertions
│           ├── watch.aggregate-emit.test.ts           # UNCHANGED
│           └── watch.stream-event.test.ts             # NEW — fixture set + caller enum + README drift + back-compat
```

## Implementation Sequence

1. **Schema first** — add `type: z.literal('issue-transition')` to `CockpitEventSchema` in `emit.ts`. Update the exported `CockpitEventValidated` type follows for free.
2. **Interface follows** — update `CockpitEvent` in `diff.ts` to include `type: 'issue-transition'` (required). Update `makeEvent()` to write it. This closes the type-system hole — internal call sites are forced to construct a full event.
3. **Stamp inside `emit()`** — inject `type: 'issue-transition'` into the payload as the very first step of `emit()`, then the `skipValidate` branch. This guarantees the invariant on the `skipValidate` path, per FR-004. The same treatment is applied symmetrically in `emitAggregate()` — the payload's declared `type` is preserved, but a `type`-less payload is stamped `phase-complete` if `phase` is present, else `epic-complete`. (Aggregate today always includes `type` at the call site — this is pure defense-in-depth for future-you.)
4. **Discriminated union module** — create `stream-event.ts` re-exporting the union. All three constituents are already `.strict()` (or effectively so) — the `z.discriminatedUnion` primitive requires each variant to have a discriminator on `type`, which is exactly the shape we've built.
5. **Package-root re-export** — one line in `packages/generacy/src/index.ts` making `CockpitStreamEventSchema` + `CockpitStreamEvent` importable from `@generacy-ai/generacy`.
6. **README rewrite** — restructure lines 205–259 per Q3-C + Q4-A. See `contracts/readme-grammar-table.md` for the exact table + subsection headings.
7. **Regression tests** — add `watch.stream-event.test.ts` with four blocks:
   - **Fixture set**: parametrized fixtures cover every `event` enum value on per-issue events, both aggregate `type` values, and the `initial: true` variants for all three. Each fixture is asserted to parse against `CockpitStreamEventSchema`.
   - **Lint-style caller enumeration**: glob-scan `packages/generacy/src/cli/commands/cockpit/**/*.ts` (excluding `__tests__/**`) for `emit(` and `emitAggregate(` call sites; assert the set of enclosing call sites matches a pinned allow-list — a future emit path forces a fixture addition (fail-closed).
   - **README drift check**: parse the README's stream-grammar table (via a minimal regex over the fenced table), extract the `type` set, assert equality with the union's `_def.options` discriminator values.
   - **Back-compat**: fixture-stream test asserts both (a) dispatching on `type` sees 100% of lines and (b) filtering by `event` still catches every per-issue line unchanged (US2 encoded).
8. **Extend `watch.emit.test.ts`** — three additions:
   - Assert `emit()` stamps `type: 'issue-transition'` on a payload without `type`.
   - Assert `emit()` overwrites a bogus `type` value (defense-in-depth for the invariant).
   - Assert `skipValidate: true` still yields a `type`-stamped line.

## Risks & Non-Risks

- **Non-risk**: back-compat. The `event` field, all per-issue field names, and aggregate shapes are unchanged. `event`-keyed consumers see zero delta.
- **Non-risk**: transport churn. Still NDJSON, one JSON object per line, no version bump.
- **Risk (mitigated)**: a new emit path could bypass `emit()` and hit `process.stdout.write` directly. The lint-style caller enumeration in the test guards against a *new emit path via `emit()` / `emitAggregate()`*; a direct `stdout.write` bypass is out of scope for this test and would be caught only by manual review. Acceptable — the observed failure (#885 T-S4) was a schema divergence, not a bypass, and the two-file emit surface is small.
- **Risk (mitigated)**: `initial: true` documentation gap. Q4-A explicitly requires listing it on `issue-transition` too, matching the shipped `#839` startup-sweep behavior — the drift check on the table pins this.

## Next Step

Run `/speckit:tasks` to generate the task list.

# Feature Specification: Uniform `type` discriminator on `cockpit watch` NDJSON stream

**Branch**: `887-found-during-cockpit-v1` | **Date**: 2026-07-09 | **Status**: Draft

## Summary

Found during the cockpit v1.5 auto-mode integration smoke test (generacy-ai/tetrad-development#92), finding #39. Companion to the agency finding on auto.md's consumption recipe; follow-up to #885.

The `cockpit watch` NDJSON stream currently interleaves two disjoint event schemas: per-issue transitions (no `type` field, keyed on `event`) and S8 synthetic aggregates (`type: 'phase-complete' | 'epic-complete'`, no `event`/`kind` fields). This forces every consumer to know both shapes, and any consumer that keys on a field present in only one shape silently drops the other. The fix: add a uniform `type` discriminator to every emitted line — additive and backward-compatible — so consumers can dispatch on one field, and reasonable `type`-shaped filters become harmless instead of lossy.

## Observed

The `cockpit watch` NDJSON stream now interleaves **two disjoint schemas**:

- **per-issue transitions** (from `packages/generacy/src/cli/commands/cockpit/watch/emit.ts`):
  `{"ts","repo","kind","number","from","to","sourceLabel","url","event","labels","initial?"}` — no `type` field;
- **S8 synthetic aggregates** (from `packages/generacy/src/cli/commands/cockpit/watch/aggregate-emit.ts`):
  `{"type","phase?","initial?","ts","epicRepo","epicNumber"}` — no `kind`/`event`/`repo` fields.

First live consequence (T-S4 run): the auto-mode session armed its stream reader as `grep '"type"'` — a filter that looks entirely reasonable against the documented S8 events — and thereby silently dropped 16 of 17 lines (every per-issue event), blinding the main loop while four issues sat at `waiting-for:clarification`.

Owning the provenance: #885's Q1 answer (option B) specified the synthetic payload in isolation and never required a discriminator shared with the legacy envelope. Stream-level uniformity was the missed requirement — two shapes in one stream means every consumer must know both, and any consumer that keys on a field only one shape has fails silently on the other.

## Proposal

1. **Uniform discriminator**: every line the watcher emits carries `type`. Additive and backward-compatible — per-issue events gain `"type":"issue-transition"` (all legacy fields retained, `event` untouched for existing consumers); synthetics keep `"type":"phase-complete"` / `"epic-complete"`. Consumers dispatch on one field, and `grep '"type"'`-shaped filters become harmless instead of lossy.
2. **One stream-grammar table in the package README**: every event type, its full field set, and the guarantee "every line is a JSON object with a `type` field" — stated once, where auto.md's contract (CLI `--help` + README) already points.
3. **Zod**: extend `CockpitEventSchema` accordingly; the emit path sets the discriminator in one place. The combined schema becomes a single `z.discriminatedUnion('type', […])` across per-issue + aggregate events.

## User Stories

### US1: Auto-mode session filters cockpit stream by discriminator without silent loss

**As an** auto-mode consumer (script, agent, or human debugging with `grep`),
**I want** every line of `cockpit watch` output to carry a `type` field with a well-known value,
**So that** filtering or dispatching on `type` sees 100% of the stream — never silently dropping legacy per-issue events.

**Acceptance Criteria**:
- [ ] Every NDJSON line emitted by `cockpit watch` parses against a single `z.discriminatedUnion('type', …)` schema.
- [ ] A consumer that runs `grep '"type"'` over the stream sees all lines (per-issue transitions + aggregates).
- [ ] Per-issue lines carry `"type":"issue-transition"` in addition to all pre-existing fields (`kind`, `event`, etc.).
- [ ] Aggregate lines continue to carry `"type":"phase-complete"` or `"type":"epic-complete"` unchanged.

### US2: Legacy consumer keyed on `event` continues to work

**As an** existing consumer that filters/dispatches on the `event` field of per-issue transitions,
**I want** the `event` field to remain unchanged with the same values and semantics,
**So that** no back-compat break lands with this change.

**Acceptance Criteria**:
- [ ] `event` field values on per-issue lines are unchanged (`label-change`, `issue-closed`, `pr-merged`, `pr-closed`, `pr-checks`).
- [ ] No fields are removed or renamed on per-issue lines; only `type` is added.
- [ ] No fields are added, removed, or renamed on aggregate lines.

### US3: Contributors can find the stream contract in one place

**As a** contributor writing a new cockpit consumer,
**I want** a single stream-grammar table in the `@generacy-ai/generacy` package README,
**So that** I can enumerate every event type, its full field set, and the invariant "every line is a JSON object with a `type` field" without reading the emitter source.

**Acceptance Criteria**:
- [ ] Package README contains one table listing every `type` value, its fields, and the stream-level invariant.
- [ ] The README table matches the discriminated union exactly (drift check enforced by test).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Per-issue transition events emitted by `emit.ts` MUST include `"type":"issue-transition"` on every line. | P1 | Additive; all existing fields retained. |
| FR-002 | Aggregate events emitted by `aggregate-emit.ts` MUST continue to include `"type":"phase-complete"` or `"type":"epic-complete"` (unchanged). | P1 | Already present; no code change on the aggregate emit path. |
| FR-003 | The Zod schema surface MUST expose a single discriminated union on `type` covering both per-issue and aggregate events. The union MUST be defined in a new `stream-event.ts` module as `CockpitStreamEventSchema`; `CockpitEventSchema` retains its name and per-issue meaning (extended with `type: 'issue-transition'`); `AggregateEventSchema` is untouched. The union MUST be re-exported from the package root (`@generacy-ai/generacy`) so external consumers can import it as public API. | P1 | Clarification Q1-A + package-root re-export. Rejects rename-takeover (C — churns internal callers) and same-file re-export (B — same file confuses the definition site). |
| FR-004 | The `type` literal MUST be stamped inside `emit()` / `emitAggregate()`, injected into the payload before the `skipValidate` branch — a single choke point regardless of how the payload was constructed. Payloads reaching `emit()` without (or with a bogus) `type` still exit the process stamped `issue-transition`. | P1 | Clarification Q2-A. Rejects `makeEvent()`-only injection (B — one ad-hoc construction site fans out the literal) and Zod `.default()` (C — a default is skipped exactly on the `skipValidate` path, leaving a silent hole in the invariant). |
| FR-005 | The `event` field on per-issue lines MUST retain its existing enum values and semantics. | P1 | Back-compat guarantee for legacy consumers. |
| FR-006 | No fields on per-issue or aggregate lines may be removed or renamed by this change. | P1 | Purely additive. `initial: true` remains on `issue-transition` (see FR-007). |
| FR-007 | The package README MUST include one canonical stream-grammar table at the top enumerating every `type` value, its full field set, and the invariant "every emitted line is a JSON object with a `type` field". The table MUST list `initial: true` (optional) on all three `type` values, matching the shipped per-issue startup-sweep behavior from #839. Behavioral notes MUST live in per-type subsections after the table (including a new `issue-transition` subsection — currently undocumented, and the gap that blinded the auto session). Startup-sweep semantics MUST be described once in a shared "Startup sweep" subsection covering both per-issue (#839) and aggregate (#885). | P1 | Clarification Q3-C + Q4-A with shared sweep subsection. Rejects additive-only (Q3-A — the additive-drift disease itself) and dropping `initial` from `issue-transition` (Q4-B — would regress #839). |
| FR-008 | A regression test MUST assert the README table's enumerated `type` set matches the discriminated union's members (drift check). The drift check pins the table only; per-type prose is not asserted. | P1 | Same pattern as gate-vocabulary audit. |
| FR-009 | Emit-boundary regression coverage MUST use a path-exhaustive fixture set as the load-bearing test: every `event` enum value (`label-change`, `issue-closed`, `pr-merged`, `pr-closed`, `pr-checks`), both aggregate `type` values, and the `initial: true` variants each run through `emit()` / `emitAggregate()` and asserted to parse against the discriminated union. A lint-style static caller check MUST also enumerate every call site of `emit()` / `emitAggregate()` in the package and fail if any lacks a matching fixture — a future emit path that skips the fixture is a hard error, not a silent gap. | P1 | Clarification Q5-D. Rejects fixture-only (A — no guard against new emit paths), static-only (B — doesn't prove payloads conform), and E2E (C — duplicates existing watch integration tests). |
| FR-010 | A fixture-stream regression test MUST assert (a) a consumer dispatching on `type` sees 100% of lines, and (b) a consumer keyed on `event` still sees every per-issue line unchanged. | P1 | Encodes both US1 and US2. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `grep '"type"'` over any `cockpit watch` stream drops no lines | 0 lines dropped | Fixture-stream test asserts line count preserved. |
| SC-002 | Every emit call site in `packages/generacy/src/cli/commands/cockpit/watch/**` produces lines that parse against the single discriminated union | 100% | Regression test iterates emit call sites (or exhaustive fixture set) and validates against the union. |
| SC-003 | README stream-grammar table `type` set matches Zod union `type` members | Exact match | Drift-check test compares README-parsed set with schema-derived set. |
| SC-004 | No existing consumer of the `event` field on per-issue lines breaks | 0 breakages | Back-compat fixture test dispatches on `event` and asserts every per-issue line is seen. |

## Assumptions

- The set of `type` values is closed at the emitter today: `issue-transition`, `phase-complete`, `epic-complete`. Any new event type is a follow-up requiring a spec update.
- Consumers off the critical path (external scripts, dashboards) either don't filter on `type` today (safe) or filter with an expectation that all lines carry it (broken today, fixed by this change).
- The `@generacy-ai/generacy` package README is the canonical documentation surface for the `cockpit watch` stream grammar — auto.md's contract already delegates to CLI `--help` + README.
- The single-place-of-truth for the `type` literal on per-issue events is `emit()` (FR-004: stamped inside `emit()` before the `skipValidate` branch). The union definition site is a new `stream-event.ts` module; the package root re-exports it as public API (FR-003).
- `initial: true` on per-issue events is shipped behavior from #839 (startup sweep) and MUST be preserved by this change — the discriminated union and README table both retain it on `issue-transition`.

## Out of Scope

- Renaming any existing field (`event`, `kind`, `phase`, etc.).
- Adding new event types beyond the three that exist today.
- Changing the transport (still NDJSON on stdout, one JSON object per line).
- Consumer-side migrations in downstream repos (they can adopt the discriminator at their own pace; back-compat via `event` is preserved).
- Versioning the stream grammar (this change is additive; no version bump needed).
- Refactoring `emit.ts` and `aggregate-emit.ts` into a single module; they can remain colocated so long as their schemas compose into one union at export time.

---

*Generated by speckit*

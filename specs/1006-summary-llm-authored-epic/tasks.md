# Tasks: Detect LLM-authored H4 phase-header epics + surface as loud signal

**Input**: Design documents from `/specs/1006-summary-llm-authored-epic/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/parser-behavior.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = the single bugfix story — silent stall → loud signal)

## Phase 1: Setup

- [ ] T001 [P] [US1] Create fixture file at `packages/cockpit/src/resolver/__tests__/fixtures/epic-1006-snappoll.md`.
  Content: verbatim body of `christrudelpw/snappoll#1` as captured in `spec.md § Live evidence` (lines 17–38): `### Delivery phases` (H3), then `#### P1 — Scaffold` (H4) with ref `christrudelpw/snappoll#2`, `#### P2 — Foundation` (H4) with refs `#3`, `#4`, `#### P3 — Core functionality` (H4) with refs `#5–#8`, `#### P4 — Polish & delivery` (H4) with refs `#9–#13`.
  This is historical evidence, frozen at PR time. Not a live mirror.

## Phase 2: Resolver — detector + tests

<!-- Sequenced: T002 introduces the detector API, T003 asserts against it. Both live in packages/cockpit/src/resolver/, so no [P]. -->

- [ ] T002 [US1] Modify `packages/cockpit/src/resolver/parse-epic-body.ts`:
  - Add module-level constant `const PHASE_SHAPED_H4_RE = /^\s*(?:P\d+\b|.*\bphase\b)/i;` with a short inline comment naming Q1=C (word-boundaried) and the matches / non-matches from `contracts/parser-behavior.md`.
  - In the L4+ heading branch (currently `HEADING_L4_PLUS_RE.test(line)` at ~`:74-78`), before the existing `current = null` reset, strip `^####+\s+` from the line, trim, and set `sawPhaseShapedH4 = true` if `PHASE_SHAPED_H4_RE.test(text)`. Declare `let sawPhaseShapedH4 = false;` alongside the other loop-local `let`s at the top of the function.
  - After the walk (before `return`), push one entry to `warnings` iff ALL FOUR: `phases.length > 0` AND `phases.every(p => p.refs.length === 0)` AND `adhocRefs.length > 0` AND `sawPhaseShapedH4`. Message shape (illustrative — only the marker substring is contractual): `` `cockpit: ${n} task ref${n === 1 ? '' : 's'} fell to ad-hoc; phase headers must be '###', found '####'` `` where `n = adhocRefs.length`.
  - Do NOT touch `types.ts`, `resolve.ts`, `ref-shapes.ts`, `heading-match.ts`, `errors.ts`. The `ParsedEpicBody.warnings: string[]` shape is preserved.
  - Do NOT introduce `allAdhocZeroPopulatedPhases` or `degradation.kind` fields — Out-of-Scope §5.
  - Function stays pure: synchronous, no I/O, no throws, no input mutation.

- [ ] T003 [US1] Extend `packages/cockpit/src/resolver/__tests__/parse-epic-body.test.ts` with a new `describe("H4 phase-header detector (#1006)", …)` block containing:
  - (a) **Snappoll fixture case**: load `fixtures/epic-1006-snappoll.md`, run `parseEpicBody(body)`, assert `result.warnings` contains at least one string matching `expect.stringContaining("phase headers must be '###'")`. Also assert `result.phases.length > 0`, `result.phases.every(p => p.refs.length === 0)`, and `result.adhocRefs.length === 12`.
  - (b) **Q1=C false-positive gates**: three inline fixtures — one with `#### Notes`, one with `#### Follow-ups`, one with `#### Rephrase the API` — each under a `### S1 — planning` with at least one real ref. Assert NO warning containing the marker substring fires (`.every(w => !w.includes("phase headers must be '###'"))`).
  - (c) **Vacuous-guard case (SC-002)**: flat-list body — `## Scope\n- [ ] owner/repo#1\n- [ ] owner/repo#2\n` with no `###` headings at all. Assert `phases.length === 0`, `adhocRefs.length === 2`, and NO warning containing the marker fires. This proves (a) `phases.length > 0` is load-bearing.
  - (d) **Empty-phases-but-no-phase-shaped-`####` case**: `### S1\n#### Notes\n- [ ] owner/repo#1\n` — H4 closes the phase, ref falls to adhoc, but `#### Notes` does not match the detector. Assert NO warning containing the marker fires. This proves (d) `sawPhaseShapedH4` is load-bearing.
  - (e) **Grep audit (SC-006)**: read `packages/cockpit/src/resolver/parse-epic-body.ts` via `readFileSync`, count occurrences of the substring `phase headers must be '###'`, assert count === 1. Optionally scan the whole `packages/cockpit/src/resolver/` dir and assert only one file contains it.

## Phase 3: Surfacing — CLI `--json` envelope

<!-- Phase boundary: T002 must land before T004/T005 so `parsed.warnings` carries the new marker at the CLI callsite. -->

- [ ] T004 [US1] Modify `packages/generacy/src/cli/commands/cockpit/status/render-table.ts`:
  - Extend `StatusEnvelope` interface at `:50-53` — add `warnings: string[]` with a JSDoc comment naming FR-012 (additive, non-breaking) and pointing at `data-model.md § StatusEnvelope`.
  - Extend `renderJsonEnvelope` signature at `:74-88` — third arg `warnings: string[]`. Include the field verbatim in the emitted JSON.

- [ ] T005 [US1] Modify `packages/generacy/src/cli/commands/cockpit/status.ts`:
  - At the JSON envelope emission site (~`:166-173`), pass `resolved.parsed.warnings` as the third argument to `renderJsonEnvelope`.
  - Do NOT add any new stderr write. The interactive channel already comes for free via `resolveEpic() → options.logger.warn → stderr` (Q4=D, see `resolve.ts:53-55` + `status.ts:49`).

## Phase 4: Surfacing — CLI status + MCP parity tests

<!-- Phase boundary: T004/T005 must land before T006/T007 so the envelope actually carries the field the tests will assert. -->

- [ ] T006 [P] [US1] Extend `packages/generacy/src/cli/commands/cockpit/__tests__/status.test.ts` (or add a new sibling `status.warnings.test.ts` if the file is already crowded):
  - **Clean body**: given an epic body with no defect, assert the parsed `--json` output has `warnings: []` (present, empty array — NOT missing).
  - **Snappoll fixture**: given the fixture body from T001, assert `parsedJson.warnings` is an array of length ≥ 1 and at least one entry matches `stringContaining("phase headers must be '###'")`.

- [ ] T007 [P] [US1] Extend `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-status.test.ts`:
  - Add a case that runs `cockpit_status` against the snappoll fixture body and asserts the MCP tool return has `data.warnings` present, an array, and containing the marker substring.
  - Add a parity assertion: for the same body, the MCP tool's `data.warnings` deep-equals the CLI `--json` envelope's `warnings` field. (Confirms `cockpit_status.ts:86` passes through `parsedJson` verbatim — no code change to that handler is expected.)

## Phase 5: Verification & release plumbing

<!-- Phase boundary: all code + test tasks must land first. -->

- [ ] T008 [US1] Run the local verification loop from `quickstart.md`:
  - `pnpm --filter @generacy-ai/cockpit test parse-epic-body` — green.
  - `pnpm --filter @generacy-ai/cockpit test` — green.
  - `pnpm --filter @generacy-ai/generacy test -- status` and `pnpm --filter @generacy-ai/generacy test -- parity-status` — green.
  - Grep audit (SC-006): `rg -n "phase headers must be '###'" packages/cockpit/src/` returns exactly one hit inside `parse-epic-body.ts`.
  - Broader grep: `rg -n "phase headers" packages/cockpit/src/` returns the same single hit — no accidental duplicates.
  - If `gh` is authenticated and `christrudelpw/snappoll#1` is still reachable, run `generacy cockpit status christrudelpw/snappoll#1 --json | jq '.warnings'` and confirm it prints an array containing the marker-bearing string; run without `--json` and confirm at least one stderr line contains `phase headers must be '###'` (Q4=D interactive path).

- [ ] T009 [US1] Add changeset `.changeset/1006-<slug>.md` bumping `@generacy-ai/cockpit` **minor** (new warning family — public surface addition) AND `@generacy-ai/generacy` **minor** (new `warnings: string[]` field on `--json` envelope + MCP tool `data` — public surface addition). Summary references #1006 and names both surfaces (resolver + envelope). Required by CI (`.github/workflows/changeset-bot.yml`) — the diff touches non-test `src/` in both packages. Confirm via `pnpm changeset status` after commit.

## Dependencies & Execution Order

**Sequential spine**:
- T001 (fixture) → T003 (parser tests need the fixture) → but T003 also needs T002 (the parser change).
- T002 → T003 → T004/T005 → T006/T007 → T008 → T009.

**Parallel opportunities**:
- **T001 in parallel with T002**: T001 writes a new fixture file; T002 edits `parse-epic-body.ts`. No shared file. Both must land before T003.
- **T006 in parallel with T007**: independent test files under different `__tests__/` dirs. Both depend on T004+T005.

**Blockers**:
- T003 requires BOTH T001 (fixture exists) AND T002 (detector emits the warning). Do not start T003 until both are done.
- T006/T007 require T004+T005 (envelope actually carries `warnings`). Do not start until both are done.
- T008 requires the entire T001–T007 chain — it exercises the full pipeline end-to-end.
- T009 is the last step before PR-ready — it must not land before T008 confirms the tests are green (a red build with a changeset only compounds noise).

## Notes

- **No playbook coupling task**: no file under `packages/claude-plugin-cockpit/commands/*.md` is referenced by `spec.md` or `plan.md`. The `/cockpit:auto` playbook is mentioned in `research.md` for context but is not edited by this PR — its `warnings[]` consumption is already-implemented and covered by the parity test in T007.
- **No `allAdhocZeroPopulatedPhases` boolean, no `degradation.kind` field**: Out-of-Scope §5 (research.md D3 caveat). The auto skill infers degradation from `warnings[].some(w => w.includes("phase headers must be '###'"))`.
- **Marker substring is the contract**: tests assert `stringContaining("phase headers must be '###'")` — never the full sentence. Count phrasing and the `found '####'` clause are free to evolve (Q2=B).
- **Loud-signal gating requires all four conditions** (see `contracts/parser-behavior.md`): `phases.length > 0`, `phases.every(p => p.refs.length === 0)`, `adhocRefs.length > 0`, `sawPhaseShapedH4`. Any one dropped is a documented false-positive shape.

# Implementation Plan: Detect LLM-authored H4 phase-header epics + surface as loud signal

**Feature**: Fix the silent `/cockpit:auto` stall on LLM-authored epic bodies whose phase headers are `####` instead of `###`. Add a phase-shaped-`####` detector to `packages/cockpit/src/resolver/parse-epic-body.ts` that emits a `warnings[]` entry carrying the stable marker substring `phase headers must be '###'`; surface `warnings[]` on both the `cockpit status --json` envelope and the `cockpit_status` MCP tool return; keep the existing `logger.warn` → stderr path for interactive operators.
**Branch**: `1006-summary-llm-authored-epic`
**Status**: Complete
**Date**: 2026-07-19
**Spec**: [spec.md](./spec.md)
**Input**: Feature specification at `/specs/1006-summary-llm-authored-epic/spec.md`

## Summary

Two-sided fix; this PR ships the defense-in-depth (resolver + surfacing) side end-to-end. The authoring-side pin (epic-authoring template must emit `###`) is a companion change tracked separately.

- **Resolver (single file, `parse-epic-body.ts`)**: while iterating the body, remember whether any `####+` heading whose trimmed text matches the phase-shaped detector `/^\s*P\d+\b/i` OR `/\bphase\b/i` (Q1=C, word-boundaried) was seen. At end-of-body, if `phases.length > 0` AND every phase has zero refs AND `adhocRefs.length > 0` AND any phase-shaped `####` was seen, push one `warnings[]` entry containing the stable marker substring `phase headers must be '###'` (Q2=B). The existing `warnings: string[]` shape is preserved; the marker collides with none of the three existing rejection-family markers (audit per SC-006).
- **Surfacing (CLI `--json` + MCP tool)**: add `warnings: string[]` to the `cockpit status --json` envelope (`renderJsonEnvelope`) and to the `cockpit_status` MCP tool's `data` payload (via the parity that already flows through `runStatus` — the CLI JSON envelope IS the MCP payload). Sourced directly from `parsed.warnings`; empty array when clean; additive/non-breaking per FR-012 (Q5=A). No `degradation.kind` field, no `allAdhocZeroPopulatedPhases` boolean — Out-of-Scope §5 excludes the richer degradation return-type (Q3=A caveat).
- **Interactive channel unchanged**: `resolveEpic()` at `resolve.ts:53-55` already forwards `parsed.warnings` to `options.logger.warn`, and the CLI `status.ts` binds the default logger to stderr. The new warning inherits that path with no code change (Q4=D).

Test surface: extend `parse-epic-body.test.ts` with (a) the snappoll#1 body fixture verbatim asserting the warning fires with the FR-003 marker + zero-populated-phases + non-empty adhoc, (b) the false-positive cases from Q1=C (`#### Notes`, `#### Follow-ups`, `#### Rephrase X`) asserting NO warning, (c) the vacuously-true guard case — flat-list body with `phases.length === 0` asserting NO warning (SC-002 gating rule from clarifications §Correctness note), (d) a grep-audit assertion that the FR-003 marker substring appears in exactly one warning-emission site (SC-006). Extend `status` tests to assert the JSON envelope carries `warnings: []` on clean bodies and `warnings: [<marker-bearing string>]` on the snappoll fixture. Extend `cockpit_status.test.ts` with the parity assertion.

Zero API deletions. The `--json` envelope and MCP tool `data` shape gain one additive field. Existing consumers that read only `scope` / `rows` continue to work.

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js >=22 (matches `packages/cockpit` `engines.node`). Compiles to ESM under `dist/`.
**Primary Dependencies**: `vitest` (existing test runner). No new runtime or dev deps.
**Storage**: None. `parseEpicBody` is a pure function — no I/O, no async, no throws.
**Testing**: `vitest` in `packages/cockpit/src/resolver/__tests__/` (parser tests) and `packages/generacy/src/cli/commands/cockpit/__tests__/` + `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/` (CLI + MCP tool tests). Extension points: `parse-epic-body.test.ts`, `status.test.ts` (or the sibling status-related file that already exercises `renderJsonEnvelope`), `cockpit_status.test.ts`. NEW fixture: `packages/cockpit/src/resolver/__tests__/fixtures/epic-1006-snappoll.md` (verbatim body of `christrudelpw/snappoll#1`, frozen at PR time — historical evidence, not a live mirror; mirrors the #826 fixture pattern).
**Target Platform**: Any environment where `@generacy-ai/cockpit` and `@generacy-ai/generacy` CLI + MCP server run — dev laptop, cluster orchestrator container, CI runner. All touched code is synchronous or pre-existing async; no platform-specific behavior.
**Project Type**: Two-package edit, single feature branch. Files modified: `packages/cockpit/src/resolver/parse-epic-body.ts`, `packages/cockpit/src/resolver/__tests__/parse-epic-body.test.ts`, `packages/generacy/src/cli/commands/cockpit/status.ts`, `packages/generacy/src/cli/commands/cockpit/status/render-table.ts` (extend `StatusEnvelope` + `renderJsonEnvelope` signature), the corresponding CLI status test file, `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_status.ts` (no code change if the envelope passthrough is verbatim; if the MCP handler currently strips fields, add none — `parsedJson` is returned as `data` verbatim per `cockpit_status.ts:86`), and its test file.
**Performance Goals**:
- No perf-relevant paths. The `####`-detector adds one `RegExp.test` per already-iterated line. Time complexity unchanged.
**Constraints**:
- **Additive, non-breaking envelope change.** `warnings: string[]` field added to `StatusEnvelope` and `cockpit_status` MCP tool `data`. Empty array on clean bodies. Consumers that ignore the field continue to work (FR-012).
- **Marker substring is load-bearing.** Tests assert via `toContain("phase headers must be '###'")` (Q2=B). The full sentence is free to evolve; the marker is stable. Grep audit: the marker substring must appear in exactly ONE warning-emission site in `packages/cockpit/src/resolver/` (SC-006).
- **Phase-shaped-`####` detector must be gated.** Q1=C with word-boundary refinement: `/^\s*P\d+\b/i` OR `/\bphase\b/i`. The `\b` on the `phase` arm is load-bearing — `#### Rephrase …` must not match (SC-002).
- **Loud-signal gating.** FR-009 part (b) fires iff **all** of (a) `phases.length > 0`, (b) `phases.every(p => p.refs.length === 0)`, (c) `adhocRefs.length > 0`, (d) at least one phase-shaped `####` heading was seen. Bare `phases.every(...)` is vacuously `true` on flat-list bodies (`phases.length === 0`); that mode is documented-valid per `resolve.ts:57-63` and must not fire (spec §Correctness constraint).
- **No `allAdhocZeroPopulatedPhases` boolean, no `degradation.kind` field.** Out-of-Scope §5 excludes the richer degradation return-type; the auto skill infers degradation from `warnings[].some(w => w.includes("phase headers must be '###'"))` (Q3=A caveat + Q4=D).
- **Resolver stays a pure function.** `parseEpicBody` continues to have no I/O, no throws, and returns a shape-preserving `ParsedEpicBody`. Only the `warnings` array grows by one entry in the specific detector-matched shape.
**Scale/Scope**: 1 source file modified in `packages/cockpit` (~30 net LOC), 1 test file extended (~40 net LOC + fixture load), 1 new fixture file (~30 lines verbatim from `christrudelpw/snappoll#1`), 1 source file modified in `packages/generacy` (`status/render-table.ts`) plus `status.ts` (~10 net LOC total for the envelope extension), 1–2 test files extended for CLI + MCP surfacing. Total net LOC ≈ 100.

## Constitution Check

No `.specify/memory/constitution.md` present in this repo. No gates to evaluate. Constitution check **PASS** (vacuously).

## Project Structure

### Documentation (this feature)

```text
specs/1006-summary-llm-authored-epic/
├── spec.md                                          # already authored (Draft; contains clarifications-batch-1 summary)
├── clarifications.md                                # already authored (Batch 1, Q1–Q5)
├── plan.md                                          # THIS FILE
├── research.md                                      # decision rationale (Q1–Q5) + why-Q1-C-refined vs alternatives
├── data-model.md                                    # interface deltas: warnings-marker family, envelope shape
├── quickstart.md                                    # local repro / validation with the snappoll#1 fixture
├── checklists/                                      # already scaffolded, empty
└── contracts/
    └── parser-behavior.md                           # documented parser behavior post-fix: phase-shaped-#### detector, loud-signal gating, marker taxonomy
```

`tasks.md` is produced by `/speckit:tasks`, not this command.

### Source Code (this feature)

```text
packages/cockpit/src/resolver/
├── parse-epic-body.ts                               # MODIFIED — (a) track sawPhaseShapedH4 flag while walking lines: on any `####+` heading whose trimmed text matches PHASE_SHAPED_H4_RE, set the flag; (b) after the walk, if phases.length > 0 && phases.every(refs.length === 0) && adhocRefs.length > 0 && sawPhaseShapedH4, push one warnings[] entry containing the FR-003 marker substring "phase headers must be '###'"; (c) add PHASE_SHAPED_H4_RE constant with inline comment documenting Q1=C refined
├── ref-shapes.ts                                    # UNTOUCHED
├── resolve.ts                                       # UNTOUCHED — logger.warn forwarding at :53-55 already picks up the new warning verbatim
├── heading-match.ts                                 # UNTOUCHED
├── errors.ts                                        # UNTOUCHED
├── types.ts                                         # UNTOUCHED — { phases, adhocRefs, allRefs, warnings: string[] } shape preserved; the new warning is one more string in the existing array
└── __tests__/
    ├── parse-epic-body.test.ts                      # MODIFIED — new describe block for the H4-phase-header detector: (a) snappoll#1 fixture loader + assertion that the warning fires and includes the FR-003 marker; (b) `#### Notes` / `#### Follow-ups` / `#### Rephrase X` NO-match cases; (c) flat-list body (phases.length === 0, adhocRefs > 0) NO-fire assertion covering the vacuously-true guard; (d) single-emission-site grep audit as a repo-relative fs read
    └── fixtures/
        └── epic-1006-snappoll.md                    # NEW — verbatim body of christrudelpw/snappoll#1 (frozen at PR time; historical evidence)

packages/generacy/src/cli/commands/cockpit/
├── status.ts                                        # MODIFIED — pass `resolved.parsed.warnings` into renderJsonEnvelope; (interactive-mode stderr line inherited unchanged from resolveEpic's logger.warn forwarding)
├── status/
│   └── render-table.ts                              # MODIFIED — extend StatusEnvelope: gains `warnings: string[]`; renderJsonEnvelope signature grows one arg; JSON output includes empty array on clean bodies
└── mcp/tools/
    └── cockpit_status.ts                            # UNTOUCHED at code level — `parsedJson` is returned verbatim as `data` (see :86), so envelope shape parity is automatic; test must assert parity explicitly
```

### Tests (this feature)

```text
packages/cockpit/src/resolver/__tests__/
└── parse-epic-body.test.ts                          # MODIFIED — see above

packages/generacy/src/cli/commands/cockpit/__tests__/
└── <status-test-file>.test.ts                       # MODIFIED — assert JSON envelope has `warnings: []` on a clean body; `warnings: [<contains marker>]` on the snappoll#1 fixture body

packages/generacy/src/cli/commands/cockpit/mcp/__tests__/
└── cockpit_status.test.ts                           # MODIFIED — assert MCP `data.warnings` is present and mirrors the CLI envelope
```

## Post-implementation checklist

- `pnpm --filter @generacy-ai/cockpit test` green (new detector tests + existing parser tests)
- `pnpm --filter @generacy-ai/generacy test` green (status envelope + MCP tool parity)
- Manual repro against `christrudelpw/snappoll#1`: `generacy cockpit status christrudelpw/snappoll#1 --json | jq '.warnings'` prints an array containing the marker-bearing string; stderr also carries the warning line for the interactive operator (Q4=D)
- Grep audit: `rg "phase headers must be '###'" packages/cockpit/src/` returns exactly one match in `parse-epic-body.ts` and none elsewhere (SC-006)
- New changeset file at `.changeset/1006-<slug>.md` bumping `@generacy-ai/cockpit` **minor** (new detector + warning is a new capability) and `@generacy-ai/generacy` **minor** (JSON envelope adds a field). CLAUDE.md changesets rules — the resolver package's warnings taxonomy is a public-surface addition.

## Suggested Next Step

Run `/speckit:tasks` to generate the task list from this plan.

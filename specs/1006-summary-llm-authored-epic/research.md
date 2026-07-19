# Research: LLM-authored H4 phase-header epic detection

**Feature**: `1006-summary-llm-authored-epic` | **Date**: 2026-07-19

This document captures the decisions locked in by `clarifications.md` Batch 1 and the alternatives considered — the "why" behind each Q-answer that plan/implement must not re-litigate.

## Decision 1 — Phase-shaped-`####` detector (Q1=C, word-boundary refined)

**Decision**: `PHASE_SHAPED_H4_RE` matches iff the trimmed heading text matches `/^\s*P\d+\b/i` **OR** contains a word-boundaried case-insensitive `phase` (`/\bphase\b/i`).

**Rationale**:
- **Covers the observed shape.** The `christrudelpw/snappoll#1` fixture uses `#### P1 …`, `#### P2 …`, etc. The `^\s*P\d+\b` arm matches these directly.
- **Covers spelled-out variants without over-matching.** Human authors sometimes write `#### Phase 1` or `#### Delivery phase`. The `\bphase\b` arm catches these.
- **The word-boundary is load-bearing.** A raw `substring 'phase'` test would match `#### Rephrase the API` and fire a false-positive. `\bphase\b` will not match `Rephrase` because `phrase` starts with a word character preceded by a word character (`ph`). This is the specific correction FR-002 called out as an over-broad pitfall.
- **`#### Notes` / `#### Follow-ups` never fire.** Neither arm matches. SC-002 passes.

**Alternatives considered**:
- **Q1=A (`P\d+` only)**: too narrow. Misses `#### Phase 1` / `#### Delivery phase` shapes that human authors emit.
- **Q1=B (case-insensitive substring `phase` only)**: misses `#### P1` (the observed LLM shape). Also the substring-not-word-boundary form matches `Rephrase`.
- **Q1=D (reuse `firstToken()` from `heading-match.ts`)**: consistent with the `###` phase-token extractor, but would fire on `#### Notes` (first-token = `Notes`, non-empty). Fails SC-002 by construction.

## Decision 2 — Warning marker substring (Q2=B)

**Decision**: Tests assert via `toContain("phase headers must be '###'")`. Full sentence stays free to evolve.

**Rationale**:
- **Load-bearing instruction, not decoration.** `phase headers must be '###'` is the actionable directive the operator needs to see. It is the minimum stable text that identifies the family.
- **Collision-free with existing markers.** The three existing markers at `parse-epic-body.ts:15-33` (`bare '#N'`, `titled but not ref-shaped`, `URL path not /(issues|pull)/N`) share no substring with `phase headers must be '###'`. Grep audit confirms per SC-006.
- **Leaves count and `found '####'` phrasing free to evolve.** FR-004's example `"cockpit: N task refs fell to ad-hoc; phase headers must be '###', found '####'"` remains one valid rendering. Future changes to the count language (`N` vs. `several` vs. omitted) or the `found` clause do not break tests.

**Alternatives considered**:
- **Q2=A (`phase headers must be '###', found '####'`)**: pins nearly the whole sentence. Fossilizes wording — exactly what FR-003 warns against.
- **Q2=C (`fell to ad-hoc`)**: leads on the observable symptom instead of the actionable directive. Risks colliding with any future adhoc-related warning family.
- **Q2=D (opaque code like `EPIC_H4_PHASE_HEADERS`)**: machine-friendly but breaks the existing warning-family convention. The three current markers are human-readable substrings; the new one should match that shape.

## Decision 3 — Surfacing scope: this PR, end-to-end (Q3=A, with Q4/Q5 caveat)

**Decision**: This PR ships the resolver-side detector AND the surfacing on both `cockpit status --json` and `cockpit_status` MCP tool return. **Caveat**: implement the machine-readable signal via `warnings[]` — NOT via an `allAdhocZeroPopulatedPhases: boolean` field (Out-of-Scope §5 excludes the richer degradation return-type).

**Rationale**:
- **The spec exists to make the silent stall visible to `/cockpit:auto`.** `/cockpit:auto` reads status via the `cockpit_status` MCP tool (step 3 startup sweep). Deferring the MCP surface change to a companion PR would re-open the window where the warning exists but the target caller can't see it — the worst-case outcome for the "silent stall" experience the spec is fixing.
- **The `cockpit_status` MCP tool already mirrors the CLI JSON envelope verbatim.** `cockpit_status.ts:86` returns `parsedJson` as `data`. Adding `warnings: []` to `renderJsonEnvelope`'s output automatically flows to the MCP tool return with zero MCP-handler changes required.
- **`resolveEpic` already forwards warnings to `logger.warn`** (`resolve.ts:53-55`), and CLI `status.ts` binds the default logger to stderr (`status.ts:49`). The interactive-operator stderr channel comes for free.

**Alternatives considered**:
- **Q3=B (resolver + `--json` envelope only, MCP later)**: leaves the auto skill blind. The spec's target caller cannot see the signal.
- **Q3=C (resolver-only)**: worst outcome — silent stall continues in the operator-visible path until the companion PR lands.
- **Q3=D (resolver + CLI stderr, MCP later)**: same blindness as Q3=B for the auto skill. Two coordinated PRs to close the loop.

## Decision 4 — Surfacing channel for the loud all-adhoc / zero-populated-phases signal (Q4=D)

**Decision**: stderr line for human operators **plus** `warnings[]` in the `--json` envelope for `/cockpit:auto`'s sweep. **No** separate structured `degradation.kind` field. The auto skill infers degradation from `warnings[].some(w => w.includes("phase headers must be '###'"))` (the Decision 2 marker).

**Rationale**:
- **Two operator paths, one channel each.** Interactive humans watching the CLI see stderr; automated auto-skill sweep reads `warnings[]` from the MCP tool return.
- **No richer degradation return-type.** Out-of-Scope §5 explicitly excludes a structured `degradation.kind` field. The auto skill's substring check on `warnings[]` is the pinned inference path.
- **Consistent with the existing warning-forwarding pipeline.** `resolveEpic` → `logger.warn` → stderr is the existing FR-003 warning path. Reusing it means the new warning inherits both channels with a single push.

**Alternatives considered**:
- **Q4=A (stderr only)**: invisible to the auto skill.
- **Q4=B (structured `degradation.kind` only)**: invisible to interactive human operators; also violates Out-of-Scope §5.
- **Q4=C (both stderr AND structured `degradation.kind`)**: highest coverage but adds the excluded richer return-type.

## Decision 5 — Include `warnings[]` in envelope shape (Q5=A)

**Decision**: Yes — add `warnings: string[]` to both the `cockpit status --json` envelope AND the `cockpit_status` MCP tool return. Sourced directly from `parsed.warnings`. Empty array when clean. Additive / non-breaking.

**Rationale**:
- **Required for Q3=A + Q4=D.** The auto sweep reads `warnings[]` off the MCP tool return; MCP parity is required, not optional. The CLI JSON envelope surfaces the same field for consistency and for direct `--json` consumers (e.g. `jq`-piped operators).
- **FR-012 contract preserved.** The addition is a purely additive field on the envelope. Callers that read only `{ scope, rows }` continue to work.
- **Sourced from `parsed.warnings` verbatim.** No filtering, no re-formatting — the resolver-emitted marker substring flows through to both surfaces.

**Alternatives considered**:
- **Q5=B (no envelope change)**: forces the fix to be invisible to the auto skill (the exact caller the spec is unblocking).
- **Q5=C (CLI only, MCP later)**: splits the surface change across two PRs and leaves the target caller blind until the companion lands.

## Correctness note — FR-009 part (b) gating rule (raised alongside answers)

**Rule**: fire the loud signal iff **all four** conditions hold:
- (a) `phases.length > 0`
- (b) `phases.every(p => p.refs.length === 0)`
- (c) `adhocRefs.length > 0`
- (d) at least one `####` heading whose text matches `PHASE_SHAPED_H4_RE` was seen

**Rationale**: `[].every(...)` is vacuously `true`. A bare `phases.every(p => p.refs.length === 0) && adhocRefs.length > 0` predicate would fire on legitimate flat-list bodies where `phases.length === 0`. `resolve.ts:57-63` documents flat-list mode as valid and supported ("bodies with task-list refs but no `### Phase` headings are valid — the monitored set is exactly `parsed.allRefs`"). Firing there would be a false positive — SC-002 fails.

The (a) `phases.length > 0` guard alone rules out flat-list bodies. The (d) `sawPhaseShapedH4` guard rules out ordinary epics that have `####` sub-headers unrelated to phase structure (e.g. `#### Notes` under an otherwise-populated `### S1 — planning`).

## Implementation pattern (informative)

The detector is a boolean flag maintained in the parser loop:

```ts
const PHASE_SHAPED_H4_RE = /^\s*(?:P\d+\b|.*\bphase\b)/i;
// Phase-shaped ####  header detector for FR-002 (Q1=C, refined).
// Matches: `P1`, `P2 — Foundation`, `Phase 1`, `Delivery phase`.
// Does NOT match: `Notes`, `Follow-ups`, `Rephrase the API`.

let sawPhaseShapedH4 = false;
for (const line of lines) {
  if (HEADING_L4_PLUS_RE.test(line)) {
    const text = line.replace(/^####+\s+/, '').trim();
    if (PHASE_SHAPED_H4_RE.test(text)) sawPhaseShapedH4 = true;
    current = null;
    currentSeen = new Set();
    continue;
  }
  // ...
}

// After the walk:
if (
  phases.length > 0 &&
  phases.every((p) => p.refs.length === 0) &&
  adhocRefs.length > 0 &&
  sawPhaseShapedH4
) {
  const n = adhocRefs.length;
  warnings.push(
    `cockpit: ${n} task ref${n === 1 ? '' : 's'} fell to ad-hoc; phase headers must be '###', found '####'`,
  );
}
```

Marker substring `phase headers must be '###'` is the only stable contract — the count and `found '####'` phrasing are free to evolve. The regex is written as one alternation on purpose; splitting into two `RegExp.test` calls is fine but adds no clarity.

## Key sources / references

- `packages/cockpit/src/resolver/parse-epic-body.ts` — current parser; grammar comments at :47-58; heading regexes at :5-10; rejection markers at :15-33.
- `packages/cockpit/src/resolver/resolve.ts` — top-level resolver; warnings-to-logger forwarding at :53-55; flat-list-mode contract at :57-63.
- `packages/cockpit/src/resolver/types.ts` — `ParsedEpicBody` shape; `warnings: string[]` field docstring at :32-33.
- `packages/generacy/src/cli/commands/cockpit/status.ts` — CLI status verb; default-logger-to-stderr binding at :49; JSON envelope emission at :166-173.
- `packages/generacy/src/cli/commands/cockpit/status/render-table.ts` — `StatusEnvelope` interface at :50-53; `renderJsonEnvelope` at :74-88.
- `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_status.ts` — MCP tool wrapper; envelope passthrough at :86 (`{ status: 'ok', data: parsedJson }`).
- `/home/node/.claude/commands/cockpit/auto.md` — auto skill; step-3 startup sweep uses `cockpit_status`; D.8 phase-queue gate fires on `phase-complete` — the S8 emission the silent stall blocks.
- `specs/826-found-during-cockpit-v1/` — prior parser fix in the same file; established the marker-substring convention we extend here.
- Live evidence: `christrudelpw/snappoll#1` — verbatim fixture source; body lines 17–38 per `spec.md`.

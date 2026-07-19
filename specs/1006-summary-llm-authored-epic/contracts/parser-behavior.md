# Contract: Parser behavior — H4 phase-header detection

**Feature**: `1006-summary-llm-authored-epic` | **Date**: 2026-07-19

This document is the authoritative reference for the H4-phase-header detector's behavior. All other artifacts (plan.md, data-model.md, research.md, tests) defer here on disputes about the grammar, the loud-signal gating rule, and the marker-substring contract.

## Grammar (unchanged from #826, extended with detector)

Line-oriented walk over an epic issue body. Grammar (from `parse-epic-body.ts` docstring):

- Heading L3 `^### (.+)$` — **opens a phase**.
- Heading L4+ `^####+ …$` — **closes the current phase**. Detector-tracked (see below).
- Heading L2 `^## …$` — ignored (except `## Ad-hoc` which also closes the current phase).
- Task-list item `^\s*- \[[ xX]\] (ref-shape)` — appends a ref to the current phase, or to `adhocRefs` if outside any phase.

The L4+ terminator role is unchanged. This feature adds a **side-effect flag** to L4+ heading processing.

## Detector — `PHASE_SHAPED_H4_RE`

```ts
const PHASE_SHAPED_H4_RE = /^\s*(?:P\d+\b|.*\bphase\b)/i;
```

Applied to the trimmed heading text with the `####+\s+` prefix stripped.

**Matches** (fire detector flag):
- `P1`, `P2`, `p1`, `P42`
- `P1 — Scaffold`
- `Phase 1`, `Phase 2 — Foundation`
- `Delivery phase`, `phase 3 — polish`

**Does not match** (do not fire detector flag):
- `Notes`
- `Follow-ups`
- `Rephrase the API`
- `Paraphrased quote`
- `Phaseless approach`
- `Scope`
- `Tech stack`
- empty string

## Loud-signal gating rule

At end-of-body, push a warning to `warnings[]` iff **all four** conditions hold:

| Condition | Predicate                                    | Purpose                                                                          |
|-----------|----------------------------------------------|----------------------------------------------------------------------------------|
| (a)       | `phases.length > 0`                          | Rules out flat-list mode (`phases.every` is vacuously true on `[]`).             |
| (b)       | `phases.every(p => p.refs.length === 0)`     | All phases are empty (the actual defect).                                        |
| (c)       | `adhocRefs.length > 0`                       | Refs did fall through to ad-hoc (there's something to warn about).               |
| (d)       | `sawPhaseShapedH4 === true`                  | At least one `####+` heading looked like a phase header (rules out `#### Notes`). |

**All four required.** Removing any one produces a documented false-positive or false-negative:
- Remove (a) → flat-list bodies fire (SC-002 fail).
- Remove (b) → normal epics with some empty phases fire (SC-002 fail).
- Remove (c) → epics with zero refs fire pointlessly (also `NO_REFS` throws first in `resolve.ts`, but the parser is a pure function and cannot rely on downstream throws).
- Remove (d) → epics with unrelated `#### Notes` sub-headers fire (SC-002 fail).

## Warning message contract

**Marker substring (stable, load-bearing)**: `phase headers must be '###'`

**Illustrative full sentence (free to evolve)**:
```
cockpit: 12 task refs fell to ad-hoc; phase headers must be '###', found '####'
```

**Test assertion pattern** (per Q2=B):
```ts
expect(result.warnings).toEqual(
  expect.arrayContaining([
    expect.stringContaining("phase headers must be '###'"),
  ]),
);
```

The full sentence structure, the count phrasing, the `found '####'` clause, and the trailing punctuation are all free to evolve without breaking tests. Only the marker substring is contractual.

## Non-collision requirement

The marker substring `phase headers must be '###'` **must not** appear in:
- Any other resolver warning message (`bare '#N'`, `titled but not ref-shaped`, `URL path not /(issues|pull)/N`).
- Any resolver error message (`LoudResolverError` codes and their rendered text).
- Any other production string in `packages/cockpit/src/`.

**Grep audit** (SC-006):
```
rg "phase headers must be '###'" packages/cockpit/src/
```
Must return exactly one hit — the emission site inside `parseEpicBody` in `parse-epic-body.ts`.

## Surfacing contract

### CLI `--json` envelope

`renderJsonEnvelope` output MUST include a `warnings: string[]` field on every emission:
- Empty array `[]` when `parsed.warnings.length === 0`.
- Verbatim copy of `parsed.warnings` otherwise (no filtering, no re-formatting, no deduplication).

### CLI human-readable stderr

Unchanged pipeline: `resolveEpic` (`resolve.ts:53-55`) forwards each entry in `parsed.warnings` to `options.logger.warn`; CLI `status.ts:49` binds the default logger to `process.stderr.write`. The new warning inherits this path with zero code change on the surfacing side.

### `cockpit_status` MCP tool return

The tool's `data` field MUST include `warnings: string[]` at the same envelope level as `scope` and `rows`. This is automatic because `cockpit_status.ts:86` returns `parsedJson` verbatim as `data`; the CLI envelope IS the MCP payload. Test MUST assert this parity explicitly.

## Pure-function contract (unchanged)

`parseEpicBody` remains:
- Synchronous.
- No I/O.
- No throws.
- No mutation of inputs.
- Idempotent: `parseEpicBody(body)` returns the same result on every call.

The detector flag is a local `let` inside the function; it does not escape.

## Backwards compatibility

- **Warning array**: consumers that iterate `parsed.warnings` continue to see the same rejection-family markers from #826 for the same inputs. The new marker only fires on the specific defect shape.
- **Envelope shape**: consumers that read only `scope` and `rows` continue to work. The `warnings` field is additive.
- **CLI stderr**: consumers that grep stderr for the existing markers continue to work. The new marker is one more line in the same channel.
- **MCP tool return shape**: consumers that key on `data.scope` and `data.rows` continue to work. `data.warnings` is additive.

Any code that pattern-matches on the exact list of resolver warning-family markers (e.g. an exhaustive `switch` over marker substrings) will need to add a case for the new marker — but such code is not known to exist in this repo.

# Contract: `parseEpicBody` behavior

Grammar contract for `packages/cockpit/src/resolver/parse-epic-body.ts` after this PR. Complements (does not replace) the #826 / #1006 parser contracts.

## Signature

```typescript
export function parseEpicBody(
  body: string,
  options?: ParseEpicBodyOptions,
): ParsedEpicBody
```

- Pure function. No I/O. No throws.
- `options === undefined` MUST be identical to `options === {}`.
- Return value carries phases, adhocRefs, allRefs, warnings — shape unchanged.

## Heading grammar (H4 promotion)

### Rule set (post-change)

| Line shape | Action |
|-----------|--------|
| `^# ` (H1) | Ignored — writer boundary only; parser does not act. |
| `^## ` (H2) | Closes current phase (via existing H2 handler, `parse-epic-body.ts:97-99`). Note: adhoc handler (below) is checked *first*. |
| `^## ad-hoc\s*$` (case-insensitive, `AD_HOC_HEADING_RE`) | Closes current phase; subsequent refs collected as adhoc. |
| `^### ` (H3) | Opens a new phase (`current` reset to fresh `ParsedPhase`). |
| `^####+ ` where trimmed text matches `PHASE_SHAPED_H4_RE` | **NEW**: opens a new phase (flat sibling of any surrounding H3). Sets `sawPhaseShapedH4 = true`. |
| `^####+ ` where trimmed text does NOT match `PHASE_SHAPED_H4_RE` | **NEW**: transparent — does NOT close current phase. |
| `TASK_LIST_RE` match | Attempt `parseRef` on first token; on success append to current phase (or adhoc if none open). See §Ref grammar. |

`PHASE_SHAPED_H4_RE` = `/^\s*(?:P\d+\b|.*\bphase\b)/i` — unchanged from #1006.

### Mixed-level detection (FR-012)

When both a H3 phase heading AND at least one phase-shaped H4 heading are observed in the same body:

- Every phase-shaped heading opens a new top-level phase (flat siblings).
- After the parse loop terminates, emit exactly one warning:
  ```
  cockpit: body mixes '###' and '####' phase headings; every phase-shaped heading opens a top-level phase (mixed phase heading levels)
  ```

  Marker substring: `mixed phase heading levels`.

- Order of `phases[]` matches body order.

### Fixture matrix

| Body pattern | Expected `phases[]` | Notes |
|--------------|---------------------|-------|
| `### P1\n- [ ] r#1\n### P2\n- [ ] r#2` | `[{token:'p1',refs:[r#1]}, {token:'p2',refs:[r#2]}]` | Unchanged from today. |
| `#### P1\n- [ ] r#1\n#### P2\n- [ ] r#2` | `[{token:'p1',refs:[r#1]}, {token:'p2',refs:[r#2]}]` | **NEW**: both phases populated. No mixed-level warning. |
| `### P1\n#### Notes\n- [ ] r#1` | `[{token:'p1',refs:[r#1]}]` | **NEW**: `#### Notes` transparent; `r#1` attributed to P1. |
| `### P1\n- [ ] r#1\n#### Phase 2\n- [ ] r#2` | `[{token:'p1',refs:[r#1]}, {token:'phase',refs:[r#2]}]` + `mixed phase heading levels` warning | **NEW**: flat siblings + warning. |
| `#### Notes\n- [ ] r#1` (no phases) | `phases: []`, `adhocRefs: [r#1]` | Unchanged (H4 with no phase is transparent, ref falls to adhoc because `current === null`). |
| `### P1\n- [ ] r#1\n## Ad-hoc\n- [ ] r#2` | `[{token:'p1',refs:[r#1]}]`, `adhocRefs:[r#2]` | Unchanged (H2 Ad-hoc rule preserved). |
| `#### Rephrase P1\n- [ ] r#1` | `phases: []`, `adhocRefs: [r#1]` | Detector uses `\bphase\b`; `Rephrase` fails detection (Q1=C invariant from #1006). H4 stays transparent, ref falls to adhoc. |

## Ref grammar (bare `#N` under `defaultRepo`)

### Rule set (post-change)

For each line matching `TASK_LIST_RE` = `/^\s*-\s*\[[ xX]\]\s+(.+?)\s*$/`:

1. Extract `refToken` = first whitespace-delimited token of the captured text.
2. Attempt `parseRef(refToken)`.
3. **Success path**: append to current phase or adhoc — as today.
4. **Failure path** — bare-`#N` fallback (NEW):
   - IF `options.defaultRepo` is set AND `BARE_HASH_N_RE.test(refToken)` (== `/^#\d+$/`):
     - Synthesize `ref = { repo: options.defaultRepo, number: Number.parseInt(refToken.slice(1), 10) }`.
     - Append to current phase or adhoc. **No warning.**
   - ELSE:
     - Existing #826 classifier: if `REF_SHAPED_RE.test(refToken)`, push warning with marker (`bare '#N'` / `titled but not ref-shaped` / `URL path not /(issues|pull)/N`). Else: silent skip.

### Scope constraints

- **Checkbox-only**: bare `#N` acceptance MUST NOT extend to plain bullets (`- #223`), ordered items (`1. #223`), or prose. Only `TASK_LIST_RE`-matching lines are scanned (FR-013).
- **Cross-repo forbidden**: bare `#N` MUST NOT infer any repo other than `defaultRepo`. Explicit `owner/repo#N` in the same body still works (they parse via `parseRef`'s existing `BARE_RE` branch).
- **Line-number defaulting is per-line**: two bare refs on two lines both default to the same `defaultRepo`. No stateful override in body.

### `defaultRepo` validation

| Input | Behavior |
|-------|----------|
| `undefined` / omitted | Bare-`#N` fallback disabled. Legacy behavior. |
| `"owner/repo"` (matches `/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/`) | Fallback enabled. |
| `""` / `"owner"` / `"owner/"` / `"owner/repo/extra"` / non-string | Push one warning with marker `invalid defaultRepo`. Treat as if undefined for the remainder of the parse. No throw. |

## Warnings emitted

Post-change warning taxonomy. Each string contains exactly one stable marker substring; test suites assert via `toContain()`.

| Marker | Origin | Fires when |
|--------|--------|------------|
| `bare '#N'` | #826, preserved | Bare `#N` in checkbox, `defaultRepo` NOT set. |
| `titled but not ref-shaped` | #826, preserved | First token not ref-shaped but line is checkbox. |
| `URL path not /(issues|pull)/N` | #826, preserved | GitHub URL in wrong path shape. |
| `phase headers must be '###'` | #1006, preserved | Zero-populated phases + non-empty adhoc + at least one phase-shaped H4 (the loud-signal gate at `parse-epic-body.ts:167-177`). |
| `mixed phase heading levels` | **NEW** (FR-012) | Body has both H3 phase headings AND phase-shaped H4 headings. Exactly one per call. |
| `invalid defaultRepo` | **NEW** (FR-003) | Malformed `defaultRepo` option. Exactly one per call. |

## Idempotency

Calling `parseEpicBody(body, options)` twice with the same inputs MUST produce structurally-equal outputs (same phases in same order, same refs in same order, same warnings in same order).

## Determinism

No randomness, no time-of-day, no I/O. Same `(body, options)` → same output.

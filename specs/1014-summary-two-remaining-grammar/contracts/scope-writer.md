# Contract: `detectShape` in `scope/writer.ts`

Delta contract for `packages/generacy/src/cli/commands/cockpit/scope/writer.ts`. Complements the writer contract shipped in #935.

## Signature (unchanged)

```typescript
export type BodyShape = 'phased' | 'flat';
export function detectShape(body: string): BodyShape;
```

Pure function. No I/O. No throws.

## Recognition rule (post-change)

A body classifies as `phased` iff at least one of:

1. Some line matches `HEADING_L3_RE` (`/^###\s+/`). — Unchanged today.
2. Some line matches `HEADING_L4_PLUS_RE` (`/^####+\s+/`) AND, after stripping the leading `####+ `, the trimmed text matches `PHASE_SHAPED_H4_RE` (`/^\s*(?:P\d+\b|.*\bphase\b)/i`). — **NEW**.

Otherwise: `flat`.

### Invariant I-P: parser-writer byte parity

`PHASE_SHAPED_H4_RE` in `writer.ts` MUST be byte-identical to `PHASE_SHAPED_H4_RE` in `packages/cockpit/src/resolver/parse-epic-body.ts:12`. This is duplicated (not imported) to avoid a cross-package edge from `@generacy-ai/generacy` back into `@generacy-ai/cockpit`'s resolver internals. Marked with an invariant comment at both sites:

```typescript
// Byte-exact against parse-epic-body.ts:12 PHASE_SHAPED_H4_RE (invariant I-P).
// If you change this regex, also update the parser. Fixture-pinned via tests.
const PHASE_SHAPED_H4_RE = /^\s*(?:P\d+\b|.*\bphase\b)/i;
```

## No auto-normalization on write

The writer MUST NOT rewrite `####` phase headings to `###` when adding or removing refs. Author-provided formatting is preserved (clarifications Q2=A rejection of option C).

Consequence: an H4-phased body remains H4-phased after `scope add`. The writer's `addToPhased` path (`writer.ts:98-129`) already places ad-hoc refs under `## Ad-hoc` at the tail (or an existing Ad-hoc section), and that logic is heading-level agnostic — it doesn't need to know whether phases are H3 or H4, only whether *any* phase heading exists.

## Fixture matrix

| Body | Today | After PR | Change reason |
|------|-------|----------|---------------|
| `### Phase 1\n- [ ] r#1` | `phased` | `phased` | none |
| `- [ ] r#1\n- [ ] r#2` | `flat` | `flat` | none |
| `` (empty) | `flat` | `flat` | none |
| `## Overview\n- [ ] r#1` | `flat` | `flat` | none — H2 doesn't classify. |
| `#### notes\n- [ ] r#1` | `flat` | `flat` | none — `notes` fails `PHASE_SHAPED_H4_RE`. |
| `#### P1 — Scaffold\n- [ ] r#1` | `flat` | **`phased`** | FR-011: phase-shaped H4 now classifies. |
| `#### Phase 2\n- [ ] r#2` | `flat` | **`phased`** | FR-011. |
| `#### Rephrase\n- [ ] r#1` | `flat` | `flat` | `Rephrase` uses `\bphase\b` word-boundary → no match. |
| Existing `epic-1006-snappoll.md` | `flat` | `phased` | H4 phases now recognized. |

## Round-trip guarantee

For any body `b`:

- `applyScopeMutation(b, {kind: 'add', ref})` followed by `parseEpicBody(<result>.body, {defaultRepo: '<owner>/<repo>'})` MUST produce a `ParsedEpicBody` that contains `ref` in exactly one location (a phase's `refs[]` OR `adhocRefs[]`).
- `applyScopeMutation` followed by `applyScopeMutation` with the same mutation is a no-op (writer idempotency, unchanged).

## Test file impact

`packages/generacy/src/cli/commands/cockpit/scope/__tests__/writer.test.ts` MUST add cases:

1. `detectShape('#### P1 — Scaffold\n- [ ] o/r#1')` → `'phased'`.
2. `detectShape('#### Phase 2\n- [ ] o/r#1')` → `'phased'`.
3. `detectShape('#### notes\n- [ ] o/r#1')` → `'flat'` (existing case; regression-preserved).
4. `detectShape('#### Rephrase\n- [ ] o/r#1')` → `'flat'` (word-boundary sanity).
5. `applyScopeMutation('#### P1 — S\n- [ ] o/r#1\n', {kind:'add', ref:{repo:'o/r',number:2}})` → resulting body is `phased`-shaped and contains a `## Ad-hoc` section at tail with `o/r#2`.

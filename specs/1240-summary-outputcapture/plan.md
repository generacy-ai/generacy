# Implementation Plan: Detect SPECKIT_IMPLEMENT sentinels inside stream-json envelopes

**Feature**: Detect `SPECKIT_IMPLEMENT_PARTIAL` / `SPECKIT_IMPLEMENT_BLOCKED` sentinels embedded in Claude CLI `stream-json` envelopes
**Branch**: `1240-summary-outputcapture`
**Status**: Complete
**Issue**: [#1240](https://github.com/generacy-ai/generacy/issues/1240) | **Workflow**: speckit-bugfix

## Summary

`OutputCapture.parseLine` (`packages/orchestrator/src/worker/output-capture.ts:125`) only
detects implement sentinels when a raw stdout line *starts with* the sentinel prefix. But
implement phases run under `--output-format stream-json`
(`packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts:175`), so every
stdout line is a JSON envelope and the sentinel only ever appears *inside* a JSON string:
in an assistant message `text` content block, and again in the terminal `result` event's
`result` string. The `startsWith` check never matches, `implementResult` stays `undefined`,
and a genuinely partial implement is treated as complete whenever the tasks.md safety net
can't read `tasks.md`.

The fix is purely additive inside `OutputCapture`: after a stdout line successfully
JSON-parses, scan the envelope's embedded text (assistant `text` blocks and the `result`
string) line-by-line for the two sentinel prefixes, and run exactly the same
parse/validate/last-wins/blocked_on-preservation logic that the raw-line path runs today.
The raw-line `startsWith` fallback is preserved unchanged.

## Technical Context

- **Language/runtime**: TypeScript (ESM), Node >= 22
- **Package**: `@generacy-ai/orchestrator` (`packages/orchestrator`)
- **Test framework**: Vitest (`pnpm --filter @generacy-ai/orchestrator test`)
- **No new dependencies.** Single-file change plus tests plus a changeset.

## Design

### 1. Extract shared sentinel handlers (FR-004)

Today the PARTIAL and BLOCKED handling live inline in `parseLine` (lines 128–180), each
followed by a text-chunk push. Extract the *state-mutation* portion into two private
methods so both code paths share one implementation:

```ts
/** Returns true if the line matched a sentinel prefix (even if payload was malformed). */
private trySentinel(line: string): boolean {
  if (line.startsWith(OutputCapture.SENTINEL_PREFIX)) {
    this.applyPartialSentinel(line.slice(OutputCapture.SENTINEL_PREFIX.length), line);
    return true;
  }
  if (line.startsWith(OutputCapture.SENTINEL_BLOCKED_PREFIX)) {
    this.applyBlockedSentinel(line.slice(OutputCapture.SENTINEL_BLOCKED_PREFIX.length), line);
    return true;
  }
  return false;
}
```

`applyPartialSentinel` contains the existing JSON-parse + last-wins +
`blocked_on`-preservation (#1211 Q2=A) logic verbatim, including the
`logger.warn(…, 'Malformed SPECKIT_IMPLEMENT_PARTIAL sentinel — ignoring')` surface
(FR-005). `applyBlockedSentinel` likewise carries the existing `Array.isArray(parsed.on)`
validation and warnings. **No behavioral change** to these handlers — this is a pure
extraction so envelope-embedded and raw-line sentinels cannot diverge.

### 2. Raw-line path (FR-003, US2)

`parseLine` keeps its current structure: if `trySentinel(line)` returns true, push the line
as a `text` chunk (exactly as today, preserving `getOutput()` behavior) and return. The
existing tests in `output-capture.test.ts` and `output-capture.blocked-sentinel.test.ts`
must pass unchanged (SC-002).

### 3. Envelope scan (FR-001, FR-002)

After the successful `JSON.parse(line)` in `parseLine` and before pushing the chunk, scan
the envelope for embedded sentinel text:

```ts
private scanEnvelopeForSentinels(parsed: Record<string, unknown>): void {
  for (const text of this.extractEmbeddedTexts(parsed)) {
    for (const rawLine of text.split('\n')) {
      this.trySentinel(rawLine.trim());
    }
  }
}
```

`extractEmbeddedTexts` returns the embedded strings, tolerating any envelope shape and
never throwing (spec assumption):

- **Assistant text blocks** (FR-001): if `parsed.message` is an object whose `content` is
  an array, yield `block.text` for every element with `typeof block === 'object'`,
  `block.type === 'text'`, and `typeof block.text === 'string'`. Keyed off the presence of
  `message.content`, not `parsed.type === 'assistant'`, so it tolerates variant envelope
  typing; in practice this matches assistant events.
- **Result string** (FR-002): if `typeof parsed.result === 'string'`, yield it.

All field accesses are type-guarded; missing/variant fields simply yield nothing.

Notes:

- The scan runs regardless of `KNOWN_TYPES` normalization — `assistant`/`result` envelope
  types continue to normalize to `'text'` chunks exactly as today (out of scope to change).
- The envelope itself is still pushed as its normal chunk (and logged/SSE-emitted) exactly
  as before; the scan adds **no** extra chunks to `getOutput()`. Only the raw-line path
  pushes a sentinel text chunk, as today.
- Trimming each split line before the prefix check handles leading whitespace inside
  multi-line text blocks; a sentinel on its own line within a larger block is found
  (FR-001 "splitting block text on `\n`").

### 4. Deduplication (FR-006)

No explicit dedup state is needed. Both handlers are **idempotent for identical payloads**:

- PARTIAL: re-applying the same parsed object spreads the same fields; the
  `blocked_on`-preservation branch re-evaluates to the same output.
- BLOCKED: re-setting `blocked_on` to the same array value.

So when the same sentinel appears in both an assistant `text` block and the `result`
string, processing it twice equals observing it once. Distinct payloads across envelopes
keep last-wins semantics (spec assumption). A test asserts the identical-payload case.

### 5. Malformed payloads inside envelopes (FR-005)

Because `trySentinel` is shared, a malformed sentinel inside an envelope hits the same
`logger.warn` + ignore path as a malformed raw line. The `line` field in the warn context
is the embedded (trimmed) sentinel line.

## Files Changed

| File | Change |
|------|--------|
| `packages/orchestrator/src/worker/output-capture.ts` | Extract `trySentinel` / `applyPartialSentinel` / `applyBlockedSentinel`; add `scanEnvelopeForSentinels` + `extractEmbeddedTexts`; call scan after successful JSON parse in `parseLine`. |
| `packages/orchestrator/src/worker/__tests__/output-capture.stream-json-sentinel.test.ts` | **New** — envelope-embedded sentinel coverage (see Test Plan). |
| `.changeset/1240-stream-json-sentinels.md` | **New** — `@generacy-ai/orchestrator: patch` (defect fix, speckit-bugfix workflow). |

Existing test files are not modified (SC-002 requires them to pass unchanged).

## Test Plan

New file `output-capture.stream-json-sentinel.test.ts`:

1. **FR-001**: PARTIAL sentinel as the sole line of an assistant `text` block populates
   `implementResult`.
2. **FR-001**: PARTIAL sentinel on its own line at the *end* of a multi-line `text` block
   (the observed production shape) is found.
3. **FR-002**: PARTIAL sentinel inside a `result` event's `result` string is found.
4. **US1/AC3**: BLOCKED sentinel inside an assistant `text` block populates `blocked_on`.
5. **FR-004**: last-wins across multiple envelope sentinels; BLOCKED-then-PARTIAL inside
   envelopes preserves `blocked_on` (#1211 Q2=A parity with raw-line tests).
6. **FR-006**: identical PARTIAL payload in both an assistant block and the `result`
   string → `implementResult` equals observing it once.
7. **FR-005**: malformed sentinel JSON inside an envelope warns and leaves
   `implementResult` undefined.
8. **Robustness**: envelopes with missing/variant fields (`message` not an object,
   `content` not an array, blocks without `text`, non-string `result`, `null` values)
   neither throw nor set `implementResult`.
9. **getOutput()**: envelope scan adds no extra chunks; the envelope chunk itself is
   preserved.
10. **SC-001**: replay a captured-transcript-shaped fixture — an `init` envelope, several
    assistant/tool envelopes, an assistant envelope whose final text block ends with the
    real observed sentinel line
    (`SPECKIT_IMPLEMENT_PARTIAL: {"partial":true,"tasks_completed":10,"tasks_remaining":44,"tasks_total":54}`),
    and a `result` envelope duplicating it — assert `implementResult` is defined with
    those counts.

Regression: run the full orchestrator suite (`pnpm --filter @generacy-ai/orchestrator test`)
— `output-capture.test.ts` and `output-capture.blocked-sentinel.test.ts` pass unchanged
(SC-002). SC-003 (increment path consumes the now-defined `implementResult`) is already
covered by existing phase-loop increment logic, which keys off
`result.implementResult !== undefined`; no phase-loop change is needed.

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo — no constitution gates to check.
Repo-level invariants from `CLAUDE.md` respected: the tasks.md fallback (#1187) remains the
fallback with the sentinel as the authoritative fast path; changeset added as part of the
implementation (CI gate).

## Risks & Mitigations

- **Risk**: variant stream-json envelope shapes across Claude CLI versions.
  **Mitigation**: duck-typed, type-guarded extraction (`message.content[]` / `result`
  string presence, not strict event-type matching); never throws on unexpected shapes.
- **Risk**: sentinel-like text quoted in ordinary prose mid-line.
  **Mitigation**: detection requires the prefix at the *start* of a trimmed embedded line,
  same contract as the raw-line path; mid-line mentions don't match.

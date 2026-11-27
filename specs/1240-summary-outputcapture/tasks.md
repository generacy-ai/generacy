# Tasks: Detect SPECKIT_IMPLEMENT sentinels inside stream-json envelopes

**Input**: Design documents from `/specs/1240-summary-outputcapture/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Setup

- [ ] T001 Confirm baseline: run `pnpm --filter @generacy-ai/orchestrator test` and verify
  `output-capture.test.ts` and `output-capture.blocked-sentinel.test.ts` pass green before any
  change (SC-002 baseline). No code edits.

## Phase 2: Core Implementation

All core work is in `packages/orchestrator/src/worker/output-capture.ts`. These tasks touch
the same file and are therefore sequential (no `[P]`).

- [ ] T002 [US2] Extract the state-mutation portions of the existing inline PARTIAL/BLOCKED
  handling in `parseLine` into private methods `applyPartialSentinel(payload, line)` and
  `applyBlockedSentinel(payload, line)` in
  `packages/orchestrator/src/worker/output-capture.ts`. Move the logic **verbatim**: PARTIAL
  keeps its JSON-parse + last-wins + `blocked_on`-preservation (#1211 Q2=A) and the
  `logger.warn(…, 'Malformed SPECKIT_IMPLEMENT_PARTIAL sentinel — ignoring')` surface (FR-005);
  BLOCKED keeps its `Array.isArray(parsed.on)` non-empty validation and warnings. No behavioral
  change.

- [ ] T003 [US2] Add private `trySentinel(line: string): boolean` in `output-capture.ts` that
  checks `line.startsWith(SENTINEL_PREFIX)` → `applyPartialSentinel` and
  `line.startsWith(SENTINEL_BLOCKED_PREFIX)` → `applyBlockedSentinel`, returning `true` on any
  prefix match (even for malformed payloads). Rewire the raw-line path in `parseLine` to call
  `trySentinel(line)`; on true, push the line as a `text` chunk exactly as today and return
  (FR-003, US2/AC2 — preserves `getOutput()` behavior).

- [ ] T004 [US1] Add private `extractEmbeddedTexts(parsed): string[]` (or generator) in
  `output-capture.ts`. Duck-typed, type-guarded, never throws: if `parsed.message` is a
  non-null object and `parsed.message.content` is an array, yield `block.text` for each element
  that is a non-null object with `block.type === 'text'` and `typeof block.text === 'string'`
  (FR-001); if `typeof parsed.result === 'string'`, yield it (FR-002). Non-matching shapes yield
  nothing.

- [ ] T005 [US1] Add private `scanEnvelopeForSentinels(parsed): void` that, for each embedded
  string from `extractEmbeddedTexts`, splits on `\n`, `trim()`s each segment, and calls
  `trySentinel(segment)` (FR-001/FR-002 line-splitting, D4 trim). Call it in `parseLine` after
  the successful `JSON.parse(line)` and before the envelope chunk is pushed. The scan adds **no**
  extra chunks to `getOutput()`; the envelope chunk is still pushed/normalized exactly as today
  (FR-004, FR-006 handled by handler idempotence — no dedup state, D5).

## Phase 3: Tests

- [ ] T006 [US1] Create new test file
  `packages/orchestrator/src/worker/__tests__/output-capture.stream-json-sentinel.test.ts`,
  mirroring the `mockLogger` + `vi.fn()` emitter pattern from
  `output-capture.blocked-sentinel.test.ts`. Cover the full Test Plan:
    - FR-001: PARTIAL as the sole line of an assistant `text` block populates `implementResult`.
    - FR-001: PARTIAL on its own line at the **end** of a multi-line `text` block (observed
      production shape) is found.
    - FR-002: PARTIAL inside a `result` event's `result` string is found.
    - US1/AC3: BLOCKED inside an assistant `text` block populates `blocked_on`.
    - FR-004: last-wins across multiple envelope sentinels; BLOCKED-then-PARTIAL preserves
      `blocked_on` (#1211 Q2=A parity).
    - FR-006: identical PARTIAL payload in both an assistant block and `result` → result equals
      observing it once (idempotent).
    - FR-005: malformed sentinel JSON inside an envelope warns and leaves `implementResult`
      undefined.
    - Robustness: `message` not an object, `content` not an array, blocks without `text`,
      non-string `result`, `null` values — neither throw nor set `implementResult`.
    - getOutput(): envelope scan adds no extra chunks; the envelope chunk itself is preserved.
    - SC-001: replay a captured-transcript-shaped fixture (init → assistant/tool envelopes →
      assistant envelope whose final text block ends with
      `SPECKIT_IMPLEMENT_PARTIAL: {"partial":true,"tasks_completed":10,"tasks_remaining":44,"tasks_total":54}`
      → `result` envelope duplicating it) and assert `implementResult` is defined with those
      counts.

## Phase 4: Changeset (CI gate — required)

- [ ] T007 [P] Hand-write `.changeset/1240-stream-json-sentinels.md` as a **newly added** file:
  `@generacy-ai/orchestrator: patch` (defect fix, `workflow:speckit-bugfix`). Must be a new file
  in the PR diff — `output-capture.ts` is a non-test `src/` change, so the changeset bot gate
  requires it. (The new `.test.ts` alone would be test-only-exempt, but the handler extraction is
  not.)

## Phase 5: Verification

- [ ] T008 [US2] Run `pnpm --filter @generacy-ai/orchestrator test` and confirm: the new
  `output-capture.stream-json-sentinel.test.ts` passes (SC-001), and the existing
  `output-capture.test.ts` + `output-capture.blocked-sentinel.test.ts` pass **unchanged**
  (SC-002, 0 regressions). SC-003 needs no phase-loop change — the existing increment path keys
  off `result.implementResult !== undefined`, now populated under stream-json.

- [ ] T009 Typecheck/build the orchestrator package (cross-package imports resolve to built
  `dist/` — rebuild dependencies first if needed) to confirm the refactor introduces no type
  errors in the new private methods.

## Dependencies & Execution Order

**Sequential chain (same file)**: T002 → T003 → T004 → T005 — all edit
`output-capture.ts`; the extraction (T002/T003) must land before the scan (T004/T005) calls the
shared `trySentinel`.

- T001 (baseline) runs first, before any edit.
- T006 (tests) depends on the core implementation (T002–T005) being in place.
- T007 (changeset) is independent of code content and can be written at any time `[P]` — but it
  is required before the PR goes green.
- T008 depends on T006 + T002–T005; T009 depends on T002–T005.

**Parallel opportunities**: only T007 is truly parallel (`[P]`). Everything else is serialized by
the single-file core change and the test-after-code ordering.

**No playbook re-pin task**: this issue edits no
`packages/claude-plugin-cockpit/commands/*.md` file, so
`playbook-verification.test.ts` does not apply.

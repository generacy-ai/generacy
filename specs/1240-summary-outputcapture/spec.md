# Feature Specification: Detect SPECKIT_IMPLEMENT sentinels inside stream-json envelopes

**Branch**: `1240-summary-outputcapture` | **Date**: 2026-11-27 | **Status**: Draft
**Issue**: [#1240](https://github.com/generacy-ai/generacy/issues/1240) | **Workflow**: speckit-bugfix

## Summary

`OutputCapture.parseLine` (`packages/orchestrator/src/worker/output-capture.ts`) detects the
`SPECKIT_IMPLEMENT_PARTIAL: ` and `SPECKIT_IMPLEMENT_BLOCKED: ` sentinels only when a **raw
stdout line starts with the prefix** (`line.startsWith(SENTINEL_PREFIX)`).

But implement phases are launched with `-p --output-format stream-json --verbose`
(`ClaudeCodeLaunchPlugin.buildPhaseLaunch`, `packages/generacy-plugin-claude-code/src/launch/
claude-code-launch-plugin.ts:172`). Under `stream-json`, **every stdout line is a JSON
envelope**. The agent's sentinel never appears at the start of a raw line — it is embedded
inside a JSON string: in an assistant message `text` content block, and again in the final
`result` event's `result` string. The `startsWith` check can therefore never match, and
`OutputCapture.implementResult` stays `undefined`.

With `implementResult` undefined, the implement→continue increment logic falls back entirely
on the tasks.md safety net (#1187). When that net cannot read `tasks.md` (e.g. the zero-padded
spec-directory issue), a genuinely partial implement is treated as **complete** and the
workflow advances after a single increment, dropping the remaining tasks.

## Observed vs. Expected

**Observed**: An implement phase ended its final text block with
`SPECKIT_IMPLEMENT_PARTIAL: {"partial":true,"tasks_completed":10,"tasks_remaining":44,"tasks_total":54}`.
The orchestrator did **not** take the increment path: no WIP commit, and implement was not
re-invoked in the same workspace. The phase advanced as if complete.

**Expected**: The orchestrator detects the sentinel, populates `implementResult`, commits WIP,
and re-invokes implement in the same workspace to continue the remaining 44 tasks.

## User Stories

### US1: Partial implement increments are detected under stream-json (Primary)

**As a** speckit workflow operator,
**I want** the orchestrator to detect `SPECKIT_IMPLEMENT_PARTIAL` / `SPECKIT_IMPLEMENT_BLOCKED`
sentinels even though phases run under `--output-format stream-json`,
**So that** a partial implement drives the increment path (WIP commit + re-invoke) instead of
being silently treated as complete.

**Acceptance Criteria**:
- [ ] A `SPECKIT_IMPLEMENT_PARTIAL` sentinel embedded in an assistant `text` content block is
      parsed and populates `implementResult`.
- [ ] The same sentinel embedded in the final `result` event's `result` string is parsed.
- [ ] A `SPECKIT_IMPLEMENT_BLOCKED` sentinel embedded in an envelope populates `blocked_on`.
- [ ] Last-wins semantics are preserved across multiple sentinels, and the
      PARTIAL-does-not-clobber-blocked_on rule (#1211 Q2=A) still holds.

### US2: Existing raw-line behavior is preserved

**As a** maintainer,
**I want** sentinels that still arrive as bare raw lines (non-stream-json paths, or any future
caller) to keep working exactly as today,
**So that** the fix is purely additive and introduces no regression.

**Acceptance Criteria**:
- [ ] A bare `SPECKIT_IMPLEMENT_PARTIAL: {…}` raw line is still detected (existing tests pass
      unchanged).
- [ ] The sentinel-bearing text is still preserved as a `text` chunk in `getOutput()`.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | After JSON-parsing a stdout line, scan assistant message `text` content blocks for the sentinel prefixes, splitting block text on `\n` so a sentinel on its own line within a multi-line block is found. | P1 | The envelope the agent's final text arrives in. |
| FR-002 | Scan the final `result` event's `result` string for the sentinel prefixes, splitting on `\n`. | P1 | The duplicate copy the issue calls out. |
| FR-003 | Preserve the existing raw-line `startsWith` detection as a fallback so non-envelope callers are unaffected. | P1 | Purely additive. |
| FR-004 | Apply the same JSON-parse + validation + last-wins + `blocked_on`-preservation logic (#1211) to sentinels found inside envelopes as to raw-line sentinels. | P1 | No divergence between the two code paths. |
| FR-005 | Malformed sentinel JSON found inside an envelope is warned and ignored, matching raw-line behavior. | P2 | Same `logger.warn` surface. |
| FR-006 | Deduplicate when the same sentinel appears in both an assistant `text` block and the `result` string within one phase — the net effect must equal observing it once (last-wins is idempotent for identical payloads). | P2 | Avoid double-processing side effects. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | A real captured stream-json transcript whose implement phase emitted a PARTIAL sentinel yields a defined `implementResult`. | 100% | Unit test fixture replaying captured envelopes. |
| SC-002 | Existing `output-capture` and `output-capture.blocked-sentinel` tests pass unchanged. | 0 regressions | `pnpm --filter @generacy-ai/orchestrator test`. |
| SC-003 | A partial implement under stream-json takes the increment path (non-undefined `implementResult`) without relying on the tasks.md fallback. | Yes | Integration-level assertion in the phase-loop increment path. |

## Assumptions

- The Claude CLI `stream-json` envelope shapes are: an assistant event carrying
  `message.content[]` with `{ type: 'text', text }` blocks, and a terminal `result` event
  carrying a `result` string. The parser must tolerate missing/variant fields and never throw
  on an unexpected envelope shape.
- Sentinel payload schemas are unchanged (`ImplementPartialResult`, `{ on: string[] }`).
- Last-wins is the correct resolution when a sentinel appears in multiple envelopes.

## Out of Scope

- Reworking `KNOWN_TYPES` / general envelope-type normalization in `OutputCapture`.
- The zero-padded spec-directory tasks.md-readability issue (tracked separately); this fix
  removes the *dependence* on that safety net but does not fix it.
- Changing launch flags (keeping `--output-format stream-json`).
- Non-implement sentinels or new sentinel vocabulary.

---

*Generated by speckit*

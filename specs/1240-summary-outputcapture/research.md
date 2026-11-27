# Research: Detect SPECKIT_IMPLEMENT sentinels inside stream-json envelopes

**Issue**: #1240 | **Branch**: `1240-summary-outputcapture`

## Root cause confirmation

- `OutputCapture.parseLine` (`packages/orchestrator/src/worker/output-capture.ts:128,157`)
  gates sentinel detection on `line.startsWith(SENTINEL_PREFIX)` against the **raw stdout
  line**.
- Implement phases launch with `-p --output-format stream-json --verbose`
  (`ClaudeCodeLaunchPlugin.buildPhaseLaunch`,
  `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts:172-178`).
- Under `stream-json`, every stdout line is a JSON envelope; agent text is carried inside
  `message.content[].text` of assistant events and duplicated in the terminal `result`
  event's `result` string. A raw line therefore starts with `{"type":...`, never with the
  sentinel prefix → `implementResult` is always `undefined` under stream-json.
- Downstream, the phase-loop increment path triggers only on
  `result.implementResult !== undefined`; otherwise the tasks.md safety net (#1187,
  `worker/tasks-md-fallback.ts`) is the sole backstop, and it returns `unreadable` →
  advance for the zero-padded spec-directory case, which is the observed data-loss path.

## Decisions

### D1: Scan inside `OutputCapture.parseLine`, not a new parser layer

**Decision**: add envelope scanning directly in `OutputCapture` after the successful
`JSON.parse`.

**Rationale**: `OutputCapture` already owns sentinel state (`_implementResult`), the #1211
merge semantics, and the logging surface. Adding the scan there keeps one source of truth
(FR-004: no divergence between code paths).

**Alternatives considered**:
- *Pre-split embedded text upstream (e.g. in the process executor) and feed synthetic raw
  lines into `processChunk`*: rejected — would double-report text as both envelope chunks
  and synthetic text chunks, corrupting `getOutput()`, and spreads sentinel knowledge
  across layers.
- *Use `ClaudeCodeLaunchPlugin.createOutputParser`*: rejected — it is an explicit no-op
  ("existing callers manage their own OutputCapture", deferred to Wave 3); the phase path
  uses `OutputCapture` today.
- *Change launch flags away from stream-json*: explicitly out of scope per spec.

### D2: Shared handler extraction over duplicated logic

**Decision**: extract the existing PARTIAL/BLOCKED handling into private methods
(`trySentinel` → `applyPartialSentinel` / `applyBlockedSentinel`) called by both the
raw-line path and the envelope scan.

**Rationale**: FR-004 requires identical parse/validate/last-wins/`blocked_on`-preservation
behavior in both paths; duplication would let them drift. The raw-line path keeps its
text-chunk push (US2/AC2); the envelope path pushes nothing extra because the envelope
chunk is already buffered.

**Alternative**: inline a second copy of the handlers in the scan — rejected (drift risk,
#1211 Q2=A subtlety is easy to re-implement wrongly).

### D3: Duck-typed envelope extraction, not event-type matching

**Decision**: extract embedded text wherever the shape matches —
`parsed.message.content[]` entries with `{ type: 'text', text: string }`, and
`typeof parsed.result === 'string'` — without requiring `parsed.type === 'assistant'` /
`'result'`.

**Rationale**: the spec assumption requires tolerating missing/variant fields and never
throwing. Duck-typing survives CLI envelope evolution (e.g. type renames, extra wrapper
fields) and costs nothing: non-matching shapes yield no strings.

**Alternative**: strict discriminated-union validation (Zod) of CLI envelopes — rejected
as over-engineering for a scan that must fail open; `OutputCapture` deliberately has no
Zod dependency today.

### D4: Line-splitting + trim before prefix match

**Decision**: split every embedded string on `\n`, `trim()` each piece, then apply the
same `startsWith` prefix check.

**Rationale**: FR-001/FR-002 mandate `\n` splitting so a sentinel on its own line inside a
multi-line block is found. Trimming tolerates incidental leading whitespace while still
requiring the sentinel to open its line — mid-sentence mentions of the sentinel string do
not match, same contract as the raw path.

### D5: Idempotence instead of explicit dedup state (FR-006)

**Decision**: rely on the handlers being idempotent for identical payloads; add no
seen-set.

**Rationale**: PARTIAL applies `{...parsed}` with a deterministic `blocked_on` merge;
BLOCKED sets `blocked_on` to the parsed array. Applying the same payload twice yields a
deep-equal result — "the net effect must equal observing it once" is satisfied by
construction. Distinct payloads correctly keep last-wins. A seen-set would add state and
subtly break last-wins for repeated-then-changed sequences.

## Implementation patterns referenced

- Existing sentinel tests (`__tests__/output-capture.blocked-sentinel.test.ts`) define the
  merge-semantics contract the envelope path must replicate; the new test file mirrors
  their structure.
- `mockLogger` + `vi.fn()` emitter pattern from existing tests reused for the new file.
- Changeset shape: patch bump for `@generacy-ai/orchestrator` (defect fix per CLAUDE.md
  changeset rules for `workflow:speckit-bugfix`).

## Key sources

- `packages/orchestrator/src/worker/output-capture.ts` (current parser)
- `packages/orchestrator/src/worker/types.ts:178-185` (`ImplementPartialResult`)
- `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts:172-199`
  (stream-json launch flags)
- Issue #1240 (observed transcript), #1211 (blocked_on semantics), #1187 (tasks.md
  fallback)

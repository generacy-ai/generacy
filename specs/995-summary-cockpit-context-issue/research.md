# Research: fix `cockpit_context` clarification-comment finder against label re-application

## Decision log

### R1 — Marker predicate is already exported (no re-export refactor needed)

**Decision**: Import `matchClarificationQuestionMarker` from `@generacy-ai/orchestrator` directly.

**Evidence**: `packages/orchestrator/src/index.ts:268-275` re-exports:
```
CLARIFICATION_QUESTION_MARKERS,
commentCarriesQuestionMarker,
matchClarificationQuestionMarker,
CLARIFICATION_ANSWER_MARKERS,
commentCarriesAnswerMarker,
matchClarificationAnswerMarker,
```
`@generacy-ai/generacy` already depends on `@generacy-ai/orchestrator` (`packages/generacy/package.json:46`) and other cockpit files already import from it (`resume.ts:34`, `gate-vocabulary.ts:22`, `clarification-answer-marker.ts`).

**Alternatives considered**:
- **Duplicate the marker inventory in cockpit** — rejected. Violates FR-006 ("no divergent matcher") and Assumption 1 of the spec. Registry drift is the failure mode the fix is closing.
- **Extract markers to a fresh `@generacy-ai/clarification-markers` shared package** — rejected. Orchestrator already owns the registry, is already imported here, and no other package needs it independently. Extraction would be pure ceremony.

**Rationale**: Zero refactor cost, matches how other cockpit files consume orchestrator exports today.

---

### R2 — Fallback path is verbatim today's code, not a new implementation

**Decision**: The `FR-005` fallback branch executes the current label-timeline heuristic byte-for-byte, guarded by a warn log at the branch entry.

**Evidence**: Q2 answer (clarifications.md:24) explicitly reasons "the fallback is literally today's code path — no new complexity." The current implementation lives at `packages/generacy/src/cli/commands/cockpit/clarification-comment-finder.ts:55-79`.

**Alternatives considered**:
- **Rewrite the fallback to also be marker-aware** — rejected. Circular: if a marker existed, pass 1 would have returned. The fallback exists precisely for the no-marker case.
- **Delete the fallback outright (marker-only)** — rejected. Q2 option A regresses pre-marker legacy issues that work today. Q2 answer picks option C.
- **Emit a warn per-comment instead of per-invocation** — rejected. Bounded log volume matters for legacy issues that stay in the fallback until the poster fix ships.

**Rationale**: Preserves today's baseline for legacy issues, isolates the fix to a positive-identification prepass, gives operators one signal per fallback trigger for measurement.

---

### R3 — Latest-batch tiebreak is `createdAt` descending

**Decision**: `markerHits.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))`; return `markerHits[0]`.

**Evidence**: FR-002 says "the one with the *latest* `createdAt`". Downstream consumer (`/cockpit:auto` D.1) parses `Q<n>:` prompts from the returned comment body — it needs the current open-question set, which is always the newest batch.

**Alternatives considered**:
- **Return all marker hits (change signature)** — rejected. FR-008 / spec Out-of-Scope forbid signature change. Downstream expects `IssueComment | null`.
- **Prefer higher batch number parsed from `<!-- generacy-clarifications:N -->` marker suffix** — rejected. Complexity buys nothing over `createdAt` (batch N is always posted after batch N-1), and it wouldn't work for markers that don't carry a numeric suffix (e.g., `<!-- generacy-stage:clarification -->`).

**Rationale**: Timestamp ordering is monotonic with batch ordering by construction. Simpler predicate, one sort call.

---

### R4 — Warn log format

**Decision**: `getLogger().warn({ owner, repo, issue: number }, 'marker-less clarification comment; poster should be updated — issue=<owner/repo#N>')`

**Structured fields**: `{ owner, repo, issue }` for grep/aggregation. Message string carries the human-readable `<owner/repo#N>` coordinate so a `grep marker-less` in raw logs also self-explains.

**Alternatives considered**:
- **Info level** — rejected. Deprecation signal deserves `warn`.
- **Error level** — rejected. Not an error; the fallback succeeded.
- **No structured fields** — rejected. Log aggregation needs the coordinate as a field, not just embedded in the message.

**Rationale**: Matches the pattern used elsewhere in cockpit and the spec's Q2 answer wording.

---

### R5 — Stage-status exclusion continues to apply to both passes

**Decision**: Both the marker-first pass and the timeline fallback pass filter candidates through `isStageStatusComment`.

**Evidence**: Existing tests on line 92, 135, 163, 185, 206 all encode this behavior against the timeline path; FR-003 requires it to continue. Applying it to the marker path costs nothing (the two `generacy-stage:clarification*` overrides in `CLARIFICATION_STAGE_OVERRIDE_PREFIXES` at lines 24-27 mean a legitimate clarification-batch stage banner is not rejected).

**Rationale**: Symmetric behavior across both paths; preserves the intent of the existing override system.

---

## Sources / references

- `packages/generacy/src/cli/commands/cockpit/clarification-comment-finder.ts` — current implementation (80 lines).
- `packages/generacy/src/cli/commands/cockpit/__tests__/clarification-comment-finder.test.ts` — current test suite (227 lines, 9 tests).
- `packages/orchestrator/src/worker/clarification-markers.ts` — marker registry (163 lines).
- `packages/orchestrator/src/index.ts:268-275` — re-export surface.
- `packages/generacy/src/cli/commands/cockpit/context.ts:228` — only call site.
- `specs/995-summary-cockpit-context-issue/spec.md` — feature spec.
- `specs/995-summary-cockpit-context-issue/clarifications.md` — Q1/Q2 resolutions.
- CLAUDE.md L14-L59 — changeset gate rules.
- Snappoll #8 (2026-07-18) — evidence cited in spec §Root cause.

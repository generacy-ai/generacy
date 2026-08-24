# Research: Engine-side tasks.md safety net

## Decision 1 — Synthesize `implementResult` rather than duplicate the increment machinery

**Decision**: When implement succeeds with no sentinel and tasks.md has unchecked
tasks, set a synthetic `result.implementResult = { partial: true, tasks_remaining,
tasks_completed, tasks_total }` and let the existing block at `phase-loop.ts:873–937`
drive the re-entry.

**Rationale**: FR-002 mandates reuse of the block at 873–937 (WIP commit/push,
fresh session, `i--; continue`). The block already gates on
`result.implementResult?.partial`. Producing the same shape from the fallback is
the minimal change that reuses 100% of that machinery — including the no-progress
guard at 877 (satisfies FR-003 for free, since the guard reads
`result.implementResult.tasks_remaining`).

**Alternatives considered**:
- *Parallel re-entry path* — a second copy of the commit/push/`i--` logic gated on
  a fallback flag. Rejected: duplicates ~65 lines, two places to keep in sync,
  and risks SC-005 drift.
- *Mutate the loop index directly from the evaluator* — rejected: spreads
  phase-loop control flow into a helper; violates the single-responsibility of the
  evaluator (which should be pure/FS-only, no loop state).

## Decision 2 — Clarification resolutions (Q1–Q4)

The `clarifications.md` "Answer" sections restate the options without selecting.
Resolved from the spec's internal constraints:

- **Q1 = A (sentinel authoritative)**: FR-001 gates the fallback on
  `result.implementResult === undefined`; SC-005 requires the sentinel path to be
  byte-identical. A present sentinel reporting complete is trusted even if tasks.md
  disagrees. (Option B would change sentinel-present behavior and break SC-005.)
- **Q2 = B (per-path count source)**: The sentinel path keeps the agent's
  self-reported count; the fallback feeds the tasks.md unchecked count. Because the
  fallback only runs when the sentinel is absent, a single continuation never mixes
  the two sources within its no-progress comparison, so the "mixed run" hazard the
  question raises cannot occur. Preserves SC-005. (Option A would alter the
  sentinel path's guard input, risking SC-005.)
- **Q3 = A (no absolute cap)**: FR-002/FR-003 say "reuse the existing block," which
  has only the no-progress guard. US3 references the guard, not a new counter.
  As long as the unchecked count strictly decreases, re-entry continues; a stuck
  agent (no decrease) trips the guard and escalates. (Option B adds machinery the
  spec does not require.)
- **Q4 = A (zero task lines = complete)**: FR-004 grants `completed:implement` when
  tasks.md has zero unchecked tasks **or** no tasks.md / no task lines exist — a
  found-but-taskless file is a legitimately task-less story and advances normally.
  FR-006's "cannot be located or read" is reserved for genuine failure (missing /
  ambiguous dir, I/O / decode error). (Option B lumps taskless with error and
  spams the FR-006 log.)

## Decision 3 — Checkbox grammar

**Decision**: Regex `^[ \t]*[-*+] \[( |x|X)\]` per line. Unchecked iff the capture
is a single space; checked iff `x` or `X`. Non-matching lines are ignored.

**Rationale**: FR-007 names the `- [ ]` / `- [x]` / `- [X]` grammar the implement
prompt writes. Allowing `*`/`+` bullets and leading whitespace matches how Markdown
renderers and the tasks.md the prompt emits behave, without over-parsing prose.
Any other bracket content (e.g. `[~]`, `[-]`) is not a recognized task line and is
ignored — it counts as neither checked nor unchecked, so it cannot strand a story.

## Decision 4 — Feature-dir resolution and fail-open classification

**Decision**: Resolve `specs/{issueNumber}-*` under `context.checkoutPath` via
`readdirSync` + prefix-match (same convention as `epic-post-tasks.ts:293`), but
classify explicitly:

| Situation | Classification | Advance? | FR-006 log? |
|-----------|----------------|----------|-------------|
| One matching dir, tasks.md with ≥1 unchecked | `incomplete` | no (re-enter) | no |
| One matching dir, tasks.md all checked | `complete` | yes | no |
| One matching dir, tasks.md with zero task lines | `complete` | yes | no |
| specs dir missing / no matching dir | `unreadable` | yes | yes |
| Multiple matching dirs (ambiguous) | `unreadable` | yes | yes |
| tasks.md missing in the matched dir | `unreadable` | yes | yes |
| tasks.md present but read/decode error | `unreadable` | yes | yes |

**Rationale**: `epic-post-tasks.ts` uses first-match and a synthetic fallback path
because it is a different flow (child-issue creation). For the safety net,
ambiguity must **fail open** (FR-006) rather than silently pick a dir — picking the
wrong dir could either strand a complete story or loop a task-less one. Zero task
lines is deliberately **not** unreadable (Q4=A / FR-004).

## Decision 5 — Injection seam

**Decision**: Add an optional `PhaseLoopDeps` field (e.g.
`evaluateTasksMd?: (context) => TasksMdEvaluation`) defaulting to the real
FS-backed evaluator; `claude-cli-worker.ts` wires the default.

**Rationale**: Mirrors the existing optional-injection DI pattern
(`remediateTrigger`, `readFindingsArtifact`, `phaseTracker`, `reviewExecutor`).
Keeps the phase-loop test suite able to drive the fallback deterministically
without touching the filesystem, while production behavior is on by default
(no feature flag — the spec treats this as a correctness fix, not an opt-in).

## Evidence anchor (#26 incident)

`finetooth / Painworth/doc-intel#26, PR #73`: implement commit `c3dbdee` checked
T001–T011, left T012–T026 (15 tasks) unchecked, stopped with `stop_reason:
end_turn` and **no** sentinel. Engine granted `completed:implement`, review found
the deliverable absent, remediation burned all 3 rounds and hit
`waiting-for:remediation-limit`. This fixture (T001–T011 checked / T012–T026
unchecked, no sentinel) is the SC-002 regression target: the fallback must
classify `incomplete` and re-enter implement.

## Sources / references

- `packages/orchestrator/src/worker/phase-loop.ts:873–942` — increment block + guard + reset.
- `packages/orchestrator/src/worker/output-capture.ts:117` — `SENTINEL_PREFIX`; confirms `implementResult === undefined` on omission.
- `packages/orchestrator/src/worker/types.ts:178` — `ImplementPartialResult` shape.
- `packages/orchestrator/src/worker/epic-post-tasks.ts:293` — dir-resolution convention.

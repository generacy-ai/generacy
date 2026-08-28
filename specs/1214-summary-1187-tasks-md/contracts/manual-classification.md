# Contract: Manual-task classification + manual-validation pause protocol (#1214)

Consumers: `tasks-md-fallback.ts` (classifier), `phase-loop.ts` (pause path), tests. This contract pins the observable rules; implementation details may vary.

## 1. Classification (FR-005/006/007, Q2=B, Q3=A)

Applied per unchecked task line, both grammars (checkbox `- [ ] T…`, heading `### T… …`).

**Tier 1 — marker (high confidence)**
- Pattern: literal bracketed token, case-insensitive: `/\[manual\]/i`.
- Position: anywhere in the task line — checkbox: anywhere after `- [ ]`; heading: anywhere after the task ID.
- MUST NOT affect checked/unchecked counting.
- MUST NOT interact with the strict `HEADING_DONE` `[DONE]`-after-ID rule: a heading line carrying both `[DONE]` (immediately after ID) and `[manual]` (anywhere) counts as **checked**.

**Tier 2 — keywords (medium confidence, only when Tier 1 does not match)**
- Keywords: `manual`, `manually`, `hand-test` — case-insensitive, whole-word (`\b` boundaries).
- Window: the first **4 whitespace-delimited words** of the task text, where task text starts after the checkbox capture (checkbox grammar) or after the task ID + optional `[DONE]` token (heading grammar).
- `manuals`, `manual-` prefixed compounds other than `hand-test` do NOT match (whole-word rule).

**Aggregation**
- `manual` = number of unchecked tasks classified manual. `automatable = unchecked - manual`.
- `unchecked > 0 && automatable === 0` → evaluation kind `manual-only`.
- `automatable > 0` → kind `incomplete` with `{ unchecked, automatable, manual, checked, total }`.
- `unchecked === 0` → `complete`; I/O or resolution failure → `unreadable` (both byte-identical to #1187).

## 2. Safety-net decision table (FR-001..004, 007, 008; Q4=A)

Evaluated only when `phase === 'implement' && result.success && result.implementResult === undefined` (sentinel absent — sentinel path untouched, SC-007).

| Label read | `waiting-for:manual-validation` | Evaluation | Action |
|---|---|---|---|
| ok | present | any | **Pause** (§3). If `automatable > 0`, also emit structured divergence warn. Never synthesize. |
| ok | absent | `manual-only` | **Pause** (§3). |
| ok | absent | `incomplete` | Synthesize partial from **automatable** count only; re-enter as today. |
| ok | absent | `complete` / `unreadable` | Advance (byte-identical to #1187). |
| failed | unknown | any | Warn, then behave per the label-absent rows (fail-open to classification, never blind re-entry). |

## 3. Pause sequence (FR-001/002, Q1=A, Q5=A)

Ordered; mirrors #1211 structurally and #1133 for labels:

1. `wip = prManager.commitPushAndEnsurePr('implement', { message: 'wip(speckit): pause for manual validation …' })`
2. If `wip.pushRefused` → abort: `return { results, completed: false, lastPhase: 'implement', gateHit: false }` (#1051; no labels applied).
3. If `wip.prUrl` → `context.prUrl = wip.prUrl`.
4. `await labelManager.onPhaseComplete('implement')` — grants `completed:implement` (completed-at-pause, second gate after #1133; the comment at `phase-loop.ts:1930-1932` MUST be updated).
5. `await labelManager.onGateHit('implement', 'waiting-for:manual-validation')` — applies gate + `agent:paused`; its removeLabels is a no-op (safe vs. #958 assumption).
6. `return { results, completed: false, lastPhase: 'implement', gateHit: true }`.

**Resume**: operator applies `completed:manual-validation` → label monitor enqueues `continue` → resolver resumes at `validate` (`GATE_MAPPING['manual-validation'].resumeFrom`), resolving cleanly because `completed:implement` exists. Standard resume strip removes `completed:manual-validation` + `waiting-for:manual-validation` + `agent:paused`; `completed:implement` survives (phase completion, not gate completion).

## 4. No-progress guard (FR-009/010)

When the guard fires (`tasksRemaining >= lastTasksRemaining`): re-run the §2 evaluation (label + classification). Human-gated remainder (label present OR `manual-only`) → §3 pause instead of `failed:implement` escalation. Otherwise the existing failure path is byte-identical.

## 5. Invariants (SC targets)

- Zero new label vocabulary; zero GATE_MAPPING / resolver / label-monitor / cockpit changes (SC-008).
- Stories without manual tasks and without the label behave byte-identically to #1187 (SC-005/006).
- Sentinel-present flow through the increment block unchanged (SC-007).
- Fixtures #2723 (keyword tier: "Manually verify …" T028/T029) and #2714 (marker tier: `[manual]`) MUST classify manual (SC-009).

# Contract (pin/cross-reference): review⇄remediate loop convergence

**Status**: Pinned by #1132 (P3 integration checkpoint). **Authorship home**: #1128 (remediate executor + counter + cap gate), #1129 (validate→remediate routing), #1130 (monitor exclusion + external-feedback routing), #1131 (merge-conflict re-arm → resolution-scoped review). This note **asserts against and cross-references** those; it authors nothing new.
**Owner phase**: worker phase loop (`packages/orchestrator/src/worker/phase-loop.ts`) + PR manager (`pr-manager.ts`) + `PrFeedbackMonitorService`.
**Depends on**: the `remediate → review` loop-control seam pinned in `specs/1123-context-phase-1-integration/contracts/remediate-review-seam.md`, and the marker + findings-artifact shapes pinned in `specs/1127-context-phase-2-integration/contracts/engine-review-integration.md`.

This is the durable acceptance artifact for FR-007. It fixes the boundaries the full loop converges across, so P4 does not re-derive them from unmerged code.

## 1. Phase sequencing & off-sequence backtrack

The effective sequence with `reviewPhaseEnabled` is `… → implement → review → validate → …` (`getPhaseSequence(workflow, true)`, `types.ts:84-89`). `remediate` is **off-sequence** — never in the linear sequence.

| Rule | Value |
|---|---|
| Review→remediate entry | `if (phase === 'review' && result.success && deps.remediateTrigger?.(context))` → `onPhaseStart('remediate')` → remediate executor → `onPhaseComplete('remediate')` → `reviewRound++` → `i--; continue;` (`phase-loop.ts:1270-1284`) |
| Backtrack invariant | The `i--; continue;` re-enters the immediately-preceding `review` for a **delta-scoped** re-review (seam contract §1123) |
| Forward termination | A green `validate` terminates the loop forward — no further backtrack |

## 2. Three remediate entry points (+ one deferred)

All three converge on the **same** off-sequence `remediate` backtrack:

| # | Entry point | Owner | Driven by |
|---|---|---|---|
| 1 | Review blocking verdict | #1124 verdict → #1128 executor | US1 AC1–AC3 |
| 2 | `validate` failure | #1129 routing | US1 AC4 |
| 3 | External human PR feedback | #1130 routing | US3 |
| 4 (deferred) | Merge-conflict re-arm → resolution-scoped review | #1131 | **pinned only, no scenario (Q1=B)** |

**#1131 (Out of Scope here)**: its re-arm target is a resolution-scoped review — the same `review` phase this loop converges through. Cross-referenced so P4 knows the fourth entry exists; #1132 ships no merge-conflict scenario.

## 3. Remediation counter & cap gate (authored by #1128)

| Rule | Value |
|---|---|
| Counter | increments per off-sequence `remediate` entry |
| `maxRemediations` | feature **3** / bugfix **2** (`config.ts:32,66`, `resolveWorkflowOverrides`) |
| Cap gate | `on-remediation-limit` raises `waiting-for:remediation-limit` when `round >= maxRemediations` (`config.ts:172,179`; scaffold `phase-loop.ts:1122-1147`) |
| Never terminal | the cap raises `waiting-for:remediation-limit` + `agent:paused` — **never** a terminal `blocked:*` (SC-003) |
| Surfacing | remaining `open` findings are surfaced at the pause point (FR-002) |
| Reset | on a human answer through the gate/resume seam, **the counter resets to zero** and the loop resumes (**#1128 owns reset; today's gate pauses but never resets**) |

**Pinned by #1132**: `phase-loop.remediation-cap.integration.test.ts` asserts the pause + `waiting-for:remediation-limit` (zero terminal `blocked:*`), open findings surfaced, counter reset on the human answer, and forward convergence after reset — binding the concrete reset trigger to whatever #1128 ships (Q4=C).

## 4. Draft/ready lifecycle (authored by #1125)

| Behavior | Rule |
|---|---|
| Clean verdict | `prManager.markReadyForReview(...)` → loop advances into `validate` |
| Remediate entry | if the PR was engine-marked ready, `convertToDraftIfEngineMarkedReady(...)` converts it **back to draft** before the backtrack (`phase-loop.ts:1275`) |
| Human-ready PRs | never converted to draft (engine-marked-ready flag gates the conversion) |

## 5. Engine-thread exclusion boundary (authored by #1130)

| Rule | Value |
|---|---|
| Marker | `generacy-engine-review` (`review-poster.ts:23`), matched by `matchEngineAuthoredReviewMarker(body)` (`review-poster.ts:64`) |
| Exclusion | the **real** `PrFeedbackMonitorService` excludes engine-authored threads from external-feedback→remediate routing (Q3=A) |
| External routing | genuine external human feedback on a ready PR routes into `remediate` and converts the PR back to draft |

**Pinned by #1132**: `pr-feedback-external-remediate.integration.test.ts` drives the real monitor — external feedback re-enters `remediate` (AC1); an engine-authored marker-carrying thread is excluded (AC2 / SC-004); a clean re-review re-marks ready and converges (AC3).

## 6. Change control

Changing the phase sequencing (§1), the entry points (§2), the counter/cap/reset semantics (§3), the draft/ready rules (§4), or the exclusion boundary (§5) requires editing the **authoring** contract in #1128/#1129/#1130/#1131 (or the #1124/#1125 pins) and updating this note's cross-reference. #1132's three integration scenarios are the drift alarm: any change to these boundaries the dependencies make without updating their contracts will fail the P3 convergence suite.

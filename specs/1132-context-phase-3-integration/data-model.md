# Data Model: Full review⇄remediate loop end-to-end (Phase-3 integration)

Issue: generacy-ai/generacy#1132

This issue introduces **no new production types** (FR-008). It consumes types delivered by #1124/#1125/#1128/#1129/#1130 and pins their contract shapes. The entities below are what the integration scenarios bind to and what the loop-contract note documents; their **authorship home** is the dependency PRs (D-6).

## Consumed entities (authored by dependencies)

### FindingsArtifact (sidecar) — authored by #1124, consumed by #1128 remediate

Engine-internal structured output of the `review` phase over the PR diff (pause-context sidecar pattern; never GitHub review state as source of truth). US1/US2 steer each round by **seeding this sidecar** (Q2=A); the real executor recomputes the verdict via `computeVerdict`.

| Field | Type | Notes |
|---|---|---|
| `findings[]` | `Finding[]` | May be empty (clean verdict). |
| `verdict` | `'clean' \| 'changes-required'` | Recomputed by `computeVerdict`; agent-claimed verdict is ignored. |
| `round` | `number` | Re-review round counter; drives the `on-remediation-limit` gate comparison. |

### Finding — authored by #1124

| Field | Type | Notes |
|---|---|---|
| `severity` | `'critical' \| 'major' \| 'minor'` | Matches `blockingSeverity` enum in `config.ts:13`. |
| `status` | `'open' \| 'resolved'` | Re-review resolution state; round-2 steering flips one to `resolved`. |
| `file` / `line` | `string` / `number` | Inline-thread anchor. |
| `body` | `string` | Finding text (posted as an inline COMMENT thread). |

**Blocking rule** (consumed, not implemented here): verdict is `changes-required` iff any finding is `status:'open'` with `severity` at/above the resolved `review.blockingSeverity` (default `critical`, from `resolveWorkflowOverrides` in `config.ts`).

### RemediationCounter + cap gate — authored by #1128

The counter increments per off-sequence `remediate` entry; the `on-remediation-limit` gate pauses when `round >= maxRemediations`.

| Concern | Location / value | Notes |
|---|---|---|
| `maxRemediations` | `config.ts:32,66` via `resolveWorkflowOverrides` | feature **3** / bugfix **2**. |
| Gate config | `config.ts:172,179` | `{ phase: 'review', gateLabel: 'waiting-for:remediation-limit', condition: 'on-remediation-limit' }`. |
| Gate scaffold | `phase-loop.ts:1122-1147` | pauses on `round >= maxRemediations && verdict === 'changes-required'` — **#1128 adds the reset** (absent today). |
| Resume target | `phase-resolver.ts:17` | `'remediation-limit': { phase: 'review', resumeFrom: 'review' }`. |
| Reset trigger | **#1128 (bound at implement time, Q4=C)** | label-driven gate/resume seam, not a comment payload. |

### EngineAuthoredReviewMarker — authored by #1125, routed on by #1130

A stable HTML-comment marker stamped by deterministic code (never LLM free-write) on every engine-authored review comment/thread.

| Property | Value / rule |
|---|---|
| Prefix | `generacy-engine-review` (`review-poster.ts:23` `REVIEW_BODY_MARKER_PREFIX`) |
| Matcher | `matchEngineAuthoredReviewMarker(body): string \| undefined` (`review-poster.ts:64`) |
| Anchoring | Line-anchored at column 0 |
| Case | Case-sensitive ASCII |
| Quoted | `> `-prefixed (quoted) markers do **not** match |
| Authorship | Stamped exclusively by deterministic code |

**Consumer (#1130)**: wires `matchEngineAuthoredReviewMarker` into `PrFeedbackMonitorService` routing to **exclude** engine-authored threads from external-feedback→remediate processing. US3 drives the **real** monitor (Q3=A).

## Test-only entities (this issue)

### Seeded findings sidecar (per-round steering) — Q2=A

The harness writes the candidate `FindingsArtifact` for each round before the review pass, mirroring the real agent's write. No production type; it is the same sidecar the real executor reads.

### Simulated human answer at the cap gate — Q4=C

Injected through whatever reset/resume seam #1128 ships (a gate-resume label event via the phase-loop gate seam). The harness asserts only the observable counter-reset + convergence, not the concrete trigger shape.

### Mocked external PR feedback thread — US3

A `GitHubClient` spy returns (a) a genuinely external human review thread (routes into `remediate`) and (b) an engine-authored thread carrying the marker (`matchEngineAuthoredReviewMarker(body) !== undefined`, excluded).

## Relationships

- `review` executor (#1124) **produces** `FindingsArtifact`; the real `remediate` executor (#1128) **consumes** it and increments the `RemediationCounter`; `markReadyForReview` / draft-conversion (#1125) is **gated by** the verdict.
- A `validate` **failure** (#1129) **routes into** the same off-sequence `remediate` backtrack (the second entry point).
- Genuine external feedback (#1130) **routes into** `remediate` (the third entry point); `EngineAuthoredReviewMarker`-carrying threads are **excluded** by the real `PrFeedbackMonitorService`.
- The `on-remediation-limit` gate (#1128) **pauses** the loop at `maxRemediations`; a human answer **resets** the counter and **resumes** convergence.
- Merge-conflict re-arm → resolution-scoped review (#1131) is a **fourth, deferred** entry point — pinned in the contract, not scenario-tested (Q1=B).
- `review`/`remediate` both map to the `implementation` stage (`PHASE_TO_STAGE`, `types.ts`) — no new `StageType`.

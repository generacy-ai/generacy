# Contract (pin/cross-reference): engine review integration — marker + findings artifact

**Status**: Pinned by #1127 (P2 integration checkpoint). **Authorship home**: #1124 (findings artifact + verdict) and #1125 (engine-authored marker + COMMENT-event posting) per Q2=B. This note **asserts against and cross-references** those contracts; it authors nothing new.
**Owner phase**: worker phase loop (`packages/orchestrator/src/worker/phase-loop.ts`) + PR manager (`pr-manager.ts`).
**Depends on**: the `remediate → review` loop-control seam pinned in `specs/1123-context-phase-1-integration/contracts/remediate-review-seam.md`.

This is the durable acceptance artifact for FR-006 / FR-007 / SC-006. It fixes the two boundaries P3 (#1128 remediate executor, #1130 monitor exclusion + external-feedback routing) builds against, so they do not re-derive them from unmerged code.

## 1. Engine-authored review marker (FR-006 — authored by #1125)

Every engine-authored review comment/thread carries a stable HTML-comment marker, stamped exclusively by **deterministic code** (never LLM free-write).

| Rule | Value |
|---|---|
| Prefix shape | `<!-- generacy-<dialect>:… -->` (exact dialect/suffix owned by #1125's marker module) |
| Match rule | Line-anchored at column 0; case-sensitive ASCII; `> `-quoted markers do **not** match |
| Authorship | Stamped by the posting path in #1125 only; never by the review agent's free-text |
| Match helper | A standalone deterministic `match…Marker(body): boolean\|string\|undefined`, marker-family precedent (`clarification-markers.ts`) |

**Consumer (#1130, Out of Scope here)**: wires this match helper into `PrFeedbackMonitorService` routing to **exclude** engine-authored threads from external-feedback processing. `PrFeedbackMonitorService` has no engine-authored exclusion predicate today (only the `isTrustedCommentAuthor` trust filter at `pr-feedback-monitor-service.ts:267-286`); #1127 does **not** modify it (Q4=B / SC-005).

**Pinned by #1127**: `engine-authored-marker.test.ts` asserts the match helper returns "exclude"/match for an engine-authored review body and non-match for a plain external comment and a `> `-quoted marker.

## 2. Findings artifact (FR-007 — authored by #1124)

The `review` phase's structured output (engine-internal sidecar, pause-context pattern). GitHub review state is **never** the source of truth.

| Field | Type | Notes |
|---|---|---|
| `findings[].severity` | `'blocking' \| 'advisory'` | the finding's **own** severity (`review-findings-artifact.ts`). Distinct from the `blockingSeverity` *threshold* (`'critical' \| 'major' \| 'minor'`, `config.ts:13`) against which the verdict is computed — do not conflate |
| `findings[].file` / `.line` | `string` / `number` | inline-thread anchor |
| `findings[].body` | `string` | posted as an inline `COMMENT` thread |
| `round` | `number` | delta-scoped re-review round counter |
| `verdict` | overall clean vs changes-required | "clean" ⇒ no `open` finding at/above the resolved `blockingSeverity` threshold |

**Blocking rule**: verdict is "changes-required" iff any finding is at/above the resolved `review.blockingSeverity` (`resolveWorkflowOverrides`, `config.ts`). This is the shape P3 remediate (#1128) consumes.

## 3. Posting + lifecycle (authored by #1125)

| Behavior | Rule |
|---|---|
| Review event | `COMMENT` — **never** `REQUEST_CHANGES` on the cluster account's own PR (422 footgun closed by construction) |
| Clean verdict | `prManager.markReadyForReview(...)` → loop advances into `validate` |
| Blocking verdict | off-sequence toward `remediate` (stub here); if PR was ready, convert **back to draft** |

**Pinned by #1127**: the two `*.integration.test.ts` suites assert exactly one `COMMENT` review (0 `REQUEST_CHANGES`), the marker on the body, `markReadyForReview` on clean, and the ready↔draft transition + delta-scoped backtrack on blocking.

## 4. Change control

Changing the marker match rule (§1), the findings-artifact fields (§2), or the posting/lifecycle rules (§3) requires editing the **authoring** contract in #1124/#1125 and updating this pin note's cross-reference. #1127's tests are the drift alarm: any change to these boundaries that #1124/#1125 make without updating their contracts will fail the P2 integration suite.

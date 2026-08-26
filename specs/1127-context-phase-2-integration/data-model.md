# Data Model: implement→review→ready flow end-to-end (Phase-2 integration)

Issue: generacy-ai/generacy#1127

This issue introduces **no new production types**. It consumes types delivered by #1124/#1125/#1126 and pins their contract shapes. The entities below are what the integration tests bind to and what the pin note documents; their **authorship home** is the dependency PRs (Q2=B).

## Consumed entities (authored by dependencies)

### FindingsArtifact (sidecar) — authored by #1124

Engine-internal structured output of the `review` phase over the PR diff (pause-context sidecar pattern; never GitHub review state as source of truth).

| Field | Type | Notes |
|---|---|---|
| `findings[]` | `Finding[]` | May be empty (clean verdict). |
| `verdict` | `'clean' \| 'changes-required'` (name TBD by #1124) | Overall verdict; "clean" ⇒ at-or-below `blockingSeverity`. |
| `round` | `number` | Re-review round counter (delta-scoped passes). |

### Finding — authored by #1124

| Field | Type | Notes |
|---|---|---|
| `severity` | `'critical' \| 'major' \| 'minor'` | Matches `blockingSeverity` enum already in `config.ts:13`. |
| `file` | `string` | Path relative to repo root. |
| `line` | `number` | Anchor line for the inline thread. |
| `body` | `string` | Finding text (posted as an inline COMMENT thread). |

**Blocking rule** (consumed, not implemented here): a verdict is "changes-required" iff any finding's `severity` is at/above the resolved `review.blockingSeverity` (default `critical`, from `resolveWorkflowOverrides` in `config.ts`).

### EngineAuthoredReviewMarker — authored by #1125

A stable HTML-comment marker stamped by deterministic code (never LLM free-write) on every engine-authored review comment/thread, following the marker-family convention.

| Property | Value / rule |
|---|---|
| Prefix shape | `<!-- generacy-<dialect>:… -->` (exact dialect/suffix owned by #1125) |
| Anchoring | Line-anchored at column 0 |
| Case | Case-sensitive ASCII |
| Quoted | `> `-prefixed (quoted) markers do **not** match |
| Authorship | Stamped exclusively by deterministic code |

Precedent: `packages/orchestrator/src/worker/clarification-markers.ts` (`match…Marker(body): string | undefined`).

## Test-only entities (this issue)

### remediate stub (test double) — Q3=A

Injected through `PhaseLoopDeps.remediateTrigger` (`phase-loop.ts:107`). No production type; the loop already runs `runStubPhase('remediate')` for the off-sequence pass. The test steers exactly one off-sequence pass via a fire-once trigger (or a verdict-bound trigger from #1126).

### marker-match assertion helper reference — FR-005

The standalone deterministic helper asserted by US3. Preferred: #1125's co-located `match…Marker` helper. Fallback (D-3): a minimal `matchEngineAuthoredReviewMarker(body: string): boolean` in the marker module, exported for #1130.

```ts
// Signature the FR-005 test binds to (whichever source ships it):
function matchEngineAuthoredReviewMarker(body: string): boolean;
// true  ⇒ engine-authored ⇒ "exclude" from external-feedback routing (#1130 consumes)
// false ⇒ external/human comment ⇒ eligible for routing
```

## Relationships

- `review` executor (#1124) **produces** `FindingsArtifact`; `markReadyForReview` / draft-conversion (#1125) is **gated by** its verdict; re-review convergence (#1126) **backtracks** on a blocking verdict via the `remediateTrigger` seam.
- `EngineAuthoredReviewMarker` is **stamped by** #1125's posting path and **matched by** the FR-005 helper; #1130 later **routes on** that match to exclude engine threads from `PrFeedbackMonitorService`.
- `review`/`remediate` both map to the `implementation` stage (`PHASE_TO_STAGE`, `types.ts`) — no new `StageType`.

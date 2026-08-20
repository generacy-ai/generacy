# Contract: Findings-artifact sidecar (documented shape)

**Source of truth**: `ReviewArtifactSchema` in `packages/orchestrator/src/worker/review-artifact.ts` (#1124). This file mirrors it for the docs; if they diverge, the shipped code wins (FR-008) and the docs are corrected.

## Path

```
.generacy/review-findings-<sanitized-workflowId>.json
```

`sanitized-workflowId` = `workflowId` with `[^a-zA-Z0-9_-]` replaced by `_` (mirrors `pause-context.ts`). Written atomically (temp + rename); invalid reads return `null`.

## Shape

```jsonc
{
  "findings": [
    {
      "severity": "critical | major | minor",
      "file": "string (non-empty)",
      "line": 123,                       // int > 0, optional
      "title": "string (non-empty)",
      "detail": "string (non-empty)",
      "round": 0,                        // int >= 0
      "status": "open | resolved"
    }
  ],
  "verdict": "clean | changes-required", // engine-recomputed; agent-claimed verdict is ignored
  "round": 1,                            // int > 0, monotonic review round
  "lastReviewedCommitSha": "string (non-empty)",
  "remediationCount": 0                  // int >= 0, default 0; caps the review<->remediate loop (#1128)
}
```

## Semantics to document

- **Engine-internal.** The artifact — not GitHub review state — is the source of truth for the verdict. The engine recomputes `verdict` from `findings` on every round; any verdict the agent claims in its candidate file is discarded.
- **`round` vs `remediationCount`.** `round` is the monotonic review round (#1126). `remediationCount` caps the review↔remediate loop (#1128) and is reset when the operator resumes via `completed:remediation-limit`.
- **Back-compat.** `remediationCount` defaults to `0` so pre-#1128 artifacts still parse rather than returning `null`.

## Documentation style (Q4→C)

Inline this shape in `reference/review-artifacts.md` AND link to `review-artifact.ts` as authoritative. Do not restate the full Zod validators — summarize types + enums, point to the file for exactness.

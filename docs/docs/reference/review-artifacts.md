---
sidebar_position: 6
---

# Review Artifacts & Markers

The review ⇄ remediate flow persists its state in an **engine-internal** findings
sidecar and communicates review rounds on the PR through **engine-authored
markers**. Both are documented here in summary form; the shipped code is the
authoritative source and wins on any divergence.

:::info Engine-internal — GitHub review state is never source of truth
The findings sidecar, not GitHub's review state, is authoritative for the review
verdict. The engine recomputes the verdict from the findings on every round; any
verdict an agent claims in its candidate file is discarded. GitHub reviews are
posted as **COMMENT**-event reviews (the cluster account cannot `REQUEST_CHANGES`
on its own PR), so they carry no blocking state — they are a human-readable mirror
of the sidecar.
:::

## Findings-artifact sidecar

Written to the checkout at:

```
.generacy/review-findings-<sanitized-workflowId>.json
```

`sanitized-workflowId` is the `workflowId` with every `[^a-zA-Z0-9_-]` character
replaced by `_`. The file is written atomically (temp file + rename); an invalid
or unparseable read returns `null` rather than throwing.

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
  "verdict": "clean | changes-required", // engine-recomputed; agent claim ignored
  "round": 1,                            // int > 0, monotonic review round
  "lastReviewedCommitSha": "string (non-empty)",
  "remediationCount": 0                  // int >= 0, default 0; caps the loop
}
```

- **`round` vs `remediationCount`.** `round` is the monotonic review round —
  it only ever increases and anchors delta-scoped re-review. `remediationCount`
  caps the review ⇄ remediate loop and is reset to `0` when the operator resumes
  via `completed:remediation-limit`.
- **Verdict.** `changes-required` iff at least one `status: "open"` finding has a
  severity at or above the workflow's `blockingSeverity` threshold
  (`critical` > `major` > `minor`); otherwise `clean`.
- **Default `blockingSeverity` (per-workflow, #1161 D3).** When no workflow-level
  `review.blockingSeverity` override is set, the default is **`major` for
  `speckit-feature`** and **`critical` for every other workflow** (including
  `speckit-bugfix`). Feature work is held to a stricter blocking bar — a `major`
  finding blocks a feature PR but not a targeted bugfix. Resolved by
  `defaultBlockingSeverity(workflowName)` in
  [`worker/config.ts`](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/worker/config.ts).
- **Back-compat.** `remediationCount` defaults to `0`, so artifacts written before
  the remediation cap shipped still parse rather than returning `null`.

**Authoritative source:**
[`packages/orchestrator/src/worker/review-artifact.ts`](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/worker/review-artifact.ts)
(#1124) — the Zod schema (`ReviewArtifactSchema`), path helper, and
`computeVerdict` live there. Refer to it for exact validators; this page
summarizes types and enums only.

## Engine-authored review markers

Every engine review round posts a **COMMENT**-event review whose body carries a
marker, plus one inline marker per finding. Downstream tooling — including the
PR-feedback monitor and the generacy-cloud mirror — recognizes these markers to
**exclude** engine-authored reviews, which prevents the engine from racing its own
review ⇄ remediate loop.

| Location | Format | Prefix / key |
| --- | --- | --- |
| Review body | `<!-- generacy-engine-review round=<N> -->` | `generacy-engine-review` |
| Per-finding inline comment | `<!-- generacy-finding:<marker> -->` | `generacy-finding:` |

`<N>` is the review round; `<marker>` is the per-finding identifier used to match
a finding's inline comment across rounds.

### Contract-name key for the generacy-cloud mirror

The generacy-cloud mirror matches on the marker string **verbatim**:
`generacy-engine-review` (body) and `generacy-finding:` (inline). These strings
are the contract name — grep for them exactly.

**Authoritative source:**
[`packages/orchestrator/src/worker/review-poster.ts`](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/worker/review-poster.ts)
(#1125) — `REVIEW_BODY_MARKER_PREFIX` and the inline-marker helpers live there.

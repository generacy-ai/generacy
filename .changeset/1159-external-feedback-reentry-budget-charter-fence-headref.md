---
"@generacy-ai/orchestrator": patch
---

Bound the external-feedback re-entry budget, fence untrusted `detail` at ingestion, and resolve the working branch from the PR head ref (#1159).

Fixes three composing defects on the flag-ON `address-pr-feedback` review/remediate path that together reproduced the #883-class runaway loop:

- **Budget bounding**: a blanket `failed:*` monitor re-enqueue skip (no allow-list) keeps the `clearReviewArtifact` budget reset reachable only on the two legitimate reset occasions, so the `on-remediation-limit` cap becomes globally reachable across re-entries instead of resetting on every poll.
- **Prompt-injection fencing**: untrusted `detail` is wrapped with `wrapUntrustedData` at the two ingestion sites (seed comment body, validate-evidence output) before it reaches the remediate charter. Engine-authored review findings are not wrapped.
- **Head-ref checkout**: on the `address-pr-feedback` re-entry, the working branch is resolved from the linked open PR's `head.ref` (zero/one/many rule) instead of `createFeature(issueNumber)`, removing the duplicate-PR path under #1043 slug drift.

Internal defect fix (`workflow:speckit-bugfix`) — no new public exports. Whole path stays behind `reviewPhaseEnabled` / `WORKER_REVIEW_PHASE_ENABLED`; the monitor `failed:*` skip only affects issues already carrying a `failed:*` label.

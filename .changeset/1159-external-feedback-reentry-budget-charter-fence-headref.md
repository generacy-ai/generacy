---
"@generacy-ai/workflow-engine": minor
"@generacy-ai/orchestrator": patch
---

Bound the external-feedback re-entry budget, fence untrusted `detail` at ingestion, and resolve the working branch from the PR head ref (#1159).

Fixes three composing defects on the flag-ON `address-pr-feedback` review/remediate path that together reproduced the #883-class runaway loop:

- **Budget bounding**: a blanket `failed:*` monitor re-enqueue skip (no allow-list) — plus the two other non-completing loop exits (`waiting-for:merge-conflicts`, `waiting-for:ci`) — keeps the `clearReviewArtifact` budget reset reachable only on the two legitimate reset occasions, so the `on-remediation-limit` cap becomes globally reachable across re-entries instead of resetting on every poll.
- **Prompt-injection fencing**: untrusted `detail` is wrapped with `wrapUntrustedData` at the two ingestion sites (seed comment body, validate-evidence output) before it reaches the remediate charter. Engine-authored review findings are not wrapped.
- **Head-ref checkout**: on the `address-pr-feedback` re-entry, the working branch is resolved from the linked open PR's `head.ref` (zero/one/many rule) instead of `createFeature(issueNumber)`, removing the duplicate-PR path under #1043 slug drift. Linked-PR counting matches the branch's numeric prefix by value so zero-padded branches (`042-slug` under `numberPadding: 3`) are counted for issue #42. The ambiguous (>1 linked open PR) park now applies a new `blocked:ambiguous-linked-prs` label so the monitor's `blocked:*` skip suppresses re-enqueue churn and surfaces the ambiguity once for the operator.

Internal defect fix (`workflow:speckit-bugfix`). The only new public surface is the `blocked:ambiguous-linked-prs` label vocabulary in `workflow-engine`. Whole path stays behind `reviewPhaseEnabled` / `WORKER_REVIEW_PHASE_ENABLED`; the new monitor skips only affect issues already carrying the corresponding label.

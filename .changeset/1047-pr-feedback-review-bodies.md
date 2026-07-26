---
"@generacy-ai/workflow-engine": minor
"@generacy-ai/orchestrator": patch
---

PR-feedback fixer now consumes review bodies, not just inline threads (#1047).

`packages/workflow-engine` — adds `Review` + `ReviewSubmissionState` types and
`GitHubClient.listReviews(owner, repo, prNumber): Promise<Review[]>`. Implements
via `gh api /repos/{owner}/{repo}/pulls/{n}/reviews`. Introduces the new label
`blocked:body-finding-unaddressed` used by the orchestrator's Disposition C.

`packages/orchestrator` — `PrFeedbackHandler` now:

- Fetches submitted reviews alongside inline threads and merges their bodies
  into the fixer prompt so findings that name files NOT in the diff still
  reach Claude on the same round (FR-002).
- Applies a per-finding gate: parses the `<!-- generacy-cockpit:unanchored-findings -->`
  marker block in each review body, extracts the `**Files:**` list under each
  `### Finding <n>`, and requires the just-pushed commit to touch at least one
  named file per finding before advancing (FR-003). Older-producer bodies
  without a `**Files:**` line degrade to no-constraint (FR-005), so a two-sided
  producer/consumer rollout is safe.
- Adds Disposition C: on gate failure, applies
  `blocked:body-finding-unaddressed` and posts a marker-keyed top-level PR
  comment enumerating the unaddressed findings. Distinct from Disposition B
  (`blocked:stuck-feedback-loop`).
- On resume, findings listed in the newest
  `<!-- generacy-cockpit:body-findings-unaddressed -->` marker comment are
  treated as acknowledged and skip re-gating; they still reach the prompt
  (FR-008).

No new npm dependencies. No changes to the monitor's blocked-label skip gate —
`l.startsWith('blocked:')` honors the new label with zero allow-list change.

**Scope limit** — the fixer only reaches the review-body path when a review
also carries at least one trusted inline thread. `PrFeedbackMonitorService` still
gates enqueue on `unresolvedThreadIds.length > 0`, so a review submitted with a
body finding and NO inline comments does not schedule the fixer. Widening the
monitor's enqueue trigger to reviews-with-body-findings is tracked as a
follow-up; body-only reviews should currently be paired with at least one inline
comment (or the operator can add an inline note before submitting).

# Clarifications: PR review posting (COMMENT-event) + draft/ready lifecycle

Feature: `1125-context-findings-need-human` | Issue: [#1125](https://github.com/generacy-ai/generacy/issues/1125)

## Batch 1 — 2026-08-19

### Q1: Anchored-but-undiffable findings
**Context**: FR-002 posts findings with a file/line anchor as inline review threads,
and unanchored findings in the review body. But GitHub rejects an inline review
comment whose file/line is not part of the PR diff (the same constraint behind #1047).
A finding can carry a valid anchor that still points outside the diff (e.g., an
unchanged file, or a line moved by a later commit). The spec does not say what happens
to that finding, and this changes both the client contract and the "one review per
round" batching.
**Question**: When a finding has an anchor that GitHub will not accept as an inline
comment (line not in the diff), what should the engine do?
**Options**:
- A: Fall back to rendering that finding in the review body (so it is never dropped).
- B: Attempt the inline comment; on GitHub rejection, retry the whole review with that
     finding demoted to the body.
- C: Drop the finding's anchor silently and always place unanchored + undiffable
     findings in the body, treating "postable inline" as the anchor test.

**Answer**: *Pending*

### Q2: Finding→thread identity for resolution
**Context**: FR-009 resolves inline threads for findings the artifact marks resolved on
a re-review. To resolve *the right* thread, the engine must map an artifact finding back
to the specific GitHub review thread it posted in an earlier round. `getPRReviewThreads`
returns thread IDs and their comment bodies, but the spec does not define how a finding
is identified across rounds. This is implementation-blocking for US4.
**Question**: How should the engine match a resolved artifact finding to the GitHub
thread it created earlier?
**Options**:
- A: Embed a stable per-finding marker/ID in each inline comment body (from the #1124
     artifact), and match on that marker when resolving.
- B: Match on (file path + line) anchor equality between the artifact finding and the
     existing thread's anchor.
- C: The #1124 artifact already carries the GitHub thread ID (persisted after the first
     post); resolution just reads it — no re-matching needed in this feature.

**Answer**: *Pending*

### Q3: Draft-conversion gating on remediate entry
**Context**: US3/FR-006 converts the PR back to draft "when entering remediate after the
PR was marked ready." The transition is specified as idempotent + best-effort. It is
unclear whether the engine should track whether *it* previously marked the PR ready, or
simply call `convertPullRequestToDraft` unconditionally on every remediate entry and
rely on idempotency. This also decides behavior when a human manually marked the PR
ready.
**Question**: How should remediate-entry decide whether to convert to draft?
**Options**:
- A: Call `convertPullRequestToDraft` unconditionally on every remediate entry; rely on
     idempotency (no-op if already draft). No engine-side "was ready" flag.
- B: Only convert if the engine itself previously marked the PR ready (tracked flag);
     never touch a PR the engine did not mark ready.
- C: Query the PR's live draft state and convert only if it is currently ready,
     regardless of who marked it.

**Answer**: *Pending*

### Q4: Round-level re-post idempotency
**Context**: FR-003 notes the engine marker enables "idempotency checks," and US1
requires exactly one review per round. On a retry or worker restart mid-review, the same
round could post a second review. The spec does not define whether re-posting the same
round is prevented, and if so, on what key.
**Question**: Should the engine dedupe review posting so a re-entered round does not
post a second review, and how is a round identified for that check?
**Options**:
- A: Before posting, grep existing engine reviews (via the marker + round number) and
     skip if this round is already posted.
- B: No dedupe in this feature — the review executor (#1124) guarantees a round posts at
     most once; this feature always posts when called.
- C: Dedupe only the review body, but always (re-)post inline threads, relying on
     GitHub's own anchor de-duplication.

**Answer**: *Pending*

### Q5: "Clean verdict" and advisory-only findings
**Context**: FR-005 marks the PR ready on a "clean verdict"; FR-004 distinguishes
advisory (non-blocking) from blocking findings. The Assumptions say this feature consumes
the verdict from the #1124 artifact and does not compute it. It is unclear whether a round
that produced *only advisory findings* is a clean verdict (→ mark ready) and whether the
ready/draft decision reads a single explicit verdict field from the artifact.
**Question**: What signal drives the mark-ready / stay-draft decision, and does
advisory-only count as clean?
**Options**:
- A: A single explicit `verdict: clean|changes-required` field on the #1124 artifact is
     the sole driver; advisory-only is whatever the artifact says (this feature never
     re-derives it).
- B: This feature derives "clean" as "zero blocking findings" from the artifact's
     per-finding severity; advisory-only counts as clean.
- C: Any finding at all (advisory or blocking) means not-clean; ready only when the
     artifact has zero findings.

**Answer**: *Pending*

# Clarifications

## Batch 1 — 2026-08-19

### Q1: Resolved-finding regression
**Context**: FR-006 defines the status transition `open → resolved` when the delta
shows a finding addressed, but says nothing about a finding already marked
`resolved` whose file/line is touched again by a later delta and re-broken. Whether
`resolved → open` is a legal transition determines the completeness of the status
machine and whether a regressed fix can re-block the PR.
**Question**: When a verification-pass delta re-touches the location of a finding
already marked `resolved` and the issue is present again, what happens?
**Options**:
- A: `resolved → open` regression is allowed — the finding re-opens and re-blocks if it is at/above `blockingSeverity`.
- B: `resolved` is terminal — a regressed issue is recorded as a *new* finding (subject to the "blocking-only after round 1" rule), never a re-open.
- C: Out of scope for this feature — regression handling is deferred; `resolved` stays terminal with no new finding raised.

**Answer**: *Pending*

### Q2: Open finding outside the delta
**Context**: FR-003 composes the verification input as (delta) ∪ (open findings),
but the delta only surfaces changed files. If an open finding lives in a file the
current delta does not touch, the reviewer has no changed code proving it addressed.
How such a finding is treated is the core of whether the loop actually converges.
**Question**: For an `open` finding whose file/line is NOT in the current
verification-pass delta, what is the expected outcome of the pass?
**Options**:
- A: It stays `open` unconditionally — only findings whose location appears in the delta can transition to `resolved`.
- B: The reviewer may still mark it `resolved` if it judges it addressed from the enumerated finding context, even without a delta hunk.
- C: Its full original hunk (from the artifact) is added to the review input so the reviewer can re-verify it regardless of the delta.

**Answer**: *Pending*

### Q3: Enforcement of "no new sub-blocking after round 1"
**Context**: FR-005 constrains the *charter/prompt* to forbid new sub-blocking
(advisory) findings after round 1, and SC-003 says the harness asserts "zero new
sub-blocking findings." Whether enforcement is prompt-only or the engine also
filters/drops any advisory finding the reviewer emits anyway determines the
required engine code path.
**Question**: If a verification-pass reviewer emits a new sub-blocking finding
despite the charter, what does the engine do?
**Options**:
- A: Engine-side filter — drop/discard any new sub-blocking finding before it is written to the artifact (defense in depth beyond the prompt).
- B: Prompt-only — trust the charter; write whatever the reviewer returns; SC-003 verifies via harness but the engine does not filter.
- C: Engine-side downgrade — record it but mark it advisory/non-blocking so it never gates the verdict.

**Answer**: *Pending*

### Q4: Merge-conflict re-review convergence charter
**Context**: FR-007 scopes the merge-conflict re-review to the resolution base/head
SHAs. It is unstated whether this pass is a full "verification pass" under the same
convergence charter — i.e. whether it increments the artifact round and whether the
"no new sub-blocking after round 1" rule applies to it.
**Question**: Is the merge-conflict-resolution re-review a verification pass under
the same convergence charter (round increment + blocking-only findings), or a
distinct mode?
**Options**:
- A: Same verification charter — increments the round, blocking-only findings, resolution-scoped delta is the only difference.
- B: Distinct mode — resolution-scoped review with its own charter; does not increment the artifact round and may raise advisory findings on the resolution diff.
- C: Same charter but does NOT increment the round (round is unchanged; it is an out-of-band scoped check).

**Answer**: *Pending*

### Q5: FR-009 full-review fallback semantics
**Context**: FR-009 says an unresolvable scoping SHA (e.g. after a rebase) falls
back to a full review. It is unstated whether that fallback resets to round-1
semantics (full diff, advisory findings permitted again) or remains a verification
pass over the full diff (round n+1, no new advisory findings). This decides whether
the fallback can reintroduce the churn the feature exists to eliminate.
**Question**: When FR-009 falls back to a full review, does it reset to round-1
semantics or stay a verification pass?
**Options**:
- A: Verification pass over the full diff — round stays n+1, no new sub-blocking findings, only the delta widens to the whole diff.
- B: Reset to round 1 — full-diff review with advisory findings permitted again; round counter resets/re-anchors.
- C: Verification pass over the full diff, but the round counter is preserved and advisory findings from the artifact are carried forward unchanged.

**Answer**: *Pending*

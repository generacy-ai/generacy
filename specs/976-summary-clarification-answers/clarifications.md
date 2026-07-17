# Clarifications for #976

## Batch 1 — 2026-07-17

### Q1: Fix direction
**Context**: The spec (§Requested change) explicitly leaves open "marker-based machine exclusion **and/or** an explicit cluster config flag" and defers the choice to the plan phase. This is a requirements-level decision: it determines FR shape, config surface, and whether cluster login must be classified at all. Both call sites (monitor + phase-loop scanner) must agree.
**Question**: Which fix direction should this feature ship?
**Options**:
- A: Marker-based machine exclusion only — treat every cluster-self comment identically to a third-party comment except when it carries a known machine marker. No new cluster config, no identity classification.
- B: Explicit cluster config flag only (e.g. `clusterIdentityIsHuman: true`) — retain the identity-based gate but flip it off when the operator opts in. No auto-detection.
- C: Both — marker-based exclusion is the default behavior, with a config flag as an explicit override for edge cases.
- D: Auto-detected identity classification — inspect the cluster login (GitHub user type, `[bot]` suffix, or GitHub App identity) and turn off the same-account marker requirement automatically when it resolves to a human user.

**Answer**: *Pending*

### Q2: Machine-marker inventory today
**Context**: The Assumptions section states that question posts, stage/status comments, and audit comments "each carry a known, distinguishable machine marker," but also says "If a machine-comment type does not currently carry a marker, adding one is in scope." Whether markers exist today determines whether this fix requires only scanner changes or also a poster-side migration. From the observed code we can already see `<!-- generacy-stage:specification -->` on the stage comment on this very issue.
**Question**: Which cluster-emitted machine comment types **already** carry a distinguishable machine marker, and which need one added as part of this fix?
**Options**:
- A: All three types (question posts, stage/status, audit) already carry markers — this fix is scanner-side only, no poster changes required.
- B: Stage/status comments carry a marker; question posts and audit comments need markers added.
- C: Question posts and stage/status carry markers; audit comments need one added.
- D: Only stage/status carries a marker today; question posts and audit comments both need markers added in this feature.

**Answer**: *Pending*

### Q3: FR-007 failure-surfacing mechanism
**Context**: FR-007 (P2) requires that a rejected same-account answer produce a "surfaced failure signal (comment, label, or explainer)" rather than silently re-arming `waiting-for:clarification`. SC-004 asserts the same. The concrete mechanism affects UX and reuses vs. extends existing paths.
**Question**: How should a rejected same-account answer be surfaced to the operator?
**Options**:
- A: Reuse the existing untrusted-answer explainer comment path only — post an explainer comment on the issue, no new label.
- B: Apply a new label only (e.g. `needs-attention:clarification-rejected`) with a machine-readable rejection reason, no explainer comment.
- C: Both — post an explainer comment AND apply a rejection label.
- D: Defer FR-007 to a follow-up issue; ship FR-001…FR-006 + FR-008 in this feature, and leave the silent-loop backstop unchanged for now.

**Answer**: *Pending*

### Q4: What qualifies a same-account comment as a candidate answer
**Context**: After the identity-based gate is loosened, the scanner needs a positive definition of "candidate answer" for same-account comments. The current different-account path parses "permissively" (FR-002 from #958 — kept by FR-006). Should the same-account permissive path match that, be stricter, or add a shape requirement?
**Question**: For a same-account comment (no machine marker present, author is trusted per `isTrustedCommentAuthor`), what additional shape check should apply before it is admitted as a candidate answer?
**Options**:
- A: None — treat it exactly like a different-account permissive comment (parity with FR-006). Any trusted, marker-free comment is a candidate; `Q<n>:` parsing decides what actually integrates.
- B: Require the comment body to contain at least one `Q<n>:` line before it is considered a candidate (stricter than the different-account path).
- C: Require the comment to be posted while the issue currently has `waiting-for:clarification` applied (temporal gate on top of the identity/marker check).
- D: Require both B and C (`Q<n>:` line **and** `waiting-for:clarification` present).

**Answer**: *Pending*

### Q5: Cluster-identity detection (only relevant if Q1 = B, C, or D)
**Context**: If the fix includes an identity-based signal (config flag with auto-detect, or pure auto-detect), the spec offers "auto-detected when the cluster login resolves to a real user rather than a `[bot]`/App identity" but does not pin the mechanism. Detection choices differ in reliability and network cost.
**Question**: If identity classification is in scope (Q1 answer B, C, or D), how should the cluster login be classified as human vs. bot?
**Options**:
- A: GitHub GraphQL `__typename` on the viewer (`User` vs `Bot`) — single call at boot, cached for the process lifetime.
- B: Suffix-only heuristic — treat any login ending in `[bot]` as a bot, everything else as a human. No network call.
- C: GitHub App installation lookup — if the cluster credential is a GitHub App installation token, classify as bot; PAT/user token → human.
- D: Not applicable — Q1 answer is A (pure marker-based, no identity classification needed).

**Answer**: *Pending*

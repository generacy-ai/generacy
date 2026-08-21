# Clarifications

## Batch 2026-08-21T15:10Z

### Q1: Budget-persistence mechanism
**Context**: FR-001 offers two alternative implementations ("either by not clearing the review artifact on re-entry, or by tracking a global per-PR budget"). These have very different blast radii: preserving the artifact keeps stale prior findings around for the seed round to reconcile, while a separate per-PR budget store leaves the artifact lifecycle untouched but adds a new persisted key. The implementer needs one chosen approach.
**Question**: How should `remediationCount` be preserved across `address-pr-feedback` re-entries?
**Options**:
- A: Stop calling `clearReviewArtifact` on re-entry (or reseed while preserving the prior `remediationCount`); the review artifact remains the single source of truth for the budget.
- B: Keep clearing the artifact but track the budget in a separate per-PR store (e.g. a Redis key keyed by owner/repo/PR-number) read at seed time and written on each remediate execution.
- C: Preserve the artifact's `remediationCount` specifically (carry it forward across the clear/reseed) but discard the prior findings so the seed round starts from the current live feedback.

**Answer**: A — Stop calling `clearReviewArtifact` on re-entry (or reseed while preserving prior `remediationCount`); the review artifact remains the single source of truth for the budget. The `SeedAwareReviewExecutor` already preserves the budget (`remediationCount: prior?.remediationCount ?? 0`, `seed-aware-review-executor.ts:96`); the defect is the `clearReviewArtifact` at `claude-cli-worker.ts:584` wiping prior before seeding. B adds a redundant parallel store; C duplicates what the executor already does.

### Q2: Budget-reset lifecycle
**Context**: SC-001 requires the count be "monotonic across entries," and FR-002 says an operator resume "clears/rearms" the gate. But it is unstated whether the accumulated budget resets (a) when an operator resumes the `remediation-limit` gate, and (b) when a genuinely new, distinct review is submitted after prior feedback was addressed. Without this, the counter could either strand a PR permanently at the cap or silently reset and re-open the runaway.
**Question**: Under what conditions does the accumulated `remediationCount` reset to 0?
**Options**:
- A: Only an operator resume of the `remediation-limit` gate resets/rearms the budget; any subsequent re-entry (including brand-new review feedback) continues to accumulate until the next operator resume.
- B: Operator resume rearms the budget AND a new distinct review submission (new review after prior threads were resolved) also resets it to 0; ordinary same-feedback re-entries keep accumulating.
- C: Never auto-reset — the budget is monotonic for the life of the PR; only clearing the labels/artifact by hand resets it.

**Answer**: B — Operator resume rearms the budget AND a new distinct review submission (new review after prior threads were resolved) also resets it to 0; ordinary same-feedback re-entries keep accumulating. The D-2 reset comment (`claude-cli-worker.ts:571-583`) reaches `clearReviewArtifact` only when the operator cleared the gate OR a new/re-opened human thread changed the unresolved set — both correct occasions for a fresh budget; rules out A (resume-only) and C (monotonic-for-life).

### Q3: Monitor skip scope for `failed:*`
**Context**: FR-003 says the monitor skip must suppress re-enqueue for `failed:*` escalations that "today fall through to Case A re-enqueue," naming `failed:review` and `failed:validate-repeated`. It is unclear whether the skip should match the entire `failed:*` prefix (like the existing `blocked:*` gate at `:557`) or only an enumerated subset, and how an operator un-sticks a PR that the skip is now suppressing.
**Question**: What should the new monitor skip gate match, and how is it cleared?
**Options**:
- A: Blanket `failed:*` prefix skip (mirrors the `blocked:*` gate); the operator clears it by removing the `failed:*` label (which is already the resume convention for these escalations).
- B: Only the specific labels reachable on this path (`failed:review`, `failed:validate-repeated`); other `failed:*` labels continue to fall through as today.
- C: Skip on any `failed:*` OR unresolved-thread-with-parked-state, cleared only by an explicit operator resume action.

**Answer**: A — Blanket `failed:*` prefix skip (mirrors the `blocked:*` gate); the operator clears it by removing the `failed:*` label (already the resume convention). The existing `blocked:*` gate (`pr-feedback-monitor-service.ts:557`) uses blanket `startsWith('blocked:')` with a stated no-allow-list contract (`:449,:488`); B's allow-list contradicts that and lets future `failed:*` labels re-enqueue every poll; C adds parked-state machinery not present here.

### Q4: Branch resolution when `head.ref` is unresolvable
**Context**: FR-006 requires deriving the working branch from the PR's `head.ref`. The Assumptions note the head ref is "available (or resolvable via `findPRForBranch` / issue-linked PR lookup)," and that if the PR does not yet exist the fresh-request path is correct. But the behavior is unspecified when a PR *should* exist but the lookup fails or returns ambiguous/multiple linked PRs.
**Question**: What should the re-entry do when it cannot unambiguously resolve the PR `head.ref`?
**Options**:
- A: Fall back to the existing `createFeature(issueNumber)` branch derivation (preserve today's behavior) and log a warning.
- B: Refuse to proceed on that poll (skip/park) rather than risk committing to the wrong branch or opening a duplicate PR, surfacing the ambiguity for operator attention.
- C: If exactly one linked open PR exists use its head ref; if zero, treat as fresh-request; if more than one, park for operator attention.

**Answer**: C — If exactly one linked open PR exists use its head ref; if zero, treat as fresh-request; if more than one, park for operator attention. The flag-ON re-entry derives the branch via `createFeature({number: issueNumber})` (`claude-cli-worker.ts:482`) — the mechanism behind the orphan/duplicate-PR-on-re-entry bug; C restores authoritative head-ref resolution (`pr-feedback-handler.ts:225`) in the single-PR case and surfaces true ambiguity. A preserves dup-PR risk; B over-parks.

### Q5: Where untrusted `detail` is fenced
**Context**: FR-004/FR-005 point at the two ingestion sites (`seed-aware-review-executor.ts:75` and `phase-loop.ts:1037`) for wrapping with `wrapUntrustedData`, while US2 AC3 requires engine-authored detail (from the real review executor) not be double-wrapped. The implementer must decide whether fencing happens at each ingestion site (selective) or centrally in the charter (uniform), which determines how engine-authored vs untrusted findings are distinguished.
**Question**: At which layer should `wrapUntrustedData` be applied?
**Options**:
- A: At the two ingestion sites only (seed detail + validate-evidence detail), leaving engine-authored review findings untouched; the charter embeds the already-wrapped strings verbatim.
- B: Centrally in the remediate charter, wrapping every finding `detail` uniformly (treating all embedded detail as untrusted), which also covers engine-authored detail without a double-wrap risk since it is wrapped exactly once.
- C: At the ingestion sites, plus a marker/flag on each finding so the charter can assert-and-skip already-fenced detail (belt-and-suspenders against double-wrapping).

**Answer**: A — At the two ingestion sites only (seed detail + validate-evidence detail), leaving engine-authored review findings untouched; the charter embeds the already-wrapped strings verbatim. The charter embeds `finding.detail` raw (`remediate-charter.ts:60`); the two non-engine ingestion points are the seed body (`seed-aware-review-executor.ts:74`) and validate evidence tail (`phase-loop.ts:1029`), matching the existing `wrapUntrustedData` pattern (`validate-fix-handler.ts:235`). B risks double-wrapping engine findings; C adds complexity beyond wrap-once.

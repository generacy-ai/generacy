# Clarifications — #746

## Batch 1 — 2026-06-03

### Q1: Fix scope across repos
**Context**: FR-003 lists three possible fix locations: (a) `generacy-cloud` cloud-deploy templating, (b) `publish-preview` workflow, (c) `control-plane` tunnel-name persistence/cache. (a) and (b) are out of this repo. The spec is ambiguous about what `746` itself should ship.
**Question**: What should the deliverable for #746 in the `generacy` repo be if the root cause turns out to be out-of-repo?
**Options**:
- A: Only the in-repo fix (if any). For out-of-repo causes, ship just the diagnosis writeup + open companion issues in `generacy-cloud` / workflow repo. Close #746 once the diagnosis is captured.
- B: #746 owns the end-to-end fix regardless of repo: do the in-repo work AND drive the companion PRs in `generacy-cloud` / workflows to merge before closing.
- C: In-repo fix + companion issues opened, but leave #746 open until cloud-side companion PRs land.

**Answer**: *Pending*

### Q2: Existing-cluster migration
**Context**: FR-007 conditionally requires a "re-derivation or migration path" only if hypothesis #3 (stale/cached tunnel registration) is the root cause. US1's acceptance criterion allows "existing clusters … continue to function (no forced re-registration breakage) OR a documented migration path exists." This leaves behavior for already-deployed cloud clusters with projectId-derived tunnel names undefined when the cause is NOT caching.
**Question**: For existing cloud clusters currently using projectId-derived tunnel names, what's the expected behavior after the fix ships?
**Options**:
- A: Leave them on the projectId-derived name (no migration). New deploys get UUID-derived names; old ones unchanged.
- B: Auto-re-derive on next cluster restart / activation (idempotent — cluster re-registers under UUID-derived name on boot).
- C: Provide an operator-triggered migration (CLI command or doc procedure) but don't auto-migrate.

**Answer**: *Pending*

### Q3: #744 changeset release ownership
**Context**: FR-006 (P1) requires `@generacy-ai/control-plane` `stable` to contain #744's `deriveTunnelName`. The #744 changeset (`.changeset/feat-744-multi-cluster-cli.md`) is currently pending/unreleased. Releasing it is a separate operational step (consume changeset → version bump → publish).
**Question**: Is consuming and publishing the #744 changeset part of this issue's deliverable, or tracked separately?
**Options**:
- A: Part of #746 — issue stays open until `@generacy-ai/control-plane@stable` contains the fix and SC-003 passes.
- B: Out of scope for #746 — track as a separate release-engineering task; #746 closes once preview-channel deploys behave correctly (SC-001/SC-002 verified on preview).
- C: Part of #746 only if root cause is in this repo; otherwise out of scope.

**Answer**: *Pending*

### Q4: Verification environment for SC-001 / SC-002
**Context**: SC-001 (UUID-derived `vscodeTunnelName`) and SC-002 (two-cluster uniqueness) require observation of the cloud cluster doc. The spec doesn't say whether verification must be done on a freshly-provisioned DigitalOcean Droplet or whether re-using an existing observed cluster (or test environment) is acceptable.
**Question**: How should SC-001 and SC-002 be verified?
**Options**:
- A: Deploy a fresh cloud cluster (DigitalOcean) end-to-end and observe `vscodeTunnelName` in the cloud Firestore doc — required even if it incurs infrastructure cost.
- B: Static inspection is sufficient — confirm the env var is set to UUID on a fresh deploy template, confirm the published `@generacy-ai/control-plane` tarball contains UUID-keyed `deriveTunnelName`, and rely on existing unit tests for `deriveTunnelName`.
- C: Deploy ONE fresh cloud cluster (covers SC-001), and reason about SC-002 by argument (uniqueness follows from per-UUID derivation + UUID uniqueness) without actually deploying a second sibling.

**Answer**: *Pending*

### Q5: Source of `vscodeTunnelName` on cloud cluster doc
**Context**: Assumption #3 in the spec states `vscodeTunnelName` is "populated by the cluster's first tunnel-registration event reported via the relay, not by cloud pre-computing it from projectId." If this assumption is false (cloud actually pre-computes it from `projectId`), the in-repo fix is moot and the fix must be cloud-side.
**Question**: Should validating Assumption #3 be a P0 deliverable of FR-001/FR-002, gating any in-repo code change?
**Options**:
- A: Yes — explicitly add an investigation step that traces the write path for `vscodeTunnelName` in the cloud cluster doc (`generacy-cloud` callers / relay handlers) and confirms whether it's reported-by-cluster vs computed-by-cloud, before writing any code in this repo.
- B: No — proceed under the stated assumption; if it turns out to be false, re-scope at that point.

**Answer**: *Pending*

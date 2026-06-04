# Feature Specification: publish-preview can publish a stale preview when run during a merge

**Branch**: `749-summary-publish-preview` | **Date**: 2026-06-04 | **Status**: Clarified

## Summary

The `publish-preview` workflow (`.github/workflows/publish-preview.yml`) is **manual (`workflow_dispatch`)** and snapshots whatever `develop` points to **at trigger time**. When it's kicked off right as a PR merges, it can build the **pre-merge** commit and publish a `preview` tag that's missing the just-merged change — even though the version timestamp looks "after" the merge.

This bit us with #744/#746: `0.0.0-preview-20260603190235` (timestamped ~1 min after #744 merged) did **not** contain #744's `deriveTunnelName`, so the deployed cloud cluster reported a projectId-derived tunnel name. A manual republish (`…233608`) fixed it — but the need for a manual republish-after-merge is the smell.

## Impact

- Cloud clusters install `@generacy-ai/*@preview` at boot, so a stale `preview` tag silently ships old code to every new staging cluster until someone notices and republishes.
- Hard to detect: the version timestamp looks current, so "the cluster has the latest preview" appears true while the code is actually behind.

## Options to consider

- **Auto-publish on merge to `develop`**: trigger `publish-preview` on `push` to `develop` (after CI passes) so `preview` always tracks the merged tip — removes the manual step and the race.
- **Pin the build SHA in the published version/provenance** so it's easy to verify which commit a `preview` tarball was built from (e.g. include the short SHA in the version or a `gitHead`/provenance field), making "does this preview contain commit X?" a one-line check.
- At minimum, **document** that `publish-preview` must be run *after* a merge completes (not concurrently), and that a republish is required if triggered during a merge.

## Acceptance criteria

- [ ] A merge to `develop` reliably results in a `preview` tag containing that commit (auto-publish) **or** the published version exposes its source SHA so staleness is detectable.
- [ ] No manual "republish after merge" step required for staging to pick up merged changes.

Relates: #744, #746.


## User Stories

### US1: Merge-to-preview reliability

**As a** developer merging PRs to `develop`,
**I want** the `@preview` npm dist-tag to reliably contain the latest merged commit without any manual republish step,
**So that** newly-deployed staging cloud clusters install the actual latest code, not a stale snapshot that silently masks a regression.

**Acceptance Criteria**:
- [ ] After a merge to `develop`, the next published `@preview` tarball contains that merge's commit without any manual `workflow_dispatch`.
- [ ] If the workflow is racing a merge and would otherwise publish a pre-merge SHA, it either rebuilds the resolved `origin/develop` HEAD or fails loudly — it never silently publishes a stale tarball.

### US2: SHA-traceable preview tarballs

**As an** on-call engineer debugging a cloud cluster,
**I want** to determine in one command which commit a `@preview` tarball was built from,
**So that** I can verify "does the deployed preview contain commit X?" without downloading and unpacking the tarball.

**Acceptance Criteria**:
- [ ] `npm view <pkg>@preview version` returns a string ending in a short SHA suffix (e.g., `0.0.0-preview-<timestamp>-<sha7>`).
- [ ] `npm view <pkg>@preview gitHead` (or the equivalent `generacy.sourceSha` field) returns the full 40-char SHA of the source commit.

### US3: Operator rollback escape hatch

**As an** operator handling a broken `@preview` during an incident,
**I want** a deliberate way to publish an earlier known-good SHA over the current one,
**So that** I can roll back staging without merging a revert PR to `develop` (which is slow during an incident).

**Acceptance Criteria**:
- [ ] `workflow_dispatch` accepts a `force_rollback: boolean` input (default `false`).
- [ ] When `force_rollback=true`, the staleness check is skipped and a warning is logged identifying the rollback as deliberate.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The workflow MUST trigger automatically on `push` to `develop` (after required CI passes), in addition to `workflow_dispatch`. | P1 | Removes the manual step and the race in the common path. |
| FR-002 | At build time, the workflow MUST resolve and check out the current `origin/develop` HEAD (not the event-time ref), and use that resolved SHA for both build and metadata. | P1 | Primary defense against the original race in #744/#746. |
| FR-003 | Each published preview tarball MUST expose its source SHA in TWO places: (a) a `-<sha7>` suffix appended to the version string after the timestamp; AND (b) the full 40-char SHA written into each `package.json` as `gitHead` (and also `generacy.sourceSha` for tooling). | P1 | Clarification Q1=C. `gitHead` is NOT auto-populated by `changeset version --snapshot`; the workflow must write it explicitly. |
| FR-004 | The workflow MUST refuse to publish a candidate that is strictly behind the currently published `@preview` tag's source SHA. The staleness check is an ancestry check: refuse iff `git merge-base --is-ancestor <candidate-sha> <current-preview-sha>` returns true AND `candidate-sha != current-preview-sha`. | P1 | Clarification Q2=A. Read `current-preview-sha` from the published `gitHead`/`generacy.sourceSha` field (FR-003), not from the version-string suffix. |
| FR-005 | When the current `@preview` tag does not exist, OR exists but does not carry the SHA field used by FR-004, the workflow MUST publish unconditionally (the publish establishes the baseline). | P1 | Clarification Q3=A. Covers first run after rollout, registry wipes, and brand-new packages. |
| FR-006 | When the staleness check refuses a publish, the workflow MUST fail the job immediately with a descriptive error message identifying both the candidate SHA and the current `@preview` SHA. Recovery is via the next `push: develop` event; the workflow MUST NOT retry, loop, or self-re-dispatch. | P1 | Clarification Q4=A. FR-002 makes this case rare (genuine history rewrites / rollbacks only). |
| FR-007 | `workflow_dispatch` MUST accept a `force_rollback: boolean` input (default `false`). When `true`, the workflow MUST log a clearly identifiable warning and skip the FR-004 staleness check. The `push: develop` trigger MUST NOT honor this input (it does not apply). | P1 | Clarification Q5=B. Auditable operator escape hatch for incident rollback. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Time from a merge to `develop` until `@preview` contains that merge's SHA | ≤ 10 minutes, with zero manual steps | Compare `gh pr view <pr> --json mergedAt` to the time `npm view <pkg>@preview gitHead` first returns the merge SHA. |
| SC-002 | Source-SHA traceability of a published preview | `npm view <pkg>@preview version` ends with `-<sha7>`; `npm view <pkg>@preview gitHead` returns the matching full SHA | Run both commands against any published preview after this change. |
| SC-003 | Resistance to the original race (concurrent merge + workflow run) | A run started before a merge completes still publishes the post-merge SHA (because FR-002 resolves `origin/develop` HEAD at build time) | Manually verify by triggering `workflow_dispatch` while a PR is mid-merge in a staging fork. |
| SC-004 | Detection of attempted backward publishes | Any candidate strictly behind the current `@preview` is refused with a clear log line, unless `force_rollback=true` | Manually trigger `workflow_dispatch` on an older SHA; confirm fail. Re-trigger with `force_rollback=true`; confirm success and the warning log line. |

## Assumptions

- `develop` is the only branch that publishes to the `@preview` dist-tag.
- Force-pushes to `develop` are rare and require operator action; when they occur, operators use `force_rollback=true` to recover.
- The `push: develop` trigger fires reliably on merge (GitHub does not drop events under normal load).
- `changeset version --snapshot` continues to produce versions of the shape `0.0.0-preview-<timestamp>`; FR-003 appends `-<sha7>` to that.

## Out of Scope

- Other npm dist-tags (`latest`, `alpha`, etc.) — only `@preview` is in scope.
- npm provenance / attestation as the SHA-exposure mechanism (Q1=C, not D); provenance may be added later but is not relied on for verification.
- A self-healing in-job retry loop or workflow self-re-dispatch (Q4=A — recovery is via the next `push: develop` event).
- A `target_sha` input for surgical replays (Q5=B chose `force_rollback`, not `target_sha`).
- Backfilling SHA metadata into previously-published preview tarballs.

---

*Generated by speckit*

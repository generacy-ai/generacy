# Clarifications: 559-problem-github-workflows

## Batch 1 — 2026-05-10

### Q1: Spec-Issue Design Misalignment
**Context**: The spec recommends Approach A (move workflows to cluster-base/cluster-microservices repos), but the issue maintainer's comment explicitly rules this out. Cluster-base is used as an upstream template — files added there get merged into downstream project repos, causing unwanted `.github/workflows/` entries. The maintainer recommends Option D (scheduled poll from generacy) instead.
**Question**: Should the spec be updated to use Option D (scheduled cron-poll workflow in generacy that checks for new commits on cluster-base/cluster-microservices develop/main and dispatches the existing publish workflow when SHA changes)?
**Options**:
- A: Yes, adopt Option D (scheduled poll) as recommended by maintainer
- B: Use a different approach (please specify)

**Answer**: *Pending*

### Q2: Polling Interval
**Context**: Option D uses a cron-triggered GitHub Actions workflow to poll for new commits. The polling interval determines how quickly images are published after a merge. The maintainer suggested 5-10 minutes.
**Question**: What polling interval should the cron workflow use?
**Options**:
- A: 5 minutes (faster publish, more API calls)
- B: 10 minutes (balanced — maintainer's initial suggestion)
- C: 15 minutes (fewer API calls, still within SC-001's <10 min target most of the time)

**Answer**: *Pending*

### Q3: SHA State Storage
**Context**: The poll workflow must compare the current HEAD SHA of cluster-base/cluster-microservices against the last-published SHA to decide whether to trigger a rebuild. This state needs to persist between workflow runs.
**Question**: Where should the last-published SHA be tracked?
**Options**:
- A: Query GHCR for the latest `:preview`/`:stable` image's `sha-*` tag and compare against current branch HEAD — no external state needed
- B: Store in a GitHub Actions cache key
- C: Store as a workflow artifact

**Answer**: *Pending*

### Q4: Branch Coverage
**Context**: The spec mentions both `develop` (`:preview` tag) and `main` (`:stable` tag) branches. The poll workflow could check one or both.
**Question**: Should the poll workflow monitor both `develop` and `main` branches on each target repo, or only `develop`?
**Options**:
- A: Both develop and main (full automation for preview and stable)
- B: Only develop (main/stable publishes remain manual-dispatch for release control)

**Answer**: *Pending*

### Q5: Workflow Deduplication
**Context**: The current `workflow_dispatch` workflows would remain for manual one-off builds. The new cron-poll workflow would also dispatch builds. If a manual dispatch happens close to a poll cycle, the same SHA could be built twice.
**Question**: Should the poll workflow skip dispatch if the target SHA already has a published image tag in GHCR, or is duplicate builds acceptable?
**Options**:
- A: Skip if SHA already published (check GHCR tags before dispatching) — prevents wasted CI minutes
- B: Allow duplicates (simpler implementation, Docker push is idempotent)

**Answer**: *Pending*

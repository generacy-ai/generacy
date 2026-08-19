# Clarifications: phase-start-ref key migration + unresolvable-ref handling (#1112)

## Batch 1 — 2026-08-19

### Q1: Re-persist a migrated legacy ref under the branch-scoped key
**Context**: FR-002 clears the legacy key once a legacy ref is consumed. If the migrated ref is used for the current increment but never written under the new branch-scoped key, a *second* worker restart in the same phase misses both keys (legacy now cleared) and re-captures a HEAD already past the product commits — reintroducing the exact false-failure this fix targets.
**Question**: After a legacy ref is successfully migrated, should it also be persisted under the branch-scoped key (`phase-start-ref:<owner>:<repo>:<issue>:<branch>:<phase>`) so later increments in the same phase read it there?
**Options**:
- A: Yes — on migration, write the ref under the branch-scoped key (fresh 7-day TTL) and then clear the legacy key, so subsequent restarts read the branch-scoped key.
- B: No — reuse the migrated ref for this increment only; do not re-persist under the branch-scoped key.

**Answer**: A — Yes: on migration, write the ref under the branch-scoped key (`phase-start-ref:<owner>:<repo>:<issue>:<branch>:<phase>`, fresh 7-day TTL), then clear the legacy key. Order the writes so the legacy key is cleared only after the branch-scoped write succeeds: a crash between them costs at most a re-read of the legacy key, never a lost window. Option B converts a one-time upgrade hazard into a repeatable every-restart hazard and violates the accepted Q5=B persist-once-across-restarts property from #1107.

### Q2: Migration mechanism — lazy read-through vs. startup drain
**Context**: FR-001 notes the mechanism is "to be settled at /plan; issue suggests either." The choice shapes behavior and operational surface: a lazy per-phase read-through touches only the exact legacy key on a branch-key miss; a startup drain performs a keyspace scan (`SCAN`/pattern-match) across all legacy keys at boot.
**Question**: Which migration mechanism should this fix implement?
**Options**:
- A: Lazy read-through — on a branch-scoped key miss, read the single legacy key inline before capturing fresh HEAD (targeted, no keyspace scan).
- B: Startup drain — scan and migrate/clear all legacy-format keys at worker boot.
- C: Defer the choice to /plan; either is acceptable at the requirements level.

**Answer**: A — Lazy read-through: on a branch-scoped key miss, read the single legacy key inline before capturing fresh HEAD (targeted, no keyspace scan). A startup drain cannot perform the Q1 migration — the legacy key carries no branch component, and the branch is only knowable from `context.branch` inside the phase loop; at boot there is no queue item, so a drain could only DELETE legacy keys, destroying the ref an in-flight implement phase needs. Also unavailable without new surface area (PhaseTracker exposes only key-scoped getValueRaw/setValueRaw/clearRaw; no scan API), and unsafe under multi-worker replicas (7 concurrent boot scans mutating keys other workers are mid-phase on).

### Q3: Disposition of a legacy ref that is found but rejected
**Context**: FR-002 clears a legacy ref that is *successfully migrated*. It is unstated what happens to a legacy ref that is read but rejected — because it fails `isValidCommitSha` shape validation (US1 AC) or resolves-check under FR-003 (does not exist in the checkout). Leaving it lets it be re-read by a later cycle or linger to its 7-day TTL.
**Question**: When a legacy ref is read but rejected (shape-invalid or unresolvable), should it still be cleared?
**Options**:
- A: Yes — clear the legacy key on any read (consume-once), whether accepted or rejected.
- B: No — only clear on successful migration; leave rejected legacy keys to expire via TTL.

**Answer**: A — Yes: clear the legacy key on any read (consume-once), whether accepted or rejected. After #1110 nothing constructs the unbranched key any more, so a rejected legacy value can never be rewritten or become valid and would sit unreadable for the full 7-day TTL. Under option B a shape-valid-but-unresolvable legacy ref is re-read and re-rejected every increment and stays eligible after a duplicate-PR re-entry on a different branch — reintroducing the cross-branch stale-ref fail-open branch scoping closed. Consume-once is fail-closed (worst case: fresh HEAD capture + operator-resolvable false failure, never a silent pass); `clearRaw` already degrades to a logged no-op when Redis is down.

### Q4: cat-file failure disambiguation vs. FR-005
**Context**: FR-003 adds a `git cat-file -e <sha>^{commit}` existence probe; FR-005 requires that genuine diff-computation failures still surface via `product-diff-error`. If the cat-file probe itself exits non-zero for a reason other than "commit missing" (e.g. corrupt/inaccessible git dir), treating every non-zero exit as "absent → re-capture" could silently mask a real environment fault.
**Question**: How should a non-zero `cat-file` exit be interpreted?
**Options**:
- A: Any non-zero exit means "ref absent" → treat as absent, re-capture, and proceed (simplest; a broken git dir would surface later in the diff step anyway).
- B: Only the commit-missing signal (exit 1 / "bad object") means absent; other git failures are treated as genuine errors and surface via the existing error path.

**Answer**: B — Only the commit-missing signal means absent; other git failures are treated as genuine errors and surface via the existing error path. Option A would classify "not a git repository" / corrupt object store as "ref absent" and silently re-capture HEAD, narrowing the guard window and permanently killing FR-005's `product-diff-error` channel for the exact environmental-failure class it exists to report.

**Implementation caveat FR-003 must absorb — the probe named in this issue does not work.** Measured on git 2.52.0: `git cat-file -e <sha>^{commit}` exits **128** (not 1) for a plainly missing object, and also 128 for "not a git repository" — so the peeled cat-file form cannot distinguish the two cases at all. The plain `git cat-file -e <sha>` form returns exit 1 for a missing 40-hex object but 128 for a missing abbreviated sha, and `isValidCommitSha` accepts 7-40 hex. Use **`git rev-parse --verify --quiet <sha>^{commit}`** instead: exit 1 for both full and abbreviated missing commits, 128 for environment faults — the probe that actually implements option B. `getFilesChangedByOwnCommits` already threads exit code + stderr into its throw, so the surfacing path for the 128 class is in place.

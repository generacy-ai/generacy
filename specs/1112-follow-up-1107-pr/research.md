# Research: phase-start-ref key migration + unresolvable-ref handling (#1112)

## Decision 1 — Migration mechanism: lazy read-through, not startup drain (Q2=A)

**Chosen:** On a branch-scoped key miss, read the single legacy key inline (`getValueRaw(legacyKey)`) before capturing fresh HEAD.

**Rejected:** Startup drain (`SCAN`/pattern-match all `phase-start-ref:*` at boot, migrate/clear).

**Rationale:**
- The legacy key `phase-start-ref:<owner>:<repo>:<issue>:<phase>` carries **no branch component**. The branch is only knowable from `context.branch` inside the phase loop. At boot there is no queue item, so a drain could only *delete* legacy refs — destroying the ref an in-flight implement phase still needs, which is the exact hazard this fix closes.
- `PhaseTracker` exposes only key-scoped `getValueRaw`/`setValueRaw`/`clearRaw` (#1107) — no `SCAN`/keyspace API. A drain would require net-new surface area.
- 7 worker replicas share one Redis. Concurrent boot scans mutating keys other workers are mid-phase on is unsafe.
- Lazy read-through touches exactly one key on exactly the code path that needs it, and only during the ≤7-day rollout window.

## Decision 2 — Consume-once: clear legacy on any read (Q3=A)

**Chosen:** `clearRaw(legacyKey)` fires whenever a legacy value was read — accepted (migrated), shape-invalid, or later found unresolvable.

**Rejected:** Clear only on successful migration; leave rejected keys to TTL.

**Rationale:** After #1110 nothing constructs the unbranched key, so a rejected legacy value can never be rewritten or become valid. Leaving it means a shape-valid-but-unresolvable legacy ref is re-read and re-rejected every increment, and stays eligible after a duplicate-PR re-entry on a different branch — reintroducing the cross-branch stale-ref fail-open that #1110's branch scoping closed. Consume-once is fail-closed (worst case: a fresh HEAD capture + an operator-resolvable false failure, never a silent pass). `clearRaw` degrades to a logged no-op when Redis is down, so consume-once is best-effort by construction.

## Decision 3 — Re-persist a migrated ref under the branch-scoped key, write-before-clear (Q1=A)

**Chosen:** On migration, `setValueRaw(branchKey, ref, TTL)` then `clearRaw(legacyKey)` — in that order.

**Rejected:** Reuse the migrated ref for the current increment only, without re-persisting.

**Rationale:** Without the re-persist, a *second* restart in the same phase misses both keys (legacy now cleared) and re-captures a HEAD past the product commits — converting a one-time upgrade hazard into an every-restart hazard, violating the accepted #1107 Q5=B persist-once-across-restarts property. Ordering the branch write before the legacy clear means a crash between the two costs at most a legacy re-read, never a lost window.

## Decision 4 — Existence probe: `git rev-parse --verify --quiet <sha>^{commit}` (Q4=B + measured caveat)

**Chosen probe:** `git rev-parse --verify --quiet <sha>^{commit}`.
- exit `0` → commit present.
- exit `1` → commit missing (both full 40-hex and abbreviated 7-40-hex shas) → treat as absent (FR-003/FR-004).
- exit `128` → environment fault (corrupt/inaccessible git dir, not-a-repo) → throw → surfaces via existing `product-diff-error` path (FR-005).

**Rejected probe (named on the issue):** `git cat-file -e <sha>^{commit}`.

**Measurement (git 2.52.0):**

| Command | missing object | not a git repository |
|---------|----------------|----------------------|
| `git cat-file -e <sha>^{commit}` | **128** | 128 — *indistinguishable* |
| `git cat-file -e <sha>` (full 40-hex) | 1 | 128 |
| `git cat-file -e <sha>` (abbrev) | **128** — *misclassifies short refs* | 128 |
| `git rev-parse --verify --quiet <sha>^{commit}` | **1** (full and abbrev) | **128** |

Only `rev-parse --verify --quiet <sha>^{commit}` produces the exit-1-vs-128 split that Q4=B requires, and `isValidCommitSha` accepts 7-40 hex, so the abbreviated-sha case matters. `getFilesChangedByOwnCommits` already threads exit code + stderr into its throw, so the surfacing path for the 128 class is already in place.

## Decision 5 — New capability on `GitHubClient`, not a bespoke git helper

**Chosen:** Add `commitExistsInCheckout(sha): Promise<boolean>` to the `GitHubClient` interface and `GhCliGitHubClient`.

**Rationale:** The #1107 local-git methods (`getCurrentCommitSha`, `getFilesChangedByOwnCommits`, `getFilesChangedBetween`) already live on `GitHubClient` and run in `GhCliGitHubClient.workdir` (== `context.checkoutPath`). The probe must run in the same workdir; the phase loop already holds `context.github: GitHubClient`. `GhCliGitHubClient` is the sole implementer (grep `implements GitHubClient`), so there is exactly one production impl to add and no new import edge. This is strictly consistent with how #1107 threaded its git surface.

## Pattern references

- Existing capture block: `packages/orchestrator/src/worker/phase-loop.ts:363-394` (read → validate → capture/persist).
- Existing consumption + `product-diff-error` path: `phase-loop.ts:813-848`; empty-diff escalation `:850-892`; pass-path clear `:894-898`.
- `isValidCommitSha`: `phase-loop.ts:50-52` (7-40 hex).
- Local-git method shape to mirror: `gh-cli.ts:1382-1431` (`executeCommand('git', [...], { cwd: this.workdir })` + exit-code guard).
- Raw-key `PhaseTracker` API + Redis-down degradation: `phase-tracker-service.ts:175-229`; interface `types/monitor.ts:566-568`.
- Changeset shape: `.changeset/1107-implement-product-diff-guard.md` (workflow-engine minor + orchestrator patch).

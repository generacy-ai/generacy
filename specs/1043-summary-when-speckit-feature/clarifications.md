# Clarifications for #1043

*Feature*: Deterministic branch/spec-slug + PR dedup on speckit workflow re-entry
*Branch*: `1043-summary-when-speckit-feature`

## Batch 1 — 2026-07-24

### Q1: Persistence layer for issue→branch/slug binding
**Context**: FR-001/FR-002 require idempotent branch derivation across container restarts, workspace re-clones, and workflow re-entries. The spec says "persisted" but doesn't say *where*. The choice is load-bearing: it dictates what code path resolves the slug on re-entry, and whether the source of truth survives fresh clusters and cold caches.
**Question**: Which single source of truth should hold the issue → `<N>-<slug>` binding across re-entries?
**Options**:
- A: **Remote git branches only.** On every entry, `gh api repos/{owner}/{repo}/branches --jq '.[].name'` (or `git ls-remote`) is queried for `^<N>-`; oldest match wins. No local index; no state store. Simplest, no cache-coherence problem, matches the observed "the correct branch already exists on the remote" remediation path.
- B: **PhaseTracker Redis key** (`branch-binding:<owner>:<repo>:<N>` → slug), refreshed from remote on miss. Faster hot path; adds a cache layer that can go stale on cross-cluster work.
- C: **Both** — Redis as the primary read, remote as the fallback + writeback. Belt-and-suspenders; more moving parts to keep in sync.
- D: **Persisted in the issue itself** (e.g., a hidden HTML comment marker on the issue body or a machine-parseable label). Survives cluster loss and works across owners; heavier write cost per first entry.

**Answer**: A — Remote git branches only: on every entry query the remote for `^<N>-` branches and reuse the oldest match; no local index or state store. Rationale: FR-002 mandates remote enumeration + oldest-match reuse, and the remote branch is the single artifact that survives fresh clusters and cold caches — the Redis-key path (B/C) is the stale-key/TTL failure mode that stranded #849.

### Q2: PR-first vs branch-first when both exist and disagree
**Context**: FR-002 and FR-003 both search for existing state, but the observed incident had *both* branches (`1038-issue-1038` and `1038-part-cockpit-remote-gates`) and *both* PRs (#1039 and #1041) alive at the same time. The dedup logic needs a deterministic tiebreaker when the remote already contains conflicting evidence — otherwise the fix itself is non-deterministic.
**Question**: When the remote contains multiple `<N>-*` branches AND multiple open PRs for issue N, which one is canonical?
**Options**:
- A: **Oldest open PR wins.** Its head branch becomes the canonical `<N>-<slug>`; any other `<N>-*` branch without an associated open PR is ignored (not deleted). Matches "one open PR per issue" invariant and prefers the branch with the real content (which was created first).
- B: **Oldest branch wins**, regardless of PR association. PRs are secondary; the branch is the source of truth.
- C: **Refuse to proceed** — log a structured `workflow-reentry-multiple-candidates` warning, keep the workflow paused, and require operator intervention. Safest but blocks automation.
- D: **Non-empty branch wins** — pick the branch with the most commits ahead of `develop` (proxy for "the branch with real work"). More heuristic but resilient to accidental empty branches.

**Answer**: A — Oldest open PR wins: its head branch is canonical; any other `<N>-*` branch without an associated open PR is ignored (not deleted). Rationale: FR-003 is PR-centric and encodes the one-open-PR-per-issue invariant, resolving the incident correctly (keep real PR #1039, ignore spec-only #1041); refuse/pause (C) defeats automation and most-commits (D) is the non-deterministic picker the spec puts out of scope.

### Q3: Scope of US3 / FR-006 in this PR
**Context**: The spec Assumptions section says "US1/US2 can land independently of US3" and "sibling fix #849 may resolve US3 outright; this spec should re-check after #849 lands." This creates ambiguity about what ships in *this* PR: the dedup primitives (US1/US2) definitely, but is US3's root-cause investigation and regression test in scope for #1043, or does it become a follow-up issue?
**Question**: What is the scope of this PR with respect to US3 (review-gate re-cycle)?
**Options**:
- A: **US1 + US2 only.** Ship the dedup primitives and defer US3 to a separate follow-up issue that gates on `#849`'s landing. The FR-006 line stays in the spec as intent, but the acceptance-test asserting "no re-application of `waiting-for:implementation-review` after `completed:validate`" is *not* required to land here.
- B: **US1 + US2 + defensive regression test for US3.** Ship dedup + a test that would have caught the re-cycle, but do *not* attempt to fix the underlying re-cycle code path (leave that to #849 or a follow-up). The test acts as a canary.
- C: **All three (US1 + US2 + US3 root cause).** Full scope in one PR: investigate the re-cycle, land the fix, and add both the dedup primitives and the re-cycle regression test. Largest PR; may be blocked on #849.
- D: **Wait for #849 to land first**, then re-scope. Blocks this PR entirely until #849 is merged.

**Answer**: A — Ship US1 + US2 only; defer US3 (review-gate re-cycle) to a follow-up issue gated on #849. FR-006 stays as intent; its acceptance test is not required to land here. Rationale: the spec's Assumptions state FR-001..FR-004 make the duplicate-PR outcome impossible even if the re-cycle continues, so US1/US2 land independently, and #849 is already CLOSED so the correct next step is a follow-up re-check rather than blocking this PR.

### Q4: First-entry slug format when no prior `<N>-*` branch exists
**Context**: US2 AC2 says the slug must come from "a stable input (e.g., issue title at first-entry time, persisted)." The observed incident showed the slug `1038-issue-1038` was one of the two competing forms — presumably a fallback when title-derivation produced something empty or unsuitable. This behavior is currently unspecified: what characters are allowed, what length cap, and what happens if the title is empty or all punctuation?
**Question**: What algorithm produces the first-entry slug from an issue's title?
**Options**:
- A: **Reuse the existing derivation** (whatever produced `1038-part-cockpit-remote-gates` and `1038-issue-1038` today) and just persist the result. This PR does not touch slug-generation logic; it only enforces "first-derived wins forever." Smallest surface area, but preserves any existing quirks in the current derivation.
- B: **Normalize to a stricter algorithm**: lowercase, `[a-z0-9-]` only, collapse repeat `-`, max 40 chars, fallback to `issue-<N>` if empty. Ship the new algorithm *and* the persistence rule together.
- C: **Always use `issue-<N>`** (i.e., branch = `<N>-issue-<N>`). Simplest, fully deterministic, no dependence on title mutations. Loses human-readable slugs.
- D: **Persist the title verbatim at first-entry time** (as a marker on the issue), and derive the slug from the persisted string on every future entry — so title edits after first entry are inert. Requires whatever storage Q1 picks.

**Answer**: A — Reuse the existing slug derivation and persist the result ('first-derived wins forever'); do not modify slug-generation logic. Rationale: under Q1-A the first-created remote branch IS the persisted first-derived slug, so FR-002's reuse-oldest-branch enforces first-derived-wins with zero re-derivation, eliminating the short_name-vs-description drift; a stricter new algorithm (B) risks the branch renames Out-of-Scope forbids.

### Q5: Workflow scope of the dedup enforcement
**Context**: "Out of Scope" limits this spec to `workflow:speckit-feature`, but FR-001..FR-007 talk about branch/PR/spec-slug derivation generically — the code paths involved (orchestrator branch resolver, PR opener, scaffolder) are shared across all workflows. This creates a question about *where* the gate lives.
**Question**: How should the dedup logic scope itself to `speckit-feature` (per Out of Scope)?
**Options**:
- A: **Apply dedup unconditionally to all workflows.** The `<N>-*` invariant is universally correct — no workflow benefits from opening two PRs per issue. Out-of-Scope was written to bound test coverage, not implementation scope. Simplest code path (no branching on workflow).
- B: **Gate the dedup code path on `workflow === 'speckit-feature'`** at the orchestrator entry point. Other workflows keep today's behavior. Matches Out-of-Scope literally.
- C: **Gate on a config flag** (`WorkflowConfig.enforceSingleBranch: boolean`, defaulting `true` for `speckit-feature` and `false` for others). Explicit knob per workflow definition; easiest to roll back per-workflow if a regression surfaces.
- D: **Enforce unconditionally, but log-only for non-speckit-feature workflows** (emit `workflow-reentry-branch-mismatch` without reusing). Observability everywhere; enforcement only for the workflow the spec covers.

**Answer**: A — Apply the dedup enforcement unconditionally to all workflows; treat the Out-of-Scope 'speckit-feature' clause as bounding test coverage, not implementation scope. Rationale: this spec's own header is workflow:speckit-bugfix while Out-of-Scope names only speckit-feature — gating on speckit-feature (B/C/D) would leave this very bugfix run unprotected — and the one-open-PR / deterministic-branch invariant (FR-001/FR-007) is universally correct.

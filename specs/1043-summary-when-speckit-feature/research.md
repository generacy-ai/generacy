# Research: Deterministic branch/spec-slug + PR dedup on speckit workflow re-entry

**Feature**: `1043-summary-when-speckit-feature` · **Related**: [spec.md](./spec.md) · [clarifications.md](./clarifications.md) · [plan.md](./plan.md)

## Scope of research

`spec.md` §Clarifications resolved the five load-bearing decisions (Q1–Q5). This document captures the remaining implementation research: (a) the current code paths that produce the bug, (b) existing helpers the fix reuses, (c) alternatives considered for the resolver injection shape, and (d) how the fix composes with adjacent systems (label-monitor, phase-tracker, `#849`).

## The failure trace, mapped to source

Reconstructed from `spec.md` §Observed Incident + code walk:

1. `PhaseLoop` (`packages/orchestrator/src/worker/phase-loop.ts`) enters phase `implement` for `generacy-ai/generacy#1038` after `cockpit_advance(implementation-review)`.
2. `SpeckitCreateFeatureAction` invokes `executeCreateFeature(input, logger)` (`packages/workflow-engine/src/actions/builtin/speckit/operations/create-feature.ts:12`).
3. `createFeature()` runs (`packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts:273`):
   - `input.number === 1038`
   - `input.description === "part cockpit remote gates"` (different from first entry's description)
   - `input.short_name === undefined`
   - `buildBranchNameFromPattern(config, 1038, "part cockpit remote gates")` (`feature.ts:303`) → `"1038-part-cockpit-remote-gates"`
   - `exists(specs/1038-part-cockpit-remote-gates)` (`feature.ts:320`) → **`false`** (only `specs/1038-issue-1038/` exists from first entry)
   - Falls through to `feature.ts:384` — `mkdir` new dir, `checkoutLocalBranch("1038-part-cockpit-remote-gates")` (`feature.ts:448`).
4. `PrManager.commitPushAndEnsurePr()` (`packages/orchestrator/src/worker/pr-manager.ts:51`) runs.
5. `ensureDraftPr()` (`pr-manager.ts:139`) calls `findPRForBranch(owner, repo, "1038-part-cockpit-remote-gates")` (`pr-manager.ts:149`).
6. `findPRForBranch` (`packages/workflow-engine/src/actions/github/client/gh-cli.ts:815`) runs `gh pr list --head 1038-part-cockpit-remote-gates --limit 1` → returns `null` (real PR #1039 is on branch `1038-issue-1038`, not queried).
7. `createPullRequest()` opens PR #1041 on the new empty branch.

**Root cause** is the `input.description` variance across re-entries — cluster restarts, workspace re-clones, or a re-derivation from any ambient input (issue title edit, PR body change, cwd) can shift the derived slug. The idempotency check at `feature.ts:320` is keyed by *derived* slug, not *issue identity*.

The fix inverts the lookup order: **issue identity first (via remote branch enumeration), slug derivation only as a fallback**.

## Existing helpers the fix reuses

The `gh-cli.ts` client already exposes the two enumeration primitives the resolver needs — no new gh-cli methods are added.

### `listOpenPullRequests(owner, repo)` (`gh-cli.ts:756`)

- Executes `gh pr list -R <owner>/<repo> --state open --json number,title,body,state,isDraft,headRefName,baseRefName,labels,createdAt,updatedAt --limit 100`.
- Returns `PullRequest[]` with `head.ref` and `created_at` populated — exactly what the resolver needs for step 1 of the tiebreak (oldest open PR wins).
- Filter `pr.head.ref.match(/^${issueNumber}-/)` client-side (small N; per-repo open PRs typically <100).

### `listBranches(owner, repo)` (`gh-cli.ts:1308`)

- Executes `gh api /repos/<owner>/<repo>/branches --jq '.[].name'` with fallback to `git branch -r`.
- Returns `string[]` of branch names.
- Fallback to `git for-each-ref --format='%(refname:short) %(committerdate:unix)' refs/remotes/origin/` inside the resolver — needed to get commit timestamps for the branch-oldest tiebreak (Q2-A fallback). `simple-git` handles this via `git.raw()`.

### `findPRForBranch(owner, repo, branch)` (`gh-cli.ts:815`)

- Executes `gh pr list -R <owner>/<repo> --head <branch> --limit 1`.
- Unchanged. Called by `PrManager` for the canonical branch after the resolver runs.

## Why Q1-A ("remote branches only") over Q1-B/C/D

`clarifications.md` §Q1 already records the answer. Adding implementation-level reasoning here:

- **Q1-B (PhaseTracker Redis key)** would introduce a cross-process cache with TTL. `#849` (Pause-Paired Resume-Dedupe Clear) shipped a fix for a nearly-identical stale-key bug in the same code path. Repeating that failure mode for a different key would be a regression.
- **Q1-C (Redis primary + remote fallback)** — the writeback path doubles the number of failure modes to reason about (write succeeds but read stale; read succeeds but write dropped). Not worth the hot-path latency win for a code path invoked per phase entry (minutes, not seconds).
- **Q1-D (marker on the issue body)** — heavy write cost per first entry (`gh issue edit` mutates the issue); breaks under GitHub App permission edge cases; issue-body markers are churn-visible in the audit trail.

**Q1-A operational cost**: two subprocesses per phase entry (~500 ms total). Phase entries are minutes-cadence. Cost is negligible.

## Why callback injection over direct `GitHubClient` dependency (plan D-1)

`feature.ts` is a **library** with three callers today:

1. `packages/workflow-engine/src/actions/builtin/speckit/operations/create-feature.ts` — the workflow-engine action wrapper.
2. Ad-hoc MCP tool paths via the same `executeCreateFeature` (`feature.ts:9` docstring: *"Ported from speckit MCP server for direct library access"*).
3. Test suites (`deterministic.test.ts`) that construct `CreateFeatureInput` fixtures directly.

Adding a required `github: GitHubClient` field to `CreateFeatureInput` would:

- Force MCP-tool paths to construct a stub client for the git-only workflow.
- Break every test fixture that doesn't happen to need PR enumeration.
- Couple `feature.ts` — which is currently pure library over `simpleGit` — to the workflow-engine's HTTP surface.

An **optional callback** (`resolveExistingBranch?: (issueNumber: number) => Promise<string | null>`) preserves all existing behavior when unset. Callers that have a `GitHubClient` (only the workflow-engine action) construct the resolver and pass a closure.

## Composition with adjacent systems

### Sibling fix `#849` (Pause-Paired Resume-Dedupe Clear)

`#849` addresses the *trigger* for re-entry (stale `PhaseTracker` `resume:<gate>` keys causing `implementation-review` to fire twice). This spec addresses the *outcome* (duplicate branch/PR when the trigger fires). Per Q3-A, US3 defers to a follow-up gated on `#849`'s landing. Order-of-operations:

- Land this PR → duplicate-PR outcome is eliminated even while the trigger persists.
- `#849` reduces the trigger frequency to zero.
- US3 follow-up adds a regression test that both together prevent re-cycling on the same head SHA.

### `PhaseLoop` `phase-after` hook (`#690`)

`packages/orchestrator/src/worker/phase-loop.ts:758-760` (per CLAUDE.md `#690`) invokes `phaseAfterHandlers` after commit-push-pr, before the gate check. This hook is *not* the extension point for this fix — the resolver runs *before* `createFeature` and *inside* `ensureDraftPr`, both of which precede the phase-after hook. The hook stays available for the US3 follow-up (which may want to detect gate re-cycling post-phase).

### `LabelMonitorService` / `PhaseTrackerService`

Unchanged. Neither reads nor writes any branch/slug binding — the label-monitor picks up `process:*` labels and enqueues, and phase-tracker dedups Redis keys keyed by `<owner>:<repo>:<issue>:<phase>`. Neither knows the branch name. This fix is upstream of both.

### `speckit-bugfix` workflow

`workflows/speckit-bugfix.yaml` uses the same `create_feature` step shape as `speckit-feature.yaml`. Per Q5-A the fix applies unconditionally — no workflow-name conditional in the resolver or its callers. The changeset covers both workflows implicitly.

## Alternatives considered and rejected

### Alt-1: Normalize slug derivation to `issue-<N>` (Q4-C)

Fully deterministic, no dependence on title mutations. **Rejected** per Q4-A: would rename all future branches (breaking convention), and doesn't fix pre-existing branches whose slugs came from title derivation. The reuse-oldest-branch rule handles both cases with zero rename churn.

### Alt-2: Persist first-entry title as an issue-body marker (Q1-D)

Would survive across workspace re-clones AND provide human-readable slug persistence. **Rejected**: heavier write cost per first entry; issue-body edits show in the audit trail; GitHub App permission edge cases (some installations don't grant `issues: write`).

### Alt-3: Refuse and pause on multi-candidate state (Q2-C)

Safest — force operator intervention when the remote already contains conflicting evidence. **Rejected** per Q2-A: defeats automation; the oldest-open-PR-wins rule resolves the incident correctly (keep #1039, ignore #1041); refuse-mode would require operator time on every re-cycle event until `#849` lands.

### Alt-4: Non-empty branch wins tiebreak (Q2-D)

`git log --oneline <branch>` count as the "which branch has real work" proxy. **Rejected** per Q2-A: non-deterministic picker; the spec's Out of Scope explicitly forbids picker-logic changes.

### Alt-5: Wait for `#849` to land first (Q3-D)

Would let US3 land in the same PR. **Rejected** per Q3-A: `#849` is already **CLOSED** (`#849` shipped separately); FR-001..FR-004 make the duplicate-PR outcome impossible even if the re-cycle continues. Blocking this PR on a closed sibling is nonsensical.

## Sources

- `packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts` (createFeature, buildBranchNameFromPattern, idempotency check).
- `packages/orchestrator/src/worker/pr-manager.ts` (ensureDraftPr).
- `packages/workflow-engine/src/actions/github/client/gh-cli.ts` (listOpenPullRequests, listBranches, findPRForBranch).
- `packages/orchestrator/src/worker/phase-loop.ts` (phase-after handler hook, `#690`).
- CLAUDE.md sections for `#849`, `#690`, `#1015`, `#1024` (adjacent fixes and idioms).
- `spec.md` §Observed Incident (real trace from `#1038` / PRs #1039 + #1041).

# Implementation Plan: Implement-phase product-diff guard — exclude agent-context files and measure the phase's own diff

**Feature**: Tighten the implement-phase "produced no product-code changes" guard so it (a) excludes spec-kit `update_agent` targets by exact filename and (b) measures the diff the phase itself produced, immune to earlier-phase and base-merge contamination.
**Branch**: `1107-summary-implement-phase-s`
**Issue**: [generacy-ai/generacy#1107](https://github.com/generacy-ai/generacy/issues/1107)
**Workflow**: `speckit-bugfix`
**Status**: Complete

## Summary

The guard shipped in #820 (`product-diff.ts` + `phase-loop.ts:709-784`) is structurally defeated on every speckit branch by two composing defects:

1. **Incomplete exclusion list** — `EXCLUDED_PATH_PREFIXES = ['specs/']` treats root `CLAUDE.md` (written by the specify phase via `update_agent`) as product code, so `productFiles` is never empty.
2. **Wrong diff window** — `computeProductDiff` diffs the cumulative `baseRef...HEAD` branch diff, so any product file touched by *any* earlier phase (or a base merge) permanently satisfies the guard for every later phase.

This fix ships **exactly the two structural defects** (FR-006's zero-tasks net is deferred per Clarification Q2 → A):

- **FR-001** — add an **exact-filename** exclusion set (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`), matched at repo-root only (Q3 → A), alongside the retained `specs/` prefix.
- **FR-002** — replace the cumulative window with a **phase-scoped** window: a start ref captured on first implement entry (after the pre-phase base merge), persisted across restarts in Redis, and measured via `git log --first-parent --no-merges --name-only <startRef>..HEAD`. First-parent + no-merges makes the window immune to base-merge-introduced files (Q4 → A); the persisted ref makes it span all pre-restart increments (Q5 → B).

The pass/fail decision, escalation surface, and detection-failure fallback are unchanged (reuse `phase-loop.ts:754-783`); only *what counts as a change* and *which window is measured* change.

## Technical Context

- **Language / runtime**: TypeScript, ESM, Node ≥22.
- **Packages touched**:
  - `packages/orchestrator/src/worker/` — `product-diff.ts`, `phase-loop.ts`, `claude-cli-worker.ts`, `types.ts` (PhaseLoopDeps).
  - `packages/orchestrator/src/services/phase-tracker-service.ts` — add raw string get/set (persist the start ref).
  - `packages/orchestrator/src/server.ts` — thread the already-constructed `workerPhaseTracker` into `PhaseLoopDeps` (no new service instantiation).
  - `packages/workflow-engine/src/actions/github/client/` — `interface.ts` + `gh-cli.ts`: two new local-git methods (`getCurrentCommitSha`, `getFilesChangedByOwnCommits`).
- **Persistence**: Redis, already guaranteed non-null for workers (`server.ts:271-293`). Reuse `PhaseTrackerService`'s Redis client — no new store, no new container.
- **git primitives**: local `git rev-parse HEAD` and `git log --first-parent --no-merges --name-only --pretty=format: <ref>..HEAD`, run in `context.checkoutPath` via the existing `executeCommand('git', …, { cwd })` pattern in `gh-cli.ts` (same mechanism as `getFilesChangedBetween` at `gh-cli.ts:1382`).
- **Enforcement point**: unchanged — `phase-loop.ts` step 5b, after `commitPushAndEnsurePr`, gated on `PHASES_REQUIRING_CHANGES` (currently `{implement}`).

## Key Technical Decisions

1. **Phase-scoped window via `git log --first-parent --no-merges`, not `git diff`.**
   A single-ref `git diff <startRef>..HEAD` (two-dot) would re-admit base-merge-introduced develop files after a resume, recreating the fail-open defect (Q4). `--first-parent` stays on the branch's own commit line (never descends into merged-in develop commits); `--no-merges` drops the merge commits themselves. The remaining commits are exactly the phase's own regular commits. Verified against all four scenarios in `research.md`.

2. **Start ref captured *after* the pre-implement base merge, persisted only on first entry.**
   Capturing after the base merge (`phase-loop.ts:317`) means the ref is a post-merge commit; persisting only when no ref exists yet means resumes reuse the first-entry ref (spanning all increments, Q5). Because the window uses first-parent/no-merges, later increments' base merges are excluded regardless of where the ref sits.

3. **Reuse `PhaseTrackerService` + Redis; add raw string get/set.**
   `PhaseTrackerService` already owns the worker's Redis client and is already threaded into the worker (`server.ts:352,380`). It already exposes caller-owned raw-key methods (`isDuplicateRaw`/`markProcessedRaw`, #892). Adding `getValueRaw`/`setValueRaw` (arbitrary string value + explicit TTL) is the minimal, precedented extension. No new service, no new wiring beyond adding `phaseTracker` to `PhaseLoopDeps`.

4. **Exact-filename exclusion is additive and root-only.**
   New `EXCLUDED_EXACT_PATHS` constant + `isProductFile(path, prefixes?, exactPaths?)` optional third arg. Root-level exact match only (Q3 → A) — nested `packages/*/CLAUDE.md` remains product code. `specs/` prefix retained.

5. **No escape hatch for legitimate agent-context-only implement phases (Q1 → A).**
   Such a phase false-fails; operator resolves via review / `/cockpit:resume`. Fail-closed is the correct bias for a safety net; a marker that makes an empty phase "count" is the exact bypass shape this bug exploited.

6. **Detection-failure fallback preserved (SC-005).**
   The new git-log call and the start-ref capture live inside the existing `try/catch` at `phase-loop.ts:717-752`; any throw (unreachable ref, git failure) still routes to the `product-diff-error` classifier reason.

## Project Structure

```
packages/
  workflow-engine/src/actions/github/client/
    interface.ts                 # + getCurrentCommitSha, getFilesChangedByOwnCommits
    gh-cli.ts                    # + local-git impls (mirror getFilesChangedBetween pattern)
  orchestrator/src/
    worker/
      product-diff.ts            # + EXCLUDED_EXACT_PATHS; isProductFile exact-match arg;
                                 #   + computePhaseScopedProductDiff(github, startRef)
      phase-loop.ts              # capture/persist/reuse start ref after base merge;
                                 #   guard uses phase-scoped diff; FR-004 diagnostics;
                                 #   clear ref on successful implement completion
      types.ts                   # PhaseLoopDeps gains optional phaseTracker
      claude-cli-worker.ts       # pass this.phaseTracker into PhaseLoopDeps
      __tests__/
        product-diff.test.ts             # exact-path unit tests; new fn unit tests
        phase-loop.product-diff.test.ts  # SC-001/SC-002/SC-004 integration
    services/
      phase-tracker-service.ts   # + getValueRaw / setValueRaw
      __tests__/phase-tracker-service.test.ts  # raw string get/set
    server.ts                    # thread workerPhaseTracker into PhaseLoopDeps
specs/1107-summary-implement-phase-s/
  plan.md research.md data-model.md quickstart.md contracts/ stack.md
.changeset/
  1107-implement-product-diff-guard.md   # @generacy-ai/orchestrator + workflow-engine
```

## Constitution Check

No `.specify/memory/constitution.md` present in the repo. Repo-level gates that apply:

- **Changeset gate** (`CLAUDE.md`): non-test `src/` changes in `orchestrator` and `workflow-engine` ⇒ a **new** `.changeset/*.md` is required. `workflow-engine` gains a new public method (new capability) ⇒ **minor**; `orchestrator` is an internal bugfix (no new public export) ⇒ **patch**. One changeset file listing both packages.
- **No new YAML/WorkerConfig surface** — exclusion sets stay module-level constants (#820 Q1; reaffirmed in Assumptions).
- **FR-005** — `isProductFile` / `computeProductDiff` public shapes stay consumable; `resolveBaseRef` (shared with `base-merge.ts`) is untouched; the new window is additive.

## Rollout / Risk

- **Redis unavailable** (degraded): `getValueRaw` returns `null` ⇒ ref re-captured each increment ⇒ post-resume-only window (Q5 → A fallback behavior). Workers require Redis, so this is a defense-in-depth path only.
- **Unreachable persisted ref** (e.g. a destructive `git reset --hard` in a conflict remedy): `git log` throws ⇒ `product-diff-error` detection failure ⇒ operator-visible, not a silent pass. Acceptable and preserves SC-005.
- **TTL**: start ref stored with a 7-day TTL (longer than the 24h dedup default) to survive long gate pauses / fixer timeouts; expiry degrades to re-capture, never to a silent pass.

## Next Step

`/speckit:tasks` to generate the dependency-ordered task list.

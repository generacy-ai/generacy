# Implementation Plan: Spec-stage commits must not carry repo-root agent-context files; fix the dead #899 drift guard

**Feature**: Engine-side guard excluding and reverting repo-root agent-context files from spec-stage phase commits, plus removal of the dead #899 Layer-1 drift guard
**Branch**: `1218-problem-two-gaps-let`
**Status**: Complete

## Summary

Two coordinated changes:

1. **Staging guard + revert in `PrManager.commitAndPush`** (`packages/orchestrator/src/worker/pr-manager.ts`).
   When the completing phase is spec-stage (`specify`, `clarify`, `plan`, `tasks`), paths equal to
   an entry of `EXCLUDED_EXACT_PATHS` (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`,
   `.github/copilot-instructions.md` — reused from `product-diff.ts`, not duplicated) are removed
   from `toStage`, a warning naming them is logged, and they are reverted in the working tree
   (tracked → restored to HEAD; untracked → deleted) via a new `GitHubClient.revertPaths()` method.
   Implement-and-later phases are untouched. An exclusion-emptied commit proceeds as a normal
   `no-changes` outcome (Q3).

2. **Dead Layer-1 guard removal** (`packages/workflow-engine/.../__tests__/managed-file-disjointness.test.ts`).
   Delete the `Layer 1 — static-grep drift guard` describe block (it greps `operations/plan.ts`
   `buildPlanPrompt()`, a path cluster workers never execute). Retain Layer 2 (merge-tree
   simulation). Rewrite the test header comment and
   `specs/899-found-during-cockpit-v1/contracts/merge-tree-invariant.md` to document that the
   prompt-side invariant is pinned in agency (`agency-plugin-spec-kit` tests, agency#511) and the
   engine-side invariant is the pr-manager revert + its behavioral unit tests (Q4 — no replacement
   static guard).

## Technical Context

- **Language/runtime**: TypeScript, ESM, Node >= 22
- **Test framework**: vitest (mock-based unit tests for pr-manager; temp-git-repo tests for gh-cli, following the existing `managed-file-disjointness` Layer-2 pattern)
- **Packages touched**: `@generacy-ai/orchestrator` (guard), `@generacy-ai/workflow-engine` (new client method; test/contract edits)
- **Cross-package build note**: orchestrator imports `GitHubClient` from workflow-engine's built `dist/` — rebuild workflow-engine before typechecking/testing orchestrator, or the new `revertPaths` member appears as "no exported member".

## Design decisions

(Full rationale and alternatives in [research.md](research.md).)

| # | Decision |
|---|----------|
| D1 | **Spec-stage predicate is derived, not a new list**: `PHASE_TO_STAGE[phase] !== 'implementation'` (`worker/types.ts`) yields exactly `specify`/`clarify`/`plan`/`tasks`. No second phase list to drift. |
| D2 | **Revert goes through the `GitHubClient`**: add `revertPaths(paths: string[]): Promise<void>` to the interface + `GhCliGitHubClient`. Keeps pr-manager's all-git-ops-via-client pattern and its mock-based test style. `discardWorkingTreeChanges` was rejected — it `reset --hard`s the whole tree. |
| D3 | **Exact-match filter only** against `EXCLUDED_EXACT_PATHS`. `isProductFile()` cannot be reused here: it also excludes the `specs/` prefix, which is precisely what spec-stage commits consist of. |
| D4 | **Commit first, revert after, revert is non-fatal**: the excluded paths are partitioned out of `toStage` before staging; the product commit proceeds; then `revertPaths` runs in its own try/catch so a revert failure can never lose the product commit. The warning (FR-003) fires whenever excluded paths were found dirty, including the exclusion-emptied case. |
| D5 | **Staging filter only** (Q2): commits the agent made directly are pushed untouched; the limitation is documented in the code comment beside the filter. |
| D6 | **Changeset**: one file listing `@generacy-ai/workflow-engine: minor` (new public `revertPaths` API) and `@generacy-ai/orchestrator: patch` (defect fix). |

## Project structure (files changed)

```
packages/workflow-engine/src/actions/github/client/
├── interface.ts                          # + revertPaths() declaration
├── gh-cli.ts                             # + revertPaths() implementation
└── __tests__/gh-cli.revert-paths.test.ts # NEW — temp-repo behavioral tests

packages/orchestrator/src/worker/
├── pr-manager.ts                         # spec-stage filter + warn + revert call
└── __tests__/pr-manager.agent-context-revert.test.ts  # NEW — SC-001/SC-004 tests

packages/workflow-engine/src/actions/builtin/speckit/__tests__/
└── managed-file-disjointness.test.ts     # remove Layer 1, rewrite header (SC-003)

specs/899-found-during-cockpit-v1/contracts/
└── merge-tree-invariant.md               # re-document layer locations (FR-006)

CLAUDE.md                                 # one-line pointer update (FR-008; no docs/ hits)
.changeset/1218-agent-context-guard.md    # NEW (FR-009)
```

### `revertPaths` implementation sketch (gh-cli.ts)

```
1. paths empty → return
2. git reset -q HEAD -- <paths>          # unstage (staged-new files become untracked)
3. git ls-files -- <paths>               # partition: listed = tracked in HEAD
4. tracked:   git checkout -- <tracked>  # restore HEAD content
5. untracked: rm -f <workdir>/<path>     # delete
```

### `commitAndPush` change sketch (pr-manager.ts)

```
const specStage = PHASE_TO_STAGE[phase] !== 'implementation';
const candidates = [...existing sidecar filter...];
const excluded = specStage ? candidates.filter(p => EXCLUDED_EXACT_PATHS.includes(p)) : [];
const toStage  = specStage ? candidates.filter(p => !EXCLUDED_EXACT_PATHS.includes(p)) : candidates;
// ...existing stage/commit of toStage unchanged...
if (excluded.length > 0) {
  logger.warn({ phase, reverted: excluded }, 'Reverted agent-context files from spec-stage commit');
  try { await this.github.revertPaths(excluded); } catch { /* warn, non-fatal */ }
}
// Limitation (Q2): this is a staging filter only — commits the phase agent
// made directly are pushed as-is; prompt-side pin lives in agency (agency#511).
```

## Test plan (maps to Success Criteria)

- **SC-001 / SC-004** — `pr-manager.agent-context-revert.test.ts` (mock `GitHubClient`, same style as `pr-manager.staging-filter.test.ts`):
  - `plan` phase, dirty `CLAUDE.md` + `specs/x/stack.md` → stages/commits only `stack.md`; `revertPaths(['CLAUDE.md'])`; warning logged (US1 AC1–3).
  - All four `EXCLUDED_EXACT_PATHS` entries across staged/unstaged/untracked → none staged, all reverted.
  - `specify`, `clarify`, `tasks` phases guarded identically (Q1).
  - `implement` phase, dirty `CLAUDE.md` → staged and committed unchanged; `revertPaths` never called (US1 AC4).
  - Exclusion-emptied commit → no stage/commit call, `revertPaths` called, warn logged, outcome `no-changes` (Q3).
  - `revertPaths` rejects → product commit and push still complete; warn logged.
- **SC-001 (client)** — `gh-cli.revert-paths.test.ts` (real temp repo): tracked-modified restored; untracked deleted; staged-new unstaged-then-deleted; mixed call; empty call is a no-op.
- **SC-002** — existing `pr-manager.staging-filter.test.ts` (#1162) runs unmodified (its scenarios use `implement`).
- **SC-003** — `managed-file-disjointness.test.ts` contains no reference to `operations/plan.ts` / `buildPlanPrompt`; Layer 2 still passes.

## Constitution check

`.specify/memory/constitution.md` does not exist — no constitution gates apply.

## Artifacts

- [research.md](research.md) — decisions & alternatives
- [data-model.md](data-model.md) — interface/type changes
- [contracts/spec-stage-agent-context-guard.md](contracts/spec-stage-agent-context-guard.md) — guard contract
- [quickstart.md](quickstart.md) — build/test workflow
- [stack.md](stack.md) — per-feature technology notes

---

*Generated by speckit*

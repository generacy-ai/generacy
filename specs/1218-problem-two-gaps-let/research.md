# Research: Spec-stage agent-context guard & #899 drift-guard fix

## D1 — How to express "spec-stage phases"

**Decision**: derive the predicate from the existing `PHASE_TO_STAGE` map in
`packages/orchestrator/src/worker/types.ts`: a phase is spec-stage iff
`PHASE_TO_STAGE[phase] !== 'implementation'`. Today that yields exactly
`specify | clarify` (stage `specification`) and `plan | tasks` (stage `planning`) — the four
phases named by Q1 — while `implement | review | validate | remediate` all map to
`implementation`.

**Alternatives considered**:
- *A hand-written `Set<WorkflowPhase>(['specify','clarify','plan','tasks'])`*: rejected — a second
  list that can drift from the phase vocabulary. `PHASE_TO_STAGE` is `Record<WorkflowPhase, …>`,
  so adding a new phase forces a stage assignment, and the guard follows automatically with the
  correct default (a future spec-stage phase gets the belt-and-suspenders behavior; a future
  implementation-stage phase is preserved). That auto-follow is the point of Q1's answer.
- *`phase === 'plan'` only*: rejected by clarification Q1=B.

## D2 — Where the working-tree revert lives

**Decision**: add `revertPaths(paths: string[]): Promise<void>` to the `GitHubClient` interface
(`packages/workflow-engine/src/actions/github/client/interface.ts`) and implement it in
`GhCliGitHubClient` (`gh-cli.ts`). `PrManager` calls `this.github.revertPaths(excluded)`.

**Rationale**:
- Every git operation `PrManager` performs already goes through the injected `GitHubClient`
  (`getStatus`, `stageFiles`, `commit`, `push`, …). The existing behavioral tests
  (`pr-manager.staging-filter.test.ts`, #1162) mock that client; the SC-001 tests for this
  feature slot into the same pattern by asserting on a `revertPaths` mock.
- `GhCliGitHubClient` is the only `implements GitHubClient` in the repo (verified by grep);
  all other usages are mock casts, so the interface addition has one real implementation site.

**Alternatives considered**:
- *Reuse `discardWorkingTreeChanges(excludePaths)`*: rejected — it runs
  `git reset --hard HEAD` + `git clean -fd` over the whole tree. We need the inverse scoping
  (revert *only* the named paths, preserve everything else, e.g. an agent-staged product file).
- *Orchestrator-local helper using `simpleGit(this.checkoutPath)`*: rejected — `checkoutPath` is
  an optional constructor arg on `PrManager` (absent in existing tests), it breaks the
  mock-client test style, and it forks the "git ops go through the client" convention.

## D3 — Filter semantics

**Decision**: exact string equality against `EXCLUDED_EXACT_PATHS` imported from
`packages/orchestrator/src/worker/product-diff.ts` (the #1107 single source of truth —
Assumptions section of the spec). No prefixes, no basenames.

**Why not reuse `isProductFile()`**: it composes `EXCLUDED_PATH_PREFIXES` (which contains
`specs/`) with the exact paths. Spec-stage commits are *mostly* `specs/` files — filtering
`toStage` through `isProductFile` would empty every spec-stage commit. Only the exact-path half
applies here. The exact-match rule inherits #1107's documented reasoning: `startsWith` would
swallow `CLAUDE.md.bak`; basename-at-any-depth would swallow genuine
`packages/<pkg>/CLAUDE.md` documentation work.

## D4 — Ordering and failure isolation inside `commitAndPush`

**Decision**: partition first (excluded vs. kept), stage/commit the kept paths exactly as today
(explicit pathspec — an agent-pre-staged `CLAUDE.md` in the index is therefore never folded in),
then log the FR-003 warning and call `revertPaths` in its own try/catch.

**Rationale**: `commitAndPush`'s outer catch converts any throw into a non-fatal `no-changes`;
if the revert ran before the commit and threw, the product commit would be silently skipped. A
guard must never lose product work, so the revert is best-effort *after* the commit. The warning
fires whenever excluded dirty paths were found — including when the exclusion empties the commit
(Q3: that case proceeds as `no-changes`, matching the existing tolerance — only `implement` is in
`PHASES_REQUIRING_CHANGES`).

## D5 — Revert implementation (`git` sequence)

**Decision** (per FR-002: checkout tracked, delete untracked — generalized to survive a dirty
index):

1. `git reset -q HEAD -- <paths>` — unstages; a staged-*new* file (agent ran `git add CLAUDE.md`
   on a file absent from HEAD) becomes plain untracked.
2. `git ls-files -- <paths>` — after step 1 the index matches HEAD for these paths, so listed ⇒
   tracked, unlisted ⇒ untracked.
3. `git checkout -- <tracked>` — restore HEAD content.
4. `rm -f` each untracked path (via `node:fs/promises` `rm` with `force: true`).

A bare `git checkout -- <untracked>` errors with "pathspec did not match", which is why the
tracked/untracked partition is required rather than one blanket command. `git restore
--source=HEAD --staged --worktree` was rejected for the same reason (errors on paths absent
from HEAD).

## D6 — Layer-1 guard: remove without replacement

**Decision** (clarification Q4=A): delete the `Layer 1` describe block from
`managed-file-disjointness.test.ts`; add no replacement static guard. The engine-side
enforcement is the behavioral pr-manager test suite (SC-001); the prompt-side pin lives in
agency (`agency-plugin-spec-kit` tests, sibling issue agency#511). Header comment and
`specs/899-found-during-cockpit-v1/contracts/merge-tree-invariant.md` are rewritten to say
exactly that, so a future reader of the #899 contract finds the live enforcement sites. Layer 2
(merge-tree simulation) is retained verbatim (FR-007).

**Why no new static guard over `pr-manager.ts`**: #899's own lesson — a static grep aimed at
the wrong file stayed green for months while the regression ran free. A behavioral test
exercising the real commit path is strictly stronger evidence.

## D7 — Documentation & release plumbing

- **FR-008**: `docs/` contains no mention of #899 / the disjointness guard (verified by grep);
  only the `CLAUDE.md` pointer paragraph (lines 5–11, "Per-feature technology notes") needs a
  one-line touch noting spec-stage commits exclude/revert repo-root agent-context files.
  Per CLAUDE.md's own rules this stays a single line, not a narrative.
- **FR-009**: one changeset file: `@generacy-ai/workflow-engine: minor` (new `revertPaths` on
  the public `GitHubClient` interface, re-exported from the package index) and
  `@generacy-ai/orchestrator: patch` (defect fix). The disjointness-test and contract edits are
  test/spec files and would not alone require a changeset, but the interface + gh-cli changes do.

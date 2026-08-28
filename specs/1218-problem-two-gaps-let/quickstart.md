# Quickstart: Spec-stage agent-context guard (#1218)

## Build & test workflow

```bash
pnpm install

# workflow-engine first — orchestrator resolves GitHubClient from its dist/
pnpm --filter @generacy-ai/workflow-engine build

# targeted test runs
pnpm --filter @generacy-ai/workflow-engine test -- gh-cli.revert-paths
pnpm --filter @generacy-ai/workflow-engine test -- managed-file-disjointness
pnpm --filter @generacy-ai/orchestrator test -- pr-manager
```

If orchestrator typechecking reports `revertPaths` as "no exported member" on `GitHubClient`,
the workflow-engine `dist/` is stale — rebuild it (see CLAUDE.md "Development").

## Verifying the guard by hand

In a scratch clone processed by a worker (or a temp repo driving `PrManager` directly):

1. Dirty both `CLAUDE.md` and `specs/<feature>/stack.md` at plan-phase completion.
2. Observe the phase commit: `git show --name-only HEAD` lists `stack.md` only.
3. Observe the tree: `git status --porcelain` is clean — `CLAUDE.md` restored (tracked) or
   deleted (untracked).
4. Observe the worker log: a `warn` entry naming the reverted paths.
5. Repeat with an implement-phase completion: `CLAUDE.md` **is** committed (guard scoped to
   spec-stage phases only).

## Success-criteria checklist

| SC | Check |
|----|-------|
| SC-001 | `pr-manager.agent-context-revert.test.ts` + `gh-cli.revert-paths.test.ts` pass |
| SC-002 | `pr-manager.staging-filter.test.ts` (#1162) passes unmodified |
| SC-003 | `grep -c 'operations/plan.ts\|buildPlanPrompt' managed-file-disjointness.test.ts` → 0 |
| SC-004 | Commit-contents assertion in the new pr-manager tests |

## Changeset (CI gate — do not skip)

The PR must add a **new** `.changeset/*.md` file, e.g. `.changeset/1218-agent-context-guard.md`:

```md
---
"@generacy-ai/workflow-engine": minor
"@generacy-ai/orchestrator": patch
---

Spec-stage phase commits exclude and revert repo-root agent-context files; new
GitHubClient.revertPaths().
```

## Troubleshooting

- **`git checkout -- <path>` fails with "pathspec did not match"**: the path is untracked in
  HEAD — the revert must partition via `git ls-files` after `git reset HEAD -- <paths>` and
  delete untracked paths instead (see research.md D5).
- **Guard fires on implement phase**: the stage predicate must use
  `PHASE_TO_STAGE[phase] !== 'implementation'`; check the phase string actually passed to
  `commitAndPush`.
- **Agent-context file still lands in the PR**: check whether the *agent* committed it directly
  (`git log --name-only`) — that path is out of scope by design (Q2); the prompt-side fix is
  agency#511.

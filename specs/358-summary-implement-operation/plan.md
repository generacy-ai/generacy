# Implementation Plan: Incremental Commits in Implement Operation

**Feature**: Add incremental commits after each task in implement operation
**Branch**: `358-summary-implement-operation`
**Status**: Complete

## Summary

Add per-task `git commit` + periodic `git push` inside `implement.ts` so that a session crash only loses the current in-progress task, not all prior work. Also clean the working tree after failed tasks, update the `phase-loop.ts` fallback pattern, update both workflow YAML files to avoid empty commits, and update the `implement.md` command definition to reflect the new unconditional commit constraint.

## Technical Context

**Language/Version**: TypeScript (Node.js 20+)
**Primary Dependencies**: `executeCommand` (cli-utils), Node.js `node:path`
**Storage**: Git (local + remote)
**Testing**: Vitest (existing test suite)
**Target Platform**: Linux devcontainer / CI
**Project Type**: Monorepo (pnpm workspaces) — changes span two workspaces

## Files to Modify

### Workspace: `/workspaces/generacy`

```text
packages/workflow-engine/src/actions/builtin/speckit/operations/implement.ts
packages/orchestrator/src/worker/phase-loop.ts
.generacy/speckit-feature.yaml
workflows/speckit-feature.yaml
```

### Workspace: `/workspaces/agency`

```text
packages/agency-plugin-spec-kit/commands/implement.md
packages/claude-plugin-agency-spec-kit/commands/implement.md
```

## Implementation Design

### T001 — Resolve repo root in `implement.ts`

Before the task loop, detect the repository root once:

```typescript
const { stdout: repoRootRaw } = await executeCommand(
  'git', ['rev-parse', '--show-toplevel'],
  { cwd: input.feature_dir, timeout: 10000 }
);
const rootDir = repoRootRaw.trim();
```

`input.feature_dir` points to the spec directory (e.g. `specs/358-.../`), so all git commands must use `rootDir` as `cwd` to stage/commit the actual implementation files.

### T002 — Commit after each successful task

Immediately after `markTaskComplete` + `writeFile` (success path, lines 278–280 of current `implement.ts`):

```typescript
// Track completed count for push throttling
let completedCount = 0;

// Inside the success branch:
completedCount++;
await executeCommand('git', ['add', '-A'], { cwd: rootDir, timeout: 30000 });
await executeCommand('git', ['commit', '-m', `feat: complete ${task.id}`], { cwd: rootDir, timeout: 30000 });

const isLastTask = completedTasks.length === pendingTasks.length;
if (completedCount % 3 === 0 || isLastTask) {
  await executeCommand('git', ['push'], { cwd: rootDir, timeout: 60000 })
    .catch((err: unknown) => {
      context.logger.warn(`Push after ${task.id} failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    });
}
```

Push every 3 completed tasks and unconditionally on the final task.

### T003 — Clean working tree after failed tasks

In both the `else` branch (non-zero exit) and the `catch` block:

```typescript
// After logging the failure:
await executeCommand('git', ['checkout', '--', '.'], { cwd: rootDir, timeout: 30000 }).catch(() => {});
await executeCommand('git', ['clean', '-fd'], { cwd: rootDir, timeout: 30000 }).catch(() => {});
```

This prevents partial file changes from Claude leaking into the next task.

### T004 — Update `hasPriorImplementation` in `phase-loop.ts`

At line 229–231 of `phase-loop.ts`, expand the fallback check:

```typescript
hasPriorImplementation = commits.some(
  (c) =>
    c.message.includes(`complete ${phase} phase`) ||
    c.message.includes('feat: complete T'),
);
```

The new incremental commit format (`feat: complete T001`) does not match the existing `complete implement phase` string, so the fallback would incorrectly fail without this change.

### T005 — Update `commit-implementation` step in `.generacy/speckit-feature.yaml`

Replace `--allow-empty` with a check-then-commit pattern to avoid noise commits when incremental commits have already captured all changes:

```yaml
- name: commit-implementation
  uses: shell
  command: 'git diff --cached --quiet && git diff --quiet || (git add -A && git commit -m "feat: implement ${{ steps.create-feature.output.branch_name }}")'
  continueOnError: true
```

### T006 — Update `commit-implementation` step in `workflows/speckit-feature.yaml`

`workflows/speckit-feature.yaml` has no `commit-implementation` step (the orchestrator's `prManager.commitPushAndEnsurePr` call handles commit/push for this workflow). No change needed to the workflow file itself; the `hasPriorImplementation` fix in `phase-loop.ts` (T004) handles the "no changes" guard correctly.

### T007 — Update `implement.md` constraint in `/workspaces/agency`

In **both** command files (`agency-plugin-spec-kit` and `claude-plugin-agency-spec-kit`), update the Constraints section:

**Old**:
```
- Commit after each logical group of tasks (if user requests)
```

**New**:
```
- **Always** commit after completing each task. Push after every 3 completed tasks and after the final task.
```

Remove all references to "parallel batch" commits from this constraint and from step 6 execution flow. Parallel execution is not yet implemented in `implement.ts`; the commit strategy for it will be designed when parallel execution lands.

## Execution Sequencing

| Task | Depends on | File | Workspace |
|------|-----------|------|-----------|
| T001 | — | `implement.ts` | generacy |
| T002 | T001 | `implement.ts` | generacy |
| T003 | T001 | `implement.ts` | generacy |
| T004 | — | `phase-loop.ts` | generacy |
| T005 | — | `.generacy/speckit-feature.yaml` | generacy |
| T006 | — | *(no-op — confirmed not needed)* | generacy |
| T007 | — | `implement.md` (×2) | agency |

T001 must precede T002 and T003 (they all edit the same function body). All others are independent.

## Key Decisions

1. **Repo root via `git rev-parse`** — `input.feature_dir` is always the spec dir, never the repo root. Using it as `cwd` for `git add -A` would only stage spec files.
2. **Push every 3 + always final** — Balances remote durability against network overhead. Push failures are non-fatal.
3. **Clean on failure** — Partial Claude output is unreliable; resetting to last committed state gives the next task a clean slate.
4. **Fallback pattern expansion** — Keeps `phase-loop.ts` forward-compatible with new incremental commit messages without reshaping those messages.
5. **Check-then-commit in YAML** — Avoids `--allow-empty` noise in git history while still acting as a safety net for any edge cases incremental commits missed.
6. **Sequential-only commits** — Parallel batch language removed from `implement.md`; when parallel execution is added, commit strategy will be co-designed.

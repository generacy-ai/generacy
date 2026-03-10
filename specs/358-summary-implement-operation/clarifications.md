# Clarifications for #358: Incremental Commits in Implement Operation

## Batch 1 — 2026-03-10

### Q1: cwd for Git Commands

**Context**: The spec proposes `cwd: process.cwd()` for the git commands in `implement.ts`, but the existing `executeCommand` calls in that file use `cwd: input.feature_dir` (the feature spec directory, e.g. `specs/358-summary-implement-operation/`). Git commands must run from the repository root, which may differ from `input.feature_dir`. Using the wrong `cwd` would cause `git add -A` to stage only files under the feature dir, not the implementation files modified by Claude.

**Question**: Should the git commands use `input.feature_dir` (consistent with other calls in the file), or should the repository root be detected separately (e.g., via `git rev-parse --show-toplevel`)? Or is `input.feature_dir` already guaranteed to be the repo root?

**Answer**: Detect the repo root via `git rev-parse --show-toplevel`. `input.feature_dir` is the spec directory (e.g., `specs/358-.../`), never the repo root. Running `git add -A` from there would only stage files under the spec directory, missing all actual implementation files. The git commands should resolve the repo root first:
```typescript
const { stdout: repoRoot } = await executeCommand('git', ['rev-parse', '--show-toplevel'], { cwd: input.feature_dir, timeout: 10000 });
const rootDir = repoRoot.trim();
// Use rootDir as cwd for all git add, commit, push, restore commands
```

---

### Q2: Phase-Loop Compatibility — `hasChanges` and Fallback Pattern Mismatch

**Context**: After the implement phase, `phase-loop.ts` calls `prManager.commitPushAndEnsurePr('implement')`. If `implement.ts` has already committed and pushed all changes incrementally, this call will find no new uncommitted changes and return `hasChanges: false`. The phase-loop then checks a fallback: it looks for prior commits whose message includes `complete implement phase` (line 230 of `phase-loop.ts`). The proposed new commit messages use `feat: complete ${task.id}` (e.g., `feat: complete T-001`), which do **not** match that pattern — so the fallback will also be false, and the phase will fail with "produced no file changes."

**Question**: Should the `hasPriorImplementation` fallback pattern in `phase-loop.ts` be updated to also match `feat: complete T-` prefixed messages? Or should the incremental commit messages use a format that matches the existing pattern (e.g., include `complete implement phase` in the message)?

**Answer**: Update the fallback pattern to match the new commit messages. The `hasPriorImplementation` check in `phase-loop.ts` should match both old and new patterns:
```typescript
hasPriorImplementation = commits.some(
  (c) => c.message.includes(`complete ${phase} phase`) || c.message.includes('feat: complete T')
);
```
Don't reshape the incremental commit messages — `feat: complete T001` is more useful in git history. The fallback check should adapt to the new reality.

---

### Q3: Coordination with Workflow YAML `commit-implementation` Step

**Context**: Both `.generacy/speckit-feature.yaml` and `workflows/speckit-feature.yaml` have an explicit `commit-implementation` step after `speckit.implement`:
```yaml
- name: commit-implementation
  uses: shell
  command: 'git add -A && git commit -m "feat: implement ..." --allow-empty'
```
If `implement.ts` now commits after every task, this YAML step will produce an empty commit (nothing left to commit). While `--allow-empty` prevents failure, it adds noise to the git history. Should the YAML commit step be removed, updated, or left as-is as a safety net?

**Question**: Should the scope of this feature include updating the `speckit-feature.yaml` workflow files to remove or modify the `commit-implementation` step, or is the YAML step intentionally kept as a final safety net even if it produces an empty commit?

**Answer**: Keep the YAML step as a safety net, but avoid empty commits. Replace `--allow-empty` with a check-then-commit pattern:
```yaml
- name: commit-implementation
  uses: shell
  command: 'git diff --cached --quiet && git diff --quiet || (git add -A && git commit -m "feat: implement ...")'
  continueOnError: true
```
This catches anything the incremental commits missed (edge cases, partial failures) without creating noise commits.

---

### Q4: Parallel Task Batch Behavior

**Context**: The spec says `implement.md` should be updated to "commit after each task or parallel batch." However, in the current `implement.ts` implementation, the `isParallel` flag on tasks is parsed but **unused** — all tasks execute sequentially in a for-loop. There is no actual parallel execution logic. The spec's "parallel batch" concept therefore has no implementation counterpart today.

**Question**: For the purposes of this feature, should "parallel batch" commits be treated as future-proofing (stub the concept but commit sequentially for now), or should the spec be simplified to only address sequential task commits (removing the parallel batch language from `implement.md`)?

**Answer**: Simplify to sequential-only for now. Remove the "parallel batch" language from `implement.md`. The current `implement.ts` doesn't do parallel execution — adding commit-after-batch semantics for a non-existent feature creates spec debt. When parallel execution is actually implemented, the commit strategy can be designed alongside it.

---

### Q5: Commit Behavior on Task Failure

**Context**: The spec's proposed code adds a commit after `markTaskComplete` + `writeFile`, which only runs on `result.exitCode === 0` (success path, lines 270–280 of `implement.ts`). Failed tasks (non-zero exit code or exceptions) skip `markTaskComplete` and therefore would not be committed. However, Claude may have partially modified files before failing — those partial changes would remain as uncommitted modifications, potentially interfering with subsequent tasks.

**Question**: Should a git commit (or at minimum a `git stash` or `git restore .`) also occur after a **failed** task to clean up partial modifications before the next task begins? Or is leaving partial changes in the working tree acceptable (and expected by the next task's Claude invocation)?

**Answer**: Clean the working tree after a failed task. Run `git checkout -- . && git clean -fd` from the repo root after a failed task to reset to a clean state. Partial modifications from a failed Claude session are unreliable and should not leak into subsequent tasks. Sequence: task fails → log error → clean working tree → proceed to next task. Do not commit partial changes from failed tasks.

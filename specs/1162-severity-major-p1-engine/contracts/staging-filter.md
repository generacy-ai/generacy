# Contract: Phase-completion staging filter (FR-001, FR-002)

**Site**: `PrManager.commitAndPush` (`packages/orchestrator/src/worker/pr-manager.ts`).

## Before

```
const status = await this.github.getStatus();
if (status.has_changes) {
  await this.github.stageAll();          // git add -A — stages sidecars too
  const commitResult = await this.github.commit(message);
}
```

## After

```
const status = await this.github.getStatus();
const toStage = [...status.unstaged, ...status.untracked].filter((p) => !isEngineSidecar(p));
if (toStage.length > 0) {
  await this.github.stageFiles(toStage); // git add <product paths only>
  const commitResult = await this.github.commit(message);
  committed = true;
}
```

## Guarantees

- **G1 (FR-001)**: No path under `ENGINE_SIDECAR_PREFIXES`
  (`.generacy/review-findings-`, `.generacy/review-candidate-`, `.generacy/pause-context-`)
  is ever staged or committed by this path.
- **G2 (FR-002)**: Every genuine product change in the working tree (modifications,
  additions, deletions) is still staged and committed. Deletions reported in
  `status.unstaged` are staged by `git add <path>`.
- **G3**: A phase whose only working-tree change is a sidecar produces **no commit**
  (`toStage` empty ⇒ skip). No empty commits.
- **G4**: `.generacy/config.yaml` and `.generacy/epics/*` are NOT sidecars — they stage
  and commit normally (Q3).
- **G5**: The downstream unpushed-commit detection + push guard (`pr-manager.ts:148-161`,
  #1051) is unchanged.

## Test assertions

- SC-001: after a review→remediate→review loop, no `.generacy/review-findings-*`,
  `review-candidate-*`, or `pause-context-*` path appears in the staged/committed set.
- SC-004: a phase's genuine product edits are still staged and committed after the change.
- Sidecar-only phase ⇒ `stageFiles` called with `[]` (or not called) and no commit created.
- `.generacy/config.yaml` modification ⇒ staged and committed.

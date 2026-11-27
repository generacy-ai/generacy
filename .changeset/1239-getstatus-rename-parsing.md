---
"@generacy-ai/workflow-engine": patch
"@generacy-ai/orchestrator": patch
---

Fix getStatus rename/copy parsing and surface staging/commit failures (#1239).

`@generacy-ai/workflow-engine`: `GhCliGitHubClient.getStatus()` now runs
`git status --porcelain -z --untracked-files=all` and walks the NUL-terminated
token stream instead of splitting on newlines. A rename/copy entry (`R`/`C` in
either status column) emits its destination path in the header token and its
source path as the following token; the parser consumes both and pushes the
real paths into `staged`/`unstaged`, never the `old -> new` arrow artifact that
the line-split format produced (which was being staged literally, silently
dropping renamed files from the commit). `has_changes` now counts porcelain
entries, not raw tokens. `--untracked-files=all` is preserved (#1162).
`stageFiles` now tolerates an already-staged rename/copy source (whose working
tree no longer holds the file, so a batch `git add` aborts with "pathspec did
not match any files") by falling back to per-file staging and skipping only the
unmatched, already-staged paths — the scoped commit pathspec still records them.
Genuine deletions are unaffected (`git add` stages the removal and exits 0).

`@generacy-ai/orchestrator`: `PrManager.commitAndPush` wraps only the
getStatus → filter → stageFiles → commit span in an inner try/catch that returns
a new `commit-error` outcome; `commitPushAndEnsurePr` short-circuits it before
`ensureDraftPr` into `CommitResult.commitError`. `phase-loop` checks
`commitError` alongside `pushRefused` at every commit site and aborts the phase
(`completed: false`, no advancement) so a staging/commit throw can no longer be
swallowed as a benign `no-changes` that silently loses phase work. Throws from
the later revert/push path still collapse to the non-fatal `no-changes`.

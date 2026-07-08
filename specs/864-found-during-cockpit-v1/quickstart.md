# Quickstart: #864

## What this feature does

Before every `implement`, `pre-validate`, and `validate` phase runs, the worker merges `origin/<base>` into the feature branch's working tree. Clean merge → phase runs against the post-merge tree (the same guarantee CI gets from `refs/pull/N/merge`). Conflicting merge → phase pauses with `waiting-for:merge-conflicts` and the stage-comment evidence block enumerates the conflicted paths.

## What changes for operators

### `cockpit status` on a paused workflow

New pause state visible when the pre-phase base-merge conflicts:

```
issue #123 (owner/repo)
  state: paused (waiting-for:merge-conflicts)
  since: 2026-07-08T14:31:22Z
```

The stage comment on the issue includes:

```
**Merge conflict during base-sync**
**Base**: origin/main

<details><summary>Conflicted paths (3)</summary>

- CLAUDE.md
- package.json
- package-lock.json

</details>
```

### Resuming after resolving

1. Locally: `git fetch origin && git checkout <feature-branch> && git merge origin/main`.
2. Resolve conflicts, commit, push.
3. On the GitHub issue: add label `completed:merge-conflicts`. This is the standard resume mechanism — no #864-specific action required.

The label-monitor service enqueues a resume job. On the next phase entry, the pre-phase base-merge runs again; if your resolution stuck, it succeeds silently and the phase proceeds.

### `cockpit queue <ref> implement`

When the target issue's plan.md declares a dependency on another issue that is not yet merged, the preview shows a warning line:

```
$ cockpit queue owner/repo#3 implement
cockpit queue: epic ... / phase 'implement' → 1 eligible, 0 skipped in owner/repo
  owner/repo#3  Add persistence layer (process:speckit-feature, assignee: someone)
    [WARN: depends-on owner/repo#2 not yet merged]
Proceed? (y/N)
```

Warning-only in v1 — you can still proceed by confirming.

## What changes for workers (nothing operator-visible)

- Every phase entry starts with `git reset --hard origin/<branch>` + fresh fetch. This is idempotent; if a worker was killed mid-merge, the next entry starts from a known state.
- Implement-phase base-merges are pushed as ordinary commits ahead of implement's own commits. The squash-merge at PR close collapses them out.
- Pre-validate and validate base-merges are workspace-local and never pushed.

## Local testing

Not applicable — this feature lives in the worker's phase loop, which only runs inside an orchestrator container against a real GitHub repo. Unit and integration tests use mocked `execFile` / GitHub client fakes and can be run with:

```
cd packages/orchestrator
pnpm test -- base-merge
pnpm test -- phase-loop.merge
```

For the cockpit-queue change:

```
cd packages/generacy
pnpm test -- plan-dependency-extractor
pnpm test -- queue
```

## Troubleshooting

**Pause fires on every phase re-entry despite my resolution being pushed.**
Check that your resolution actually merges `origin/<base>` (not just adjacent commits from base). Run `git log --oneline origin/<base>..HEAD` locally — you should see the merge commit and no unmerged base commits. If the base moved after your resolution, the next base-merge will encounter the new delta.

**`cockpit queue` warns on an already-merged dependency.**
The warning is heuristic — the extractor may have mis-parsed a mention. Check the plan.md wording; if the trigger verb isn't one of `must be merged`, `depends on`, `depends-on`, `requires`, `extends`, `blocked by`, `prerequisite`, extend the extractor's `TRIGGER_VERBS` list.

**Ephemeral merge state carries into the next phase.**
Cannot happen — the reset-at-start (`git reset --hard origin/<branch>`) is the first thing every phase does. If you're seeing this, file a bug: it means either the reset didn't run or the branch tip pointer is wrong.

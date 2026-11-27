# Quickstart: getStatus rename/copy parsing fix (#1239)

## Setup

```bash
pnpm install
pnpm --filter @generacy-ai/workflow-engine build   # orchestrator imports dist/
```

## Reproduce the bug (pre-fix)

```sh
git init -q /tmp/t1239 && cd /tmp/t1239
echo a > old.ts && git add . && git commit -qm init
git mv old.ts new.ts && echo x >> new.ts
git status --porcelain --untracked-files=all   # RM old.ts -> new.ts
git add "old.ts -> new.ts"                     # fatal: pathspec … did not match (exit 128)
```

Post-fix equivalent — `getStatus()` parses `git status --porcelain -z` and returns
`staged: ['old.ts', 'new.ts']`, `unstaged: ['new.ts']`; staging/commit succeed.

## Run the relevant tests

```bash
# Parser unit tests (SC-002) + rename integration test (SC-001)
pnpm --filter @generacy-ai/workflow-engine test -- gh-cli.get-status
pnpm --filter @generacy-ai/workflow-engine test -- gh-cli.rename-status

# Full regression (SC-003)
pnpm --filter @generacy-ai/workflow-engine test

# Orchestrator: commit-error outcome + phase-loop abort (FR-005)
pnpm --filter @generacy-ai/workflow-engine build
pnpm --filter @generacy-ai/orchestrator test -- pr-manager
pnpm --filter @generacy-ai/orchestrator test -- phase-loop
```

## What changed, where

| Concern | File |
|---------|------|
| `-z` tokenizer, rename/copy source+dest | `packages/workflow-engine/src/actions/github/client/gh-cli.ts` (`getStatus`) |
| `commit-error` outcome, narrow try/catch | `packages/orchestrator/src/worker/pr-manager.ts` |
| `CommitResult.commitError` | `packages/orchestrator/src/worker/types.ts` |
| Abort-on-commit-error (beside each `pushRefused` check) | `packages/orchestrator/src/worker/phase-loop.ts` |
| Changeset (patch × 2 packages) | `.changeset/1239-getstatus-rename-parsing.md` |

## Troubleshooting

- **"no exported member" / "not a function" in orchestrator tests** — stale
  workflow-engine `dist/`; rerun `pnpm --filter @generacy-ai/workflow-engine build`.
- **Mocked status tests failing after the change** — fixtures must be NUL-separated
  (`'RM new.ts\0old.ts\0 M other.ts\0'`), not newline-joined, and the expected git
  argv now includes `-z`.
- **CI changeset gate red** — the changeset must be a *newly added* file listing both
  `@generacy-ai/workflow-engine` and `@generacy-ai/orchestrator` at `patch`.
- **A phase fails with the new commit-error reason** — that is the intended FR-005
  behavior replacing the old silent `no-changes`; check the worker log line emitted at
  the phase-loop abort site for the underlying git stderr.

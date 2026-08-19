# Quickstart: phase-start-ref key migration + unresolvable-ref handling (#1112)

## What this changes

Two false-failure paths are removed from the #1107 implement-phase product-diff
guard, both in the phase-start-ref capture block at
`packages/orchestrator/src/worker/phase-loop.ts:363-394`:

1. A Redis ref written by the pre-#1110 build (unbranched key) is now read,
   migrated to the branched key, and consumed once — instead of being orphaned
   for 7 days while the new build re-captures a HEAD past the phase's own commits.
2. A persisted ref that does not resolve in the current checkout (e.g. an
   unpushed base-merge commit after re-entry on a fresh clone) is re-captured
   instead of throwing `fatal: bad revision` and escalating.

No change to the diff-window semantics, exclusion lists, escalation surface, or
TTL/namespace. Healthy runs behave exactly as today.

## Files to edit

| File | Change |
|------|--------|
| `packages/workflow-engine/src/actions/github/client/interface.ts` | Add `commitExistsInCheckout(sha): Promise<boolean>` to `GitHubClient`. |
| `packages/workflow-engine/src/actions/github/client/gh-cli.ts` | Implement it via `git rev-parse --verify --quiet <sha>^{commit}` (exit 0→true, 1→false, else throw). |
| `packages/orchestrator/src/worker/phase-loop.ts` | Rewrite the capture block: legacy read-through + migrate + consume-once + resolve-check. |
| `.changeset/1112-phase-start-ref-migration.md` | New changeset (workflow-engine minor, orchestrator patch). |

## Build & test

```bash
pnpm install

# Type-check + build the two touched packages
pnpm --filter @generacy-ai/workflow-engine build
pnpm --filter @generacy-ai/orchestrator build

# New + existing tests
pnpm --filter @generacy-ai/workflow-engine test gh-cli.commit-exists
pnpm --filter @generacy-ai/orchestrator test phase-loop.product-diff
pnpm --filter @generacy-ai/orchestrator test product-diff

# Full package test to confirm no #1107 regression
pnpm --filter @generacy-ai/orchestrator test
```

## Manual verification of the git probe (git ≥2.30, confirmed on 2.52.0)

```bash
cd /path/to/a/checkout

# present commit → exit 0
git rev-parse --verify --quiet "$(git rev-parse HEAD)^{commit}"; echo $?   # 0

# missing commit (full or abbreviated) → exit 1
git rev-parse --verify --quiet "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef^{commit}"; echo $?  # 1
git rev-parse --verify --quiet "deadbee^{commit}"; echo $?                 # 1

# environment fault (not a repo) → exit 128
( cd /tmp && git rev-parse --verify --quiet "deadbeef^{commit}" ); echo $? # 128
```

## Changeset

```markdown
---
"@generacy-ai/workflow-engine": minor
"@generacy-ai/orchestrator": patch
---

Remove two false-failure paths from the #1107 implement-phase product-diff guard (#1112).

`@generacy-ai/workflow-engine` gains a local-git `GitHubClient.commitExistsInCheckout(sha)` method (`git rev-parse --verify --quiet <sha>^{commit}`) that reports whether a commit exists in the checkout — true on exit 0, false on exit 1 (commit-missing), throwing on any other exit so an environment fault is not mistaken for a missing commit.

`@generacy-ai/orchestrator`'s phase-start-ref capture block now (a) on a branch-scoped-key miss reads through once to the pre-#1110 legacy key, migrates a valid value to the branch-scoped key, and clears the legacy key on any read (consume-once), and (b) verifies any reused ref resolves in the current checkout before diffing — re-capturing fresh HEAD when it does not, instead of throwing and escalating. Healthy runs, the diff-window semantics, and the detection-failure path are unchanged.
```

## Troubleshooting

- **Existing phase-loop tests fail with "commitExistsInCheckout is not a function"**: any test stub that reaches the capture block with an injected `phaseTracker` returning a ref must add `commitExistsInCheckout: vi.fn().mockResolvedValue(true)` to its `context.github` stub. Stubs without `phaseTracker` are unaffected.
- **A 128 fault silently re-captures**: the impl must `throw` on non-0/1 exits, not `return false`. Verify the exit-code branch order.
- **Redis down**: `getValueRaw`/`setValueRaw`/`clearRaw` degrade to null/no-op (#1107); the guard falls back to fresh capture — same as today.

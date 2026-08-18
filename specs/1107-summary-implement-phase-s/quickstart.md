# Quickstart: Implement-phase product-diff guard (#1107)

## What changes for operators

Nothing in day-to-day operation. The implement-phase safety net now actually fires:

- An implement phase that produces **only** `specs/` and/or root agent-context files
  (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`) — or nothing
  at all — now **fails** with the existing `no-product-code-changes` surface instead of
  silently advancing to `waiting-for:implementation-review`.
- Earlier-phase edits and base merges can no longer satisfy the guard on behalf of a
  later phase that wrote nothing.

If a genuine implement phase's only deliverable is a root agent-context file (rare — that
is normally docs work), it will false-fail. Resolve it via review or manual advance
(`/cockpit:resume` or label surgery). This is intentional fail-closed behavior (Q1 → A).

## Developer notes

### Files
- `packages/orchestrator/src/worker/product-diff.ts` — `EXCLUDED_EXACT_PATHS`,
  `isProductFile(..., exactPaths?)`, `computePhaseScopedProductDiff`.
- `packages/orchestrator/src/worker/phase-loop.ts` — capture/persist/reuse start ref;
  guard uses the phase-scoped diff; FR-004 diagnostics; clear ref on success.
- `packages/orchestrator/src/worker/types.ts` — `PhaseLoopDeps.phaseTracker?`.
- `packages/orchestrator/src/worker/claude-cli-worker.ts` — pass `this.phaseTracker`.
- `packages/orchestrator/src/services/phase-tracker-service.ts` — `getValueRaw` / `setValueRaw`.
- `packages/orchestrator/src/server.ts` — thread `workerPhaseTracker` into `PhaseLoopDeps`.
- `packages/workflow-engine/src/actions/github/client/{interface,gh-cli}.ts` —
  `getCurrentCommitSha`, `getFilesChangedByOwnCommits`.

### The phase-scoped diff, by hand
```bash
# start ref captured on first implement entry (after base merge), persisted in Redis:
#   phase-start-ref:<owner>:<repo>:<issue>:implement
git rev-parse HEAD            # → startRef

# files the phase's OWN commits touched (excludes merges + merged-in develop commits):
git log --first-parent --no-merges --name-only --pretty=format: <startRef>..HEAD | sort -u
```

### Tests
```bash
pnpm --filter @generacy-ai/orchestrator test src/worker/__tests__/product-diff.test.ts
pnpm --filter @generacy-ai/orchestrator test src/worker/__tests__/phase-loop.product-diff.test.ts
pnpm --filter @generacy-ai/orchestrator test src/services/__tests__/phase-tracker-service.test.ts
```

Target scenarios: SC-001 (earlier-phase `CLAUDE.md` + implement writes only
`specs/.../conversation-log.jsonl` ⇒ fail), SC-002 (own diff = `CLAUDE.md` only ⇒ fail),
SC-003 (≥1 real product file ⇒ pass), SC-004 (empty own-diff fails even when
`baseRef...HEAD` has product files), SC-005 (detection failure still raises
`product-diff-error`).

### Changeset
```bash
# hand-write .changeset/1107-implement-product-diff-guard.md
# @generacy-ai/workflow-engine: minor  (new public client methods)
# @generacy-ai/orchestrator:    patch  (internal bugfix, no new exports)
```

## Troubleshooting

- **Phase unexpectedly passes on empty work** → confirm the start ref was captured
  *after* the base merge and that the guard uses `computePhaseScopedProductDiff`
  (not `computeProductDiff`). Check the `startRef` in the phase-loop logs.
- **Healthy phase false-fails on resume** → confirm the persisted start ref is being
  reused (not overwritten) on re-entry; check the `phase-start-ref:*` key in Redis and
  that `first-parent` is included so the increment-1 commit is on the mainline.
- **`product-diff-error` on every run** → the persisted ref may be unreachable
  (destructive reset in a conflict remedy); clear the `phase-start-ref:*` key to
  re-capture, and investigate the reset.

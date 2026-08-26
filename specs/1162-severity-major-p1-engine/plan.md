# Implementation Plan: Keep engine bookkeeping sidecars out of PR branches

**Feature**: Stop committing `.generacy/` engine sidecars into PR branches; persist the remediation counter to Redis so it survives re-clone.
**Branch**: `1162-severity-major-p1-engine`
**Status**: Complete

## Summary

The phase-completion commit path stages the working tree with an unscoped `git add -A`
(`PrManager.commitAndPush` → `GhCliGitHubClient.stageAll`). That indiscriminately
commits the review/remediate/pause sidecars the engine writes into the checkout —
`.generacy/review-findings-<id>.json`, `.generacy/review-candidate-<id>.json`,
`.generacy/pause-context-<id>.json` — into the product PR diff. The committed findings
sidecar carries #1129-synthesized findings whose `detail` embeds raw validate stderr
tails, and the next review round then reviews the engine's own bookkeeping as product.

The fix has three moving parts, all orchestrator-internal:

1. **Targeted staging (FR-001/Q2).** Replace `stageAll()` on the commit path with a
   filtered `stageFiles(productPaths)` that stages every genuine working-tree change
   *except* the three sidecar patterns. Never blanket-ignore `.generacy/` — its
   `config.yaml` and `epics/*` are legitimately tracked (Q3).
2. **Product-diff exclusion (FR-004/Q5).** Add the three sidecar prefixes to
   `EXCLUDED_PATH_PREFIXES` so the review-round diff ignores them regardless of commit
   history — this also neutralizes any pre-existing committed sidecars at runtime.
3. **Redis-backed remediation counter (FR-003/Q1).** Committing the sidecar is currently
   the *only* thing that makes `remediationCount` survive a worker re-clone. Once the
   sidecar stops being committed, mirror the counter to Redis via the existing
   `PhaseTracker` (keyed by workflow id + branch, 7-day TTL, best-effort/no-op when Redis
   is down), and reconcile the on-disk sidecar from Redis on re-entry so the existing
   synchronous gate reader keeps working unchanged.

Pre-existing committed sidecars on already-shipped branches get a documented one-time
manual cleanup script — no automated engine `git rm` (FR-005/Q4). The FR-004 exclusion
already hides them from the next review round.

## Technical Context

- **Language / runtime**: TypeScript, Node ≥ 22, ESM.
- **Packages touched**:
  - `@generacy-ai/orchestrator` (`packages/orchestrator/src/worker/`) — the commit path,
    product-diff constants, phase-loop counter mirror/reconcile, sidecar helper.
- **Key existing seams (verified on this branch, not spec line refs)**:
  - `PrManager.commitAndPush` — `pr-manager.ts:125`; the `stageAll()` call is `:136`.
  - `GhCliGitHubClient.stageFiles(files: string[])` and `.stageAll()` —
    `gh-cli.ts` (`git add ...files` vs `git add -A`); `getStatus()` returns
    `{ staged[], unstaged[], untracked[], has_changes }`.
  - `EXCLUDED_PATH_PREFIXES` / `isProductFile` — `product-diff.ts:12,47`
    (`startsWith` prefix match).
  - `PhaseTracker` — `getValueRaw` / `setValueRaw(key, value, ttlSeconds)` / `clearRaw`
    (`types/monitor.ts`); best-effort no-op when Redis is unavailable.
  - Reference persistence pattern — `runReviewConvergence` in `phase-loop.ts:1977`
    persists a findings artifact via `deps.phaseTracker?.setValueRaw` under
    `review-findings:${owner}:${repo}:${issueNumber}:${branch}` with
    `PHASE_START_REF_TTL_SECONDS` (`phase-loop.ts:1985,2036`). **This is the FR-003
    template.**
  - Counter helpers — `bumpRemediationCount` / `resetRemediationCount` (disk read →
    mutate → atomic temp+rename) at `review-artifact.ts:127,148`; the gate reads
    `readReviewArtifactSync` at `phase-loop.ts:1429`; reset fires at `:1547`.
  - Sidecar workflow id shape — `${owner}/${repo}#${issueNumber}` (no branch);
    sanitized `[^a-zA-Z0-9_-] → _`; path `<checkoutPath>/.generacy/review-findings-<id>.json`.

## Project Structure

```
packages/orchestrator/src/worker/
  product-diff.ts        # + ENGINE_SIDECAR_PREFIXES, isEngineSidecar(); extend EXCLUDED_PATH_PREFIXES (FR-004)
  pr-manager.ts          # commitAndPush: stageAll() -> filtered stageFiles() (FR-001)
  review-artifact.ts     # + seedRemediationCount() helper for re-entry reconcile (FR-003)
  phase-loop.ts          # mirror counter to Redis after remediate; reconcile before gate; clear on reset (FR-003)
  __tests__/
    product-diff.test.ts             # sidecar prefixes excluded; config.yaml/epics still product (SC-002)
    pr-manager.staging-filter.test.ts # sidecars never staged; product changes still staged (SC-001, SC-004)
    phase-loop.remediation-persist.test.ts # counter survives simulated re-clone; cap still fires (SC-003)

specs/1162-severity-major-p1-engine/
  spec.md                # (read-only)
  clarifications.md      # (read-only)
  plan.md research.md data-model.md quickstart.md
  contracts/
    staging-filter.md
    remediation-count-key.md
  scripts/
    cleanup-committed-sidecars.sh   # one-time manual cleanup (FR-005)

.changeset/
  1162-engine-sidecar-staging.md    # @generacy-ai/orchestrator patch
```

## Constitution Check

No `.specify/memory/constitution.md` exists in the repo → constitution check skipped.

## Changeset

`.changeset/1162-engine-sidecar-staging.md` — `@generacy-ai/orchestrator` **patch**
(`workflow:speckit-bugfix`; internal commit-path + product-diff + phase-loop fix, no new
public exports). The three touched files are all under
`packages/orchestrator/src/` and non-test, so the changeset gate applies. Single file.

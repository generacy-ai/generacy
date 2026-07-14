# Implementation Plan: Fresh wizard clusters never clone their primary repo (premature `bootstrap-complete` replay)

**Feature**: Gate `PostActivationRetryService` and control-plane `bootstrap-complete` on a sealed `GH_TOKEN` so the one-shot post-activation clone never fires token-less on fresh wizard clusters.
**Branch**: `937-found-while-investigating`
**Status**: Complete

## Summary

Since `ff9da3a8` (#838) made the `runPostActivationBranch()` dispatch reachable on wizard clusters, every fresh interactive wizard activation now hits the `activated && !postActivationComplete` state before the user has entered their GitHub credentials, `needsRetry` trips true, and the orchestrator replays `bootstrap-complete` to the control-plane. The control-plane's `bootstrap-complete` handler writes the post-activation sentinel unconditionally (in contrast to the sibling `prepare-workspace` handler, which already gates on `hasGitHubToken`). The one-shot `post-activation-watcher.sh` fires with no `GH_TOKEN`, refuses the clone, exits, and is never re-armed — when the real credentials seal ~2 min later, nothing consumes them. `/workspaces/<repo>` stays empty and the cluster is unusable.

This plan implements the two-pronged fix pinned in the clarifications:

1. **FR-001 (orchestrator)** — `PostActivationRetryService.checkPostActivationState()` gates `needsRetry` on the presence of a non-empty `GH_TOKEN` in `wizard-credentials.env`. On the fresh-wizard defer path, emit one `logger.info` line and one `cluster.bootstrap` relay event with `{ status: 'deferred', reason: 'github-token-not-sealed' }` (FR-002).
2. **FR-006 (control-plane)** — `handlePostLifecycle`'s `bootstrap-complete` branch mirrors the existing `prepare-workspace` gated-sentinel pattern: skip the sentinel write and emit an `awaiting-credentials` `cluster.bootstrap` event when `hasGitHubToken === false`, otherwise write the sentinel unchanged.

Both changes ship in a single PR (Q2→A). The retry service stays one-shot at activation; retry-on-defer relies on the existing wizard credential-seal flow driving `bootstrap-complete` end-to-end (Assumption §2).

## Technical Context

- **Runtime**: Node.js ≥22, TypeScript, ESM.
- **Packages touched**:
  - `packages/orchestrator/src/services/post-activation-retry.ts` (production code)
  - `packages/orchestrator/src/__tests__/post-activation-retry.test.ts` (unit)
  - `packages/orchestrator/src/__tests__/post-activation-dispatch.test.ts` (dispatch-level regression for RT-003)
  - `packages/control-plane/src/routes/lifecycle.ts` (production code)
  - `packages/control-plane/__tests__/routes/lifecycle.test.ts` (RT-004 mirror of prepare-workspace tests)
- **Dependencies**: no new deps. Uses `node:fs` (`existsSync`, `readFileSync`), existing `writeWizardEnvFile()` on the control-plane side, and the already-injected `sendRelayEvent` / `getRelayPushEvent` seams.
- **Relay channel**: `cluster.bootstrap` (already routed IPC control-plane → orchestrator per #594/#598/#600).
- **Test seam pattern**: constructor options (`completionFlagPath`, `keyFilePath`, `controlPlaneSocket`) are already the pattern in `PostActivationRetryService`; the new `wizardCredsPath` option follows suit (FR-003).

## Project Structure

```
packages/orchestrator/src/services/
  post-activation-retry.ts       # MODIFIED — new wizardCredsPath option, gated needsRetry, defer event
  post-activation-dispatch.ts    # UNCHANGED — its needsRetry branch now naturally skips when creds missing
packages/orchestrator/src/__tests__/
  post-activation-retry.test.ts  # MODIFIED — extend checkPostActivationState suite with RT-001/RT-002
  post-activation-dispatch.test.ts # MODIFIED — RT-003 (no lifecycle call on defer)

packages/control-plane/src/routes/
  lifecycle.ts                   # MODIFIED — gate bootstrap-complete sentinel on hasGitHubToken
packages/control-plane/__tests__/routes/
  lifecycle.test.ts              # MODIFIED — RT-004 (mirror of prepare-workspace token-deferred tests)

specs/937-found-while-investigating/
  plan.md                        # THIS FILE
  research.md
  data-model.md
  contracts/
    post-activation-state.md
    cluster-bootstrap-deferred-event.md
    bootstrap-complete-lifecycle.md
  quickstart.md
```

## Design Decisions

### D1. Presence-only `GH_TOKEN` predicate

Per Q1→A: the check is `entries.get('GH_TOKEN')?.trim().length > 0`. Matches `writeWizardEnvFile`'s own "usable token" predicate. No length or shape check — GitHub token formats vary (`ghp_`, `ghs_`, `github_pat_…`), and the writer never emits placeholder values, so there is nothing to reject beyond empty/missing.

### D2. `wizardCredsPath` sourcing

Per Q4→C: constructor option that itself defaults to `process.env.WIZARD_CREDS_PATH ?? '/var/lib/generacy/wizard-credentials.env'`. This preserves the sibling `completionFlagPath` / `keyFilePath` test-seam pattern **and** honors the same env-var override the control-plane already uses when writing the file (`lifecycle.ts:171`). Hard-coding the default would silently defeat the gate on relocated creds.

### D3. Env-file parser

Per Q5→B: line-oriented `KEY=VALUE` split (split on the first `=`, trim the value). No quoting, comments, or escape handling — matches the writer's `formatEnvFile()` output exactly. Missing file, missing key, and empty trimmed value all yield "not sealed" (FR-004).

- Read the file **synchronously** with `readFileSync(path, 'utf8')` inside `checkPostActivationState()` — the method is synchronous today and swapping to async would ripple into `runPostActivationBranch` and both `server.ts` call sites. File is small (<1 KB) and read once per boot; sync is fine here.
- Wrap the read in a `try { … } catch { return notSealed; }` — the guard must never throw.

### D4. Defer observability shape

Per Q3→B:

- Log: `logger.info({ wizardCredsPath }, 'Post-activation retry deferred — GH_TOKEN not sealed in wizard-credentials.env')`. Structured `wizardCredsPath` field so operators tracing a relocated-creds cluster see the actual path inspected.
- Relay event: `sendRelayEvent('cluster.bootstrap', { status: 'deferred', reason: 'github-token-not-sealed' })`. **Distinct** from `prepare-workspace`'s `{ status: 'awaiting-credentials', reason: 'github-token-not-sealed' }` per FR-002 note: matching `reason` but different `status` so both defer paths use the same operator-facing reason string while the two entry points remain distinguishable in the cloud UI's channel log.

### D5. `needsRetry` state exposed unchanged

`PostActivationState` shape (`{ activated, postActivationComplete, needsRetry }`) does not gain new fields. The defer decision collapses into `needsRetry = false`. Consumers (`runPostActivationBranch`) already treat `!needsRetry && !postActivationComplete` as a no-op; that path becomes the deferred-fresh-cluster path automatically. No dispatcher change needed — RT-003 (no lifecycle call on defer) is a natural consequence of D5.

### D6. Emit-only-once-per-boot semantics for the defer event

The retry service is one-shot at activation (`runPostActivationBranch` fires once from `server.ts`). `checkPostActivationState()` is called exactly once per boot in the `runPostActivationBranch` path, so the defer log + event emit at most once per activation lifecycle. No dedupe key needed.

- Corollary: on a container restart with creds still unsealed, we WILL re-emit the defer event. That is the correct behavior — operators watching the cloud stream see one `deferred` event per boot until the wizard finishes.

### D7. FR-006 mirrors `prepare-workspace` structure exactly

The `bootstrap-complete` handler already calls `writeWizardEnvFile()` and receives `hasGitHubToken` in its result. The change is purely additive:

```ts
if (hasGitHubToken) {
  await writeFile(sentinel, '', { flag: 'w' });
  // existing code-server.start() + tunnelManager.start() calls
} else {
  getRelayPushEvent()?.('cluster.bootstrap', {
    status: 'awaiting-credentials',
    reason: 'github-token-not-sealed',
  });
  // skip sentinel + code-server + tunnel (nothing to do until creds land)
}
res.writeHead(200);
res.end(JSON.stringify({
  accepted: true,
  action: parsed.data,
  sentinel: hasGitHubToken ? sentinel : null,
}));
```

Response body follows `prepare-workspace`'s `sentinel: null` idiom on the defer branch so downstream callers can distinguish the two outcomes without a shape change.

**Non-regression note**: skipping code-server + tunnel start on the defer path is deliberate. Their start is idempotent and gets re-driven by the second (credential-bearing) `bootstrap-complete` call at the end of the wizard; the current premature-replay path only hurts because it fires the *clone*, not because it starts code-server. Skipping both on the token-less defer keeps the "defer" state minimal.

### D8. Ship both fixes in a single PR

Per Q2→A: single PR touching both packages. `bootstrap-complete` is the terminal step, so FR-006 must still fire the sentinel whenever a token IS present. Regresses nothing — a `REPO_URL`-configured cluster with no token already fails the post-activation guard today (Assumption §4).

## Constitution Check

No `.specify/memory/constitution.md` present in this repo — check skipped. General coding conventions observed (TypeScript strict mode, no new deps, existing test seam patterns preserved).

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Relocated `wizard-credentials.env` via `WIZARD_CREDS_PATH` silently defeats the gate | D2: constructor option default reads the same env var the control-plane writer honors |
| Async-vs-sync divergence if `checkPostActivationState` becomes async | D3: keep sync `readFileSync`; file is <1KB, read once at boot |
| Restart-recovery cluster (creds sealed, sentinel missing) accidentally deferred | Explicit RT-002 test asserts `needsRetry === true` when `GH_TOKEN` present; the fresh-cluster fix must NOT regress restart-recovery |
| Cloud UI unaware of new `deferred` status | D4 keeps the `reason` string identical to `prepare-workspace`'s existing defer event; only the `status` value differs, which the cloud already treats as opaque per Out-of-Scope §4 |
| FR-006 skip-code-server-and-tunnel breaks users who were relying on the premature start | The premature `bootstrap-complete` currently starts code-server before the user finishes the wizard — this is silent no-op behavior since the wizard runs the second `bootstrap-complete` at completion which idempotently re-starts both. No known user-visible regression. |

## Regression Test Coverage Matrix

| RT ID | Test file | Scenario | Expected |
|-------|-----------|----------|----------|
| RT-001 | `post-activation-retry.test.ts` | `activated && !complete`, no `GH_TOKEN` in creds file | `needsRetry === false`, log emitted, defer event emitted |
| RT-002 | `post-activation-retry.test.ts` | `activated && !complete`, sealed `GH_TOKEN` present | `needsRetry === true`, no defer event |
| RT-003 | `post-activation-dispatch.test.ts` | Fresh-activation, no creds | `runPostActivationBranch` returns `'noop'`, does NOT call `triggerPostActivationRetry` |
| RT-004 | `lifecycle.test.ts` | `bootstrap-complete` with no `hasGitHubToken` | Sentinel NOT written; `sentinel: null` in response; `awaiting-credentials` event emitted |
| RT-005 | Manual smoke (documented in `quickstart.md`) | Deferred activation → wizard seal → single clone + single sentinel write | Documented E2E steps; automated coverage is RT-001..RT-004 in combination |

## Rollout

- Single PR spanning `packages/orchestrator` and `packages/control-plane`.
- No feature flag: both changes are defer-not-remove-behavior — token-present paths behave identically to today.
- Smoke: `snappoll-3`-style local wizard-provisioned cluster; assert `/workspaces/<repo>/.git` present and `post-activation-complete` flag written within 30 s of wizard completion (SC-001).
- Post-deploy grep: `replaying bootstrap-complete lifecycle action` MUST NOT appear before `wizard-complete`; the FR-002 defer log line MUST appear (SC-002).

## Next Steps

- `/speckit:tasks` — generate the task list from this plan.
- Implementation targets `packages/orchestrator/src/services/post-activation-retry.ts` (FR-001..FR-005) and `packages/control-plane/src/routes/lifecycle.ts` (FR-006) with matching test file updates.

---

*Generated by speckit*

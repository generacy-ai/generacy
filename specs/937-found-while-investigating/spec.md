# Feature Specification: Found while investigating a fresh local cluster deploy (`snappoll-3`, `cluster-base:preview`) that never cloned its repo — the orchestrator, both workers, and `/workspaces/snappoll-3` were left empty with no `

**Branch**: `937-found-while-investigating` | **Date**: 2026-07-14 | **Status**: Draft

## Summary

Found while investigating a fresh local cluster deploy (`snappoll-3`, `cluster-base:preview`) that never cloned its repo — the orchestrator, both workers, and `/workspaces/snappoll-3` were left empty with no `.git`. The operator reports the same symptom on newly-deployed cloud clusters. This is a regression on the current `preview` build.

## Observed

On a brand-new wizard-provisioned cluster the deferred repo clone runs **once, ~2 minutes too early**, before the user's GitHub token is sealed, and never re-runs. Timeline from `snappoll-3` (all times UTC):

- `01:15:01` — cluster activated (device code claimed), `cluster-api-key` written, `Cluster activation complete`.
- `01:15:01` — orchestrator logs `Post-activation incomplete on restart — triggering retry` → `replaying bootstrap-complete lifecycle action` → `bootstrap-complete lifecycle action sent`.
- `01:15:03` — one-shot watcher fires and `entrypoint-post-activation.sh` aborts:
  - `ERROR: primary repo clone required (REPO_URL=…/snappoll-3.git) but GH_TOKEN is missing/empty.`
  - `Refusing a token-less clone — exiting non-zero so post-activation is retried once credentials land.`
  - watcher logs `ERROR: post-activation exited 1` and **exits** (it is one-shot).
- `01:17:23` — `~2m20s later`, the user finishes the bootstrap wizard: a valid 40-char `GH_TOKEN` is sealed into `/var/lib/generacy/wizard-credentials.env` and the sentinel is re-touched — **but no watcher remains to consume it.**

Result: empty `/workspaces`, `post-activation-complete` flag never written, workers stuck in "deferring repo clone until activation completes", cluster unusable.

Credentials are not the problem — after the fact, `git ls-remote` against the repo from inside the orchestrator (using the sealed creds / JIT helper) succeeds and returns `refs/heads/main`. The control-plane had also already pulled a valid github-app token from the cloud at `01:15:02` (`git-token-cloud-pull result=ok`). The **only** defect is that post-activation fired before those credentials were available and never got a second chance.

## Mechanism / root cause

The deferred clone is driven by a **one-shot** watcher (`post-activation-watcher.sh` in `cluster-base`): it waits for `/tmp/generacy-bootstrap-complete`, runs `entrypoint-post-activation.sh` exactly once, then exits with that run's status. Recovery from a failed run depends entirely on the orchestrator's `PostActivationRetryService` firing again later.

1. `packages/orchestrator/src/server.ts:1022` runs `runPostActivationBranch()` immediately after `Cluster activation complete`. On a fresh cluster the state is `activated && !postActivationComplete` (api-key just written, post-activation never ran), so `needsRetry` is **trivially true** — see `checkPostActivationState()` in `packages/orchestrator/src/services/post-activation-retry.ts:47` (`needsRetry = activated && !postActivationComplete`).
2. `runPostActivationBranch` (`packages/orchestrator/src/services/post-activation-dispatch.ts:37`) takes the `needsRetry` branch and replays the `bootstrap-complete` lifecycle action to the control-plane.
3. The control-plane `bootstrap-complete` handler (`packages/control-plane/src/routes/lifecycle.ts:187`) writes the post-activation sentinel **unconditionally** — it does not check whether a GitHub token was sealed. Contrast the sibling `prepare-workspace` handler (`.../lifecycle.ts:146-155`), which correctly gates the sentinel write on `hasGitHubToken`.
4. The one-shot watcher fires with no `GH_TOKEN`, the clone guard in `entrypoint-post-activation.sh` correctly refuses, the watcher exits, and the `PostActivationRetryService` — which only runs once at activation — never fires again. When real credentials land ~2 min later, nothing is listening.

### Why this regressed now

The dispatch at `server.ts:1022` sits directly below `relayBridge.start()`. Commit **`ff9da3a8` — "make boot-resume reachable on wizard clusters" (#838, 2026-07-07)** changed `await relayBridge.start()` into a fire-and-forget call so the code beneath it would run (its goal: reach the `activated && complete → boot-resume` branch for VS Code tunnel auto-resume, #834). On wizard clusters `await relayBridge.start()` had previously blocked forever (it awaits the relay's long-lived reconnect loop), so this whole block — including the `needsRetry` retry branch — was unreachable dead code. Making boot-resume reachable also made the **premature `bootstrap-complete` replay reachable on the first activation of every fresh wizard cluster**.

This re-opens the exact race that **`967718ef` — "defer post-activation sentinel until GitHub token is sealed" (#739/#741)** had closed. That fix only hardened the `prepare-workspace` path and explicitly left `bootstrap-complete` ungated ("terminal step, fires with the full credential set"). The retry replays `bootstrap-complete`, so it sails straight through the one door that was left unlocked.

Both `ff9da3a8` and `967718ef` are confirmed present in the running preview build (`0b3d72c`). The failure is deterministic on the interactive wizard path (the retry always fires the instant activation completes, always before the human finishes entering credentials), which matches "happens on every new cluster locally and in the cloud."

## Durable fix

Primary — **gate the retry on credentials actually being present** (self-contained in the orchestrator). The `PostActivationRetryService` was designed for the *restart-after-creds-delivered* case ("post-activation may have failed on a prior container lifecycle"); firing it *before* any credentials exist is the bug. In `checkPostActivationState()`, only set `needsRetry` when the wizard credentials file exists **and** carries a non-empty `GH_TOKEN` (mirroring the guard `entrypoint-post-activation.sh` already applies). On a fresh pre-credentials cluster the retry then defers, and the normal token-gated `prepare-workspace` / end-of-wizard `bootstrap-complete` flow drives the clone as intended; genuine restart-recovery (creds already sealed) still fires.

Defense-in-depth in the same repo (either alone would also have prevented this — recommend doing at least the first):
- Gate `bootstrap-complete`'s sentinel write on `hasGitHubToken`, exactly like `prepare-workspace` already does (`packages/control-plane/src/routes/lifecycle.ts`), so a token-less replay can never fire the one-shot clone.

Out of scope for this issue (separate `cluster-base` repo, tracked separately if desired): making `post-activation-watcher.sh` re-arm after a failed run instead of being strictly one-shot.

## Regression tests

- `PostActivationRetryService.checkPostActivationState`: `activated && !complete` but **no** `GH_TOKEN` in the wizard creds file → `needsRetry === false` (defer). With a sealed `GH_TOKEN` present → `needsRetry === true` (restart-recovery still works).
- `runPostActivationBranch`: fresh-activation state with no sealed creds → does **not** send the `bootstrap-complete` lifecycle action.
- control-plane `bootstrap-complete` handler: no GitHub token sealed → sentinel is **not** written (mirror the existing `prepare-workspace` gated-sentinel test).
- End-to-end guard: after a deferred (token-less) activation followed by a later credential delivery, the clone completes and `post-activation-complete` is written exactly once.


## User Stories

### US1: Fresh wizard-provisioned cluster clones its primary repo

**As an** operator provisioning a brand-new cluster via the bootstrap wizard,
**I want** the primary repo to clone into `/workspaces/<repo>` once the wizard has sealed my GitHub credentials,
**So that** the orchestrator and workers can start against a populated workspace instead of an empty one.

**Acceptance Criteria**:
- [ ] On the first activation of a fresh cluster (no wizard credentials sealed yet), the `PostActivationRetryService` does **not** replay `bootstrap-complete` — it defers.
- [ ] Once the wizard finishes and `wizard-credentials.env` contains a non-empty `GH_TOKEN`, the normal wizard-driven `bootstrap-complete` flow runs the one-shot watcher exactly once with credentials present.
- [ ] `/workspaces/<repo>` contains a valid `.git` and `post-activation-complete` is written on the healthy path.
- [ ] On genuine restart-recovery (creds already sealed on a prior container lifecycle, post-activation not yet complete), the retry service still fires as before.

### US2: Operator observes why post-activation is deferred

**As an** operator or cloud-side UI,
**I want** a positive signal that post-activation retry was skipped because credentials are not yet sealed,
**So that** a stuck fresh cluster is diagnosable from logs and the cloud dashboard without inference from a missing log line.

**Acceptance Criteria**:
- [ ] The retry service emits one `logger.info` line naming `GH_TOKEN` / `wizard-credentials.env` when it defers on credentials.
- [ ] The retry service emits a `cluster.bootstrap` relay event with `{ status: 'deferred', reason: 'github-token-not-sealed' }`, mirroring the existing `prepare-workspace` `awaiting-credentials` defer shape.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `PostActivationRetryService.checkPostActivationState()` MUST return `needsRetry = false` unless the wizard credentials file exists AND contains a `GH_TOKEN` entry with a non-empty trimmed value. Presence-only predicate — no length or shape check. | P1 | Clarified Q1→A. Matches `writeWizardEnvFile`'s own "usable token" predicate (`value.length > 0`); GitHub token formats vary (`ghp_`/`ghs_`/`github_pat_…`), so length gates are wrong. |
| FR-002 | When FR-001's predicate is false and the cluster is otherwise `activated && !postActivationComplete`, the retry service MUST emit (a) a `logger.info` line identifying the defer reason and the file inspected, and (b) a `cluster.bootstrap` relay event with `{ status: 'deferred', reason: 'github-token-not-sealed' }`. | P1 | Clarified Q3→B. Reason string aligned with `prepare-workspace`'s existing defer path; do NOT reuse `awaiting-credentials` literally — the new reason is `github-token-not-sealed`, distinct so operators can tell the two defer paths apart. |
| FR-003 | The wizard-credentials path MUST be sourced via a new constructor option `wizardCredsPath` on `PostActivationRetryService`, whose default is `process.env.WIZARD_CREDS_PATH ?? '/var/lib/generacy/wizard-credentials.env'`. | P1 | Clarified Q4→C. Correctness requirement, not style — control-plane already honors `WIZARD_CREDS_PATH` when writing the file (`lifecycle.ts:171`); hard-coding the default would silently defeat the gate on relocated creds. Preserves the sibling `completionFlagPath` / `keyFilePath` test-seam pattern. |
| FR-004 | The `GH_TOKEN` extraction MUST parse the file line-by-line, splitting each line at the first `=`, trimming the value, and reading the `GH_TOKEN` key. No quoting, comment, or escape handling. Missing file, missing key, and empty trimmed value all yield "not sealed". | P2 | Clarified Q5→B. Writer emits plain `KEY=VALUE` lines (`formatEnvFile`); line-split is robust to trailing newline / blank lines and composes cleanly with FR-001's presence check. Splitting on the first `=` preserves opaque values. |
| FR-005 | On a genuinely restart-recovery cluster (creds sealed on a prior container lifecycle, `post-activation-complete` flag missing), the retry service MUST still replay `bootstrap-complete` exactly as it does today. | P1 | Guardrail: FR-001 is a defer-not-remove change. |
| FR-006 | The control-plane `bootstrap-complete` lifecycle handler (`packages/control-plane/src/routes/lifecycle.ts`) MUST gate the post-activation sentinel write on `hasGitHubToken`, exactly as the sibling `prepare-workspace` handler does. When `hasGitHubToken` is false, emit a `cluster.bootstrap` `awaiting-credentials`-style event and skip the sentinel write; when true, write the sentinel unchanged. | P1 | Clarified Q2→A — ship in the same PR as FR-001. Defense-in-depth: closes the class of "premature `bootstrap-complete` replay" rather than only today's caller. `bootstrap-complete` remains the terminal step — it must still fire the sentinel whenever a token IS present. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Fresh wizard-clone success rate | 100% of new wizard-provisioned clusters end with `/workspaces/<repo>/.git` present and `post-activation-complete` written | Manual smoke on local `snappoll-3`-style deploy + cloud staging cluster; assert `.git` and completion flag exist within 30s of wizard finish |
| SC-002 | No premature replay | On a fresh activation with no wizard credentials sealed, the orchestrator log MUST NOT contain `replaying bootstrap-complete lifecycle action` and MUST contain the FR-002 defer log line | Grep post-activation orchestrator logs from activation to wizard-complete for both patterns |
| SC-003 | Positive defer signal | On a fresh activation with no wizard credentials sealed, the cloud receives exactly one `cluster.bootstrap` event with `reason: 'github-token-not-sealed'` between activation and wizard-complete | Cloud relay log inspection |
| SC-004 | Restart-recovery preserved | On a container restart where creds were sealed previously and `post-activation-complete` is absent, `bootstrap-complete` is still replayed and the clone runs | Regression test (see RT below) + one manual restart |
| SC-005 | Clone runs exactly once | End-to-end: after a deferred (token-less) activation followed by a normal wizard credential-seal, the primary repo clone runs exactly once and `post-activation-complete` is written exactly once | E2E test asserting a single `entrypoint-post-activation.sh` invocation across the full lifecycle |

## Regression Tests

| ID | Target | Scenario | Expected |
|----|--------|----------|----------|
| RT-001 | `PostActivationRetryService.checkPostActivationState()` | `activated && !complete`, no `GH_TOKEN` in wizard creds file | `needsRetry === false`; FR-002 log + relay event emitted |
| RT-002 | `PostActivationRetryService.checkPostActivationState()` | `activated && !complete`, sealed `GH_TOKEN` present | `needsRetry === true`; no defer event |
| RT-003 | `runPostActivationBranch` | Fresh-activation state, no sealed creds | Does NOT send the `bootstrap-complete` lifecycle action |
| RT-004 | control-plane `bootstrap-complete` handler | No GitHub token sealed | Sentinel NOT written; `awaiting-credentials`-shaped event emitted (mirror of the existing `prepare-workspace` gated-sentinel test) |
| RT-005 | End-to-end | Deferred (token-less) activation → later credential delivery via wizard | Clone completes; `post-activation-complete` written exactly once; single watcher invocation |

## Assumptions

- The wizard-env-writer's line-oriented `KEY=VALUE` format (no quoting, no comments, no escapes) is stable for the lifetime of this fix. If that contract changes, FR-004's parsing MUST be re-evaluated (out of scope for this issue but noted).
- The retry service's role remains "restart-after-creds-delivered" recovery, not "wait-for-creds" polling. This fix defers on missing creds; the normal wizard-driven `bootstrap-complete` (with credentials present) is the sole primary clone trigger on fresh clusters.
- Both fixes (FR-001 orchestrator, FR-006 control-plane) ship in the same PR (Q2→A). No feature flags or staged rollout are required — both changes are strict "defer or emit event, don't remove behavior when preconditions are met".
- On a `REPO_URL`-configured cluster with no token, the post-activation guard in `entrypoint-post-activation.sh` already refuses cleanly, so FR-006's gated skip regresses no working behavior.

## Out of Scope

- Making `post-activation-watcher.sh` re-arm after a failed run instead of being strictly one-shot. This lives in the separate `cluster-base` repo and would be tracked as its own issue if pursued.
- Introducing a background poller / systemd retry loop for `PostActivationRetryService`. The service remains one-shot at activation; retry-on-defer relies on the existing wizard credential-seal flow driving `bootstrap-complete` end-to-end.
- Changing the `wizard-credentials.env` writer format or replacing plain `KEY=VALUE` with a structured format.
- Cloud-side UI changes to render the new `github-token-not-sealed` reason. The event shape mirrors the existing `awaiting-credentials` payload from `prepare-workspace`, so the cloud already understands the `cluster.bootstrap` channel; specialized UI treatment is a separate cloud-repo task.
- Full dotenv semantics (quoted values, `#` comments, escapes) in the reader — deferred behind FR-004's line-split parser (Q5→B).

---

*Generated by speckit*

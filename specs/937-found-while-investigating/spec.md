# Feature Specification: Fix premature `bootstrap-complete` retry that burns the one-shot post-activation clone on fresh wizard clusters

**Branch**: `937-found-while-investigating` | **Date**: 2026-07-14 | **Status**: Draft | **Issue**: [#937](https://github.com/generacy-ai/generacy/issues/937)

## Summary

On a brand-new wizard-provisioned cluster, the orchestrator's `PostActivationRetryService` fires a `bootstrap-complete` lifecycle replay **immediately after activation** — before the user has finished the bootstrap wizard, and therefore before `GH_TOKEN` has been sealed. That replay burns the one-shot post-activation watcher in `cluster-base`: it clones with no token, `entrypoint-post-activation.sh` correctly refuses and exits non-zero, the watcher exits (it's strictly one-shot), and when the real credentials land ~2 minutes later there is nothing left listening. Fresh wizard clusters — local and cloud — never clone their primary repo. Result: empty `/workspaces`, `post-activation-complete` sentinel never written, workers stuck "deferring repo clone until activation completes", cluster unusable.

This is a **deterministic regression on `preview`**, caused by the interaction of two prior fixes:
- `ff9da3a8` (#838, 2026-07-07) made `relayBridge.start()` fire-and-forget so `runPostActivationBranch()` at `packages/orchestrator/src/server.ts:1022` became reachable on wizard clusters.
- `967718ef` (#739/#741) hardened `prepare-workspace` against token-less sentinel writes but explicitly left `bootstrap-complete` ungated ("terminal step, fires with the full credential set"). The retry replays `bootstrap-complete`, so it sails straight through the only door still open.

Credentials themselves are fine: post-hoc `git ls-remote` from the orchestrator succeeds, and the control-plane pulled a valid GitHub App token from the cloud within ~1s of activation. The **only** defect is that post-activation fires before those credentials are available in the wizard-creds env file, and never gets a second chance.

## Observed timeline (`snappoll-3`, `cluster-base:preview`, UTC)

- `01:15:01` — cluster activated (device code claimed), `cluster-api-key` written, `Cluster activation complete`.
- `01:15:01` — orchestrator logs `Post-activation incomplete on restart — triggering retry` → `replaying bootstrap-complete lifecycle action` → `bootstrap-complete lifecycle action sent`.
- `01:15:02` — control-plane logs `git-token-cloud-pull result=ok` (valid github-app token available in-memory).
- `01:15:03` — one-shot watcher fires `entrypoint-post-activation.sh`; it aborts with `ERROR: primary repo clone required (REPO_URL=…/snappoll-3.git) but GH_TOKEN is missing/empty. Refusing a token-less clone — exiting non-zero so post-activation is retried once credentials land.` Watcher logs `ERROR: post-activation exited 1` and **exits**.
- `01:17:23` (~2m20s later) — user finishes the bootstrap wizard, a valid 40-char `GH_TOKEN` is sealed into `/var/lib/generacy/wizard-credentials.env`, the sentinel is re-touched — **but no watcher remains to consume it.**

## Root cause (call chain)

1. `packages/orchestrator/src/server.ts:1022` runs `runPostActivationBranch()` immediately after `Cluster activation complete`. On a fresh cluster the state is `activated && !postActivationComplete` (api-key just written, post-activation never ran).
2. `checkPostActivationState()` in `packages/orchestrator/src/services/post-activation-retry.ts:47` computes `needsRetry = activated && !postActivationComplete` — trivially `true` on first activation. It **does not consult credential state**.
3. `runPostActivationBranch` in `packages/orchestrator/src/services/post-activation-dispatch.ts:37` takes the `needsRetry` branch and replays the `bootstrap-complete` lifecycle action against the control-plane.
4. The control-plane `bootstrap-complete` handler at `packages/control-plane/src/routes/lifecycle.ts:187` writes the post-activation sentinel **unconditionally**. Contrast the sibling `prepare-workspace` handler at `.../lifecycle.ts:146-155`, which gates the sentinel write on `hasGitHubToken`.
5. The one-shot `post-activation-watcher.sh` (in the `cluster-base` repo, out of scope for a fix here) fires with no `GH_TOKEN`, the clone guard in `entrypoint-post-activation.sh` correctly refuses, the watcher exits, and `PostActivationRetryService` — which only runs once at activation — never fires again. When real credentials arrive ~2 min later, nothing listens.

`PostActivationRetryService` was designed for the *restart-after-creds-delivered* case ("post-activation may have failed on a prior container lifecycle"); firing it *before* any credentials exist is the defect.

## User Stories

### US1: Fresh wizard-provisioned cluster clones its primary repo (Primary)

**As a** cluster operator provisioning a brand-new cluster through the bootstrap wizard,
**I want** the primary repo to be cloned into `/workspaces/<name>` after I finish entering my credentials,
**So that** workers can pick up work and my cluster is usable without manual intervention.

**Acceptance Criteria**:
- [ ] On a fresh wizard-provisioned cluster where credentials are sealed *after* activation completes, the primary repo is cloned exactly once, `.git` exists, and `post-activation-complete` is written.
- [ ] The `PostActivationRetryService` does **not** replay `bootstrap-complete` before `GH_TOKEN` has been sealed into `/var/lib/generacy/wizard-credentials.env`.
- [ ] Workers exit the "deferring repo clone until activation completes" state and pick up queued work.
- [ ] Reproduces on both local docker (`cluster-base:preview`) and cloud-provisioned clusters.

### US2: Restart-recovery of a genuinely-failed post-activation still works

**As a** cluster operator whose cluster crashed *after* credentials were sealed but *before* post-activation completed,
**I want** the orchestrator to replay `bootstrap-complete` on next boot,
**So that** the interrupted clone recovers without another wizard round-trip.

**Acceptance Criteria**:
- [ ] On restart, when `wizard-credentials.env` contains a non-empty `GH_TOKEN` and `post-activation-complete` is absent, `needsRetry === true` and `bootstrap-complete` is replayed.
- [ ] The prior restart-recovery test coverage in `PostActivationRetryService` continues to pass without loosening.

### US3: Defense-in-depth against a token-less `bootstrap-complete` (Optional)

**As a** platform engineer,
**I want** the control-plane `bootstrap-complete` handler to refuse writing the post-activation sentinel when no GitHub token is present,
**So that** a stray token-less replay from *any* source (retry service, manual `curl`, future caller) cannot burn the one-shot watcher.

**Acceptance Criteria**:
- [ ] `POST /lifecycle` with `action=bootstrap-complete` does **not** write the post-activation sentinel when no GitHub token is sealed.
- [ ] Mirrors the existing `prepare-workspace` gated-sentinel behaviour at `packages/control-plane/src/routes/lifecycle.ts:146-155`.
- [ ] Handler response signals the deferred state (does not appear as a silent success).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `PostActivationRetryService.checkPostActivationState()` MUST set `needsRetry = false` when `activated && !postActivationComplete` but `wizard-credentials.env` is missing OR its `GH_TOKEN` is missing/empty. | P1 | Primary fix. Mirrors the guard `entrypoint-post-activation.sh` already applies. |
| FR-002 | `PostActivationRetryService.checkPostActivationState()` MUST continue to set `needsRetry = true` when `activated && !postActivationComplete` AND `wizard-credentials.env` carries a non-empty `GH_TOKEN`. | P1 | Preserves genuine restart-recovery (US2). |
| FR-003 | `runPostActivationBranch()` MUST NOT send the `bootstrap-complete` lifecycle action when `needsRetry === false`, regardless of `activated`/`postActivationComplete` state. | P1 | Falls out of FR-001 by construction — but the behaviour is what we're asserting. |
| FR-004 | Wizard-credentials file location and `GH_TOKEN` key name MUST match the sealer's write and `entrypoint-post-activation.sh`'s read: `/var/lib/generacy/wizard-credentials.env`, KEY-VALUE-per-line, `GH_TOKEN=<40+ chars>`. | P1 | No new contract — asserts alignment with existing sources of truth. |
| FR-005 | The check MUST tolerate the wizard-credentials file being absent (fresh cluster, pre-wizard) without throwing — treat missing file as "no token". | P1 | Fresh-cluster path must not error out. |
| FR-006 | (Defense-in-depth, optional) The control-plane `bootstrap-complete` handler MUST NOT write the post-activation sentinel when no GitHub token is sealed. | P2 | Mirrors `prepare-workspace` gated-sentinel behaviour. Either FR-001 alone or FR-006 alone prevents the bug; FR-006 gives us belt-and-braces. |
| FR-007 | Both changes MUST be self-contained in the `generacy` repo — no dependency on a `cluster-base` release. | P1 | Fix must ship independently. Watcher re-arm is tracked separately in `cluster-base`. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Fresh wizard cluster clone success rate | 100% (was 0% on preview) | Provision a fresh `cluster-base:preview` cluster locally end-to-end via the wizard; confirm `/workspaces/<name>/.git` exists and `post-activation-complete` sentinel is present after the wizard closes. |
| SC-002 | Premature `bootstrap-complete` replay is eliminated on the fresh-activation path | 0 replays before `GH_TOKEN` sealed | Grep orchestrator logs across a fresh-cluster boot: `replaying bootstrap-complete lifecycle action` MUST NOT appear before the `wizard-credentials.env` write log line. |
| SC-003 | Restart-recovery replay still fires when appropriate | 1 replay per interrupted post-activation | Unit test: seal creds file with `GH_TOKEN`, remove `post-activation-complete`, invoke `checkPostActivationState()` → `needsRetry === true`. |
| SC-004 | Regression tests cover all four scenarios called out in the issue | 4 of 4 present and passing | (a) fresh no-token → `needsRetry=false`; (b) sealed token → `needsRetry=true`; (c) `runPostActivationBranch` no-token → no lifecycle send; (d) e2e: token-less activation → later sealing → clone completes → sentinel written exactly once. |
| SC-005 | End-to-end clone completes exactly once on fresh-then-sealed sequence | Exactly 1 successful clone, exactly 1 sentinel write | Instrumented e2e or manual reproduction: after deferred (token-less) activation followed by later credential delivery, the clone runs once and `post-activation-complete` is written once. |

## Assumptions

- **A1** — The wizard-credentials env file is the correct signal for "GitHub token is available to the post-activation script". `entrypoint-post-activation.sh` reads the same file for the same purpose, so the retry service checking it introduces no new contract.
- **A2** — `GH_TOKEN` is the canonical env var name inside `wizard-credentials.env`. This matches `mapCredentialToEnvEntries` in `packages/control-plane/src/services/wizard-env-writer.ts` (#589/#592) and the guard in `entrypoint-post-activation.sh`.
- **A3** — Fixing this in the orchestrator (FR-001) is sufficient to close the observed bug even without the defense-in-depth control-plane change (FR-006). The issue text says either alone would have prevented it.
- **A4** — The one-shot nature of `post-activation-watcher.sh` in `cluster-base` is *not* fixed here. Making it re-arm is a separate `cluster-base` change; this spec explicitly leaves that out of scope.
- **A5** — `PostActivationRetryService`'s original intent — recovering from post-activation that failed on a prior container lifecycle *after* creds were delivered — is preserved. The fix is a narrower predicate, not a functional gutting.
- **A6** — The regression window is bounded by `ff9da3a8` (2026-07-07); pre-`ff9da3a8` `preview` builds are not affected because the enclosing block was unreachable dead code on wizard clusters.

## Out of Scope

- Making `post-activation-watcher.sh` re-arm after a failed run (tracked separately in the `cluster-base` repo).
- Refactoring `PostActivationRetryService` beyond adding the credential-presence predicate.
- Changing when or how `wizard-env-writer.ts` produces `GH_TOKEN` — the sealing side is correct and works.
- Changing the `prepare-workspace` gated-sentinel behaviour it currently has (`.../lifecycle.ts:146-155`) — that is already correct and is the reference pattern.
- Cloud-side changes: the cloud correctly issues an installation token within ~1s of activation; that path is not implicated.
- Changing worker deferral behaviour ("deferring repo clone until activation completes") — once post-activation writes the sentinel, workers unblock as intended.

## Regression Tests

Directly from the issue text, all must land as part of the fix:

- **RT-001** — `PostActivationRetryService.checkPostActivationState`: `activated && !postActivationComplete` but **no** `GH_TOKEN` in the wizard creds file (file absent OR key absent OR value empty) → `needsRetry === false` (defer).
- **RT-002** — `PostActivationRetryService.checkPostActivationState`: `activated && !postActivationComplete` with a sealed non-empty `GH_TOKEN` present → `needsRetry === true` (restart-recovery still works).
- **RT-003** — `runPostActivationBranch`: fresh-activation state with no sealed creds → does **not** send the `bootstrap-complete` lifecycle action (assert on the control-plane mock/spy).
- **RT-004** — (Only if FR-006 is included) control-plane `bootstrap-complete` handler: no GitHub token sealed → sentinel is **not** written. Mirror the existing `prepare-workspace` gated-sentinel test.
- **RT-005** — End-to-end guard: after a deferred (token-less) activation followed by a later credential delivery, the clone completes and `post-activation-complete` is written exactly once (no duplicate sentinel writes, no double-clone).

---

*Generated by speckit*

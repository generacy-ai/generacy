# Feature Specification: ## Symptom

User flow: in the cloud UI, archive a cluster → click "Add cluster" → run the new `npx generacy launch --claim=<new-claim>` from the dashboard

**Branch**: `614-symptom-user-flow-cloud` | **Date**: 2026-05-14 | **Status**: Draft

## Summary

## Symptom

User flow: in the cloud UI, archive a cluster → click "Add cluster" → run the new `npx generacy launch --claim=<new-claim>` from the dashboard. The cluster boots; its `onboarding-test-10-orchestrator-1` logs show:

```
{"msg":"Checking for existing cluster API key"}
{"msg":"Existing cluster API key found, skipping activation"}
{"msg":"Cluster activation complete"}
{"msg":"Relay bridge configured"}
[relay] WebSocket connected, sending handshake
{"msg":"Relay connected to cloud"}
```

…then every subsequent GitHub API call from the orchestrator's monitors 401s every minute, forever:

```
Failed to list open PRs for christrudelpw/onboarding-test-10:
  HTTP 401: Bad credentials (https://api.github.com/graphql)
  Try authenticating with: gh auth login

Failed to list issues with label "process:speckit-feature":
  non-200 OK status code: 401 Unauthorized
```

Even after `generacy-ai/generacy-cloud#568` (cloud re-mints + re-delivers fresh `github-main-org` credential to the cluster on every WS reconnect), the orchestrator continues to 401. The cluster runs, the relay works, but the orchestrator cannot make any authenticated GitHub call.

## Root cause: two separate cluster-side problems

### Problem 1 — Activation skip gates on key-file presence alone

[`packages/orchestrator/src/activation/index.ts:34-47`](packages/orchestrator/src/activation/index.ts#L34-L47):

```ts
const existingKey = await readKeyFile(keyFilePath);
if (existingKey) {
  logger.info('Existing cluster API key found, skipping activation');
  const metadata = await readClusterJson(clusterJsonPath);
  return { apiKey: existingKey, ... };
}
```

If the key file is present on disk, the entire device-code activation flow is short-circuited and `activate()` returns immediately. This is the correct behaviour for *normal* cluster restarts (same machine, same project, key still valid). It is **wrong** for the user's "re-add a cluster" flow:

1. User runs `npx generacy launch --claim=<old-claim>` once → activation runs → key persisted into the named docker volume.
2. User clicks "Stop cluster" / `docker compose down` → containers gone, volume intact.
3. User archives the cluster from the cloud UI → user clicks "Add cluster" → cloud issues a new claim → user runs `npx generacy launch --claim=<new-claim>`.
4. CLI scaffolds the project, `docker compose up` runs, the orchestrator boots — and finds the **stale** key file in the volume. Activation is skipped. No fresh wizard run, no credential delivery, no `bootstrap-complete` lifecycle action — and the orchestrator boots with stale environment from the previous setup.

The cluster-API-key being valid in the cloud (relay accepts it because it's still in Firestore under `clusters/<projectId>/api_keys/...`) compounds the misdiagnosis: from the cluster's perspective everything looks fine, from the cloud's perspective the WS connection is healthy, but the credential surface is stuck wherever it was at the end of the original wizard run.

### Problem 2 — `handlePutCredential` doesn't re-surface the credential as `GH_TOKEN`

[`packages/control-plane/src/routes/credentials.ts:62-117`](packages/control-plane/src/routes/credentials.ts#L62-L117) accepts the PUT, calls `writeCredential(...)`, and that's it. `writeCredential` does two things ([`services/credential-writer.ts:28-65`](packages/control-plane/src/services/credential-writer.ts#L28-L65)):

1. Persists the secret via `ClusterLocalBackend.setSecret(credentialId, value)` — encrypted at rest in the credhelper-daemon's store.
2. Writes metadata to `.agency/credentials.yaml`.
3. Emits a `cluster.credentials` relay event with `status: 'written'`.

What it does **not** do:

- It does not re-run [`writeWizardEnvFile`](packages/control-plane/src/services/wizard-env-writer.ts#L62) — which is the function that translates `type: 'github-app'`'s `value.token` into the `GH_TOKEN=<...>` line in `/var/lib/generacy/wizard-credentials.env`. That function only runs from the `bootstrap-complete` lifecycle action ([`routes/lifecycle.ts:99-115`](packages/control-plane/src/routes/lifecycle.ts#L99-L115)), which fires exactly once at the end of the wizard.
- The env file persists in the volume and is re-sourced by `entrypoint-post-activation.sh` on every container restart (not deleted after bootstrap). `setup-credentials.sh` then runs `gh auth login --with-token` from the sourced `$GH_TOKEN` and writes `~/.config/gh/hosts.yml`. Since `~/.config/gh/hosts.yml` lives in the ephemeral container filesystem (not the named volume), it is recreated from the env file on every restart. This makes the env file the source-of-truth for `gh`'s auth state across container restarts.

So even though cloud-side #568 successfully PUTs a fresh installation token to the cluster every reconnect, the cluster:

- ✅ Writes the new token into the credhelper store.
- ❌ Does not rewrite `/var/lib/generacy/wizard-credentials.env` (the source-of-truth for `gh` auth on container restart).
- ❌ Does not re-run `gh auth login --with-token` (the live-refresh path for `~/.config/gh/hosts.yml`).
- ❌ Does not signal the orchestrator (or its child `gh` processes) to refresh their cached auth state.

The orchestrator keeps calling `gh` with the same token from yesterday's wizard run. `gh` 401s. The Firestore doc says the cluster is "online", the credhelper has the right secret, but the gh CLI's view of the world is hours stale. On container restart, the entrypoint re-sources the stale env file, recreating the same 401.

## Recommended fix

Two changes that together close the gap:

### Fix A (high-priority) — `handlePutCredential` rewrites GH_TOKEN surface for github credentials

In [`packages/control-plane/src/routes/credentials.ts`](packages/control-plane/src/routes/credentials.ts), after the existing `writeCredential(...)` call succeeds, if the credential type is `github-app` or `github-pat`:

1. **(P1 — restart path)** Re-run `writeWizardEnvFile({ agencyDir, envFilePath })` so the env file is regenerated with the new token in the `GH_TOKEN=...` line. This is load-bearing: on container restart, `entrypoint-post-activation.sh` re-sources this file and runs `setup-credentials.sh` to recreate `~/.config/gh/hosts.yml`. Without this step, a restart would revert to the stale token. (`mapCredentialToEnvEntries` already knows how to extract `token` from the github-app value JSON; no schema work needed.)
2. **(P1 — live-refresh path)** Re-invoke `gh auth login --with-token` with the new token so `~/.config/gh/hosts.yml` is updated immediately. The orchestrator's `GhCliGitHubClient` uses `gh` which reads that config on every call. (Either shell out to `gh auth login --with-token <<<"$NEW_TOKEN"` from the control-plane, or — cleaner — write the token directly to `~/.config/gh/hosts.yml` and let `gh` pick it up.)

Both steps are scoped to github-app / github-pat credentials. Other credential types (anthropic-api-key, etc.) are unaffected because their env entries don't need a separate auth surface.

### Fix B (medium-priority) — CLI `--claim` signals force-reactivation by clearing stale key files

When the CLI receives a `--claim` argument, it should delete the stale `cluster-api-key` and `cluster.json` from the `generacy-data` Docker volume before running `docker compose up`. Implementation: `docker run --rm -v <project>_generacy-data:/v alpine rm -f /v/cluster-api-key /v/cluster.json`. With those files removed, [`activation/index.ts:35`](packages/orchestrator/src/activation/index.ts#L35)'s `readKeyFile()` returns null, the existing-key short-circuit doesn't fire, and the device-code flow runs — **with zero orchestrator code change**.

This approach was chosen over two alternatives:
- ~~Health-check approach (FR-004)~~: Checking credential health at activation time has definitional problems (what counts as "healthy"?) and couples activation to credhelper internals. Deferred to a follow-up only if a non-claim-driven re-activation scenario surfaces.
- ~~`docker volume rm`~~: Destroys all persisted cluster state (audit logs, credhelper master key, scratch directories).

Fix A is the load-bearing change — it makes refresh-on-reconnect (#568 in generacy-cloud) actually take effect. Fix B ensures the re-add flow starts clean.

### Fix C (longer-term) — Orchestrator's GitHub client should mint-on-demand via credhelper-daemon

The deeper architectural fix: don't cache `GH_TOKEN` in the orchestrator's environment at all. The credhelper-daemon's per-worker minting flow (referenced in #547's design) is the right primitive — each call to `GhCliGitHubClient` would mint a short-lived token from the daemon, which always serves from the freshest secret in the store. This removes the entire class of stale-env-var bugs.

Out of scope for this fix; tracked here for context. Companion to `generacy-ai/generacy#572` (consolidating the cluster ↔ cloud connection contract).

## Verified

- Cloud-side: PR `generacy-ai/generacy-cloud#568` is deployed (commit `83820a0` on api-staging) and the refresh-on-reconnect path is exercised on every WS connect.
- Cluster-side: orchestrator container logs from the user's 14:49 UTC reconnect show no `gh auth login` re-invocation and no env-file rewrite. The 401s continue every minute. The Firestore cluster doc has fresh `lastSeen` / `connectedAt` and the relay-server side reports a healthy connection — confirming the credential PUT is being forwarded but the cluster's response surface is incomplete.
- Cluster-base setup-credentials.sh (the entrypoint script that does the initial `gh auth login --with-token`) only runs once at container startup. There is no re-invocation hook after that.

## Test plan

- [ ] Implement Fix A. Add a unit test that PUTs a `type: 'github-app'` credential with a new token and verifies (1) the env file's `GH_TOKEN=` line is rewritten, (2) `gh auth login --with-token` is invoked / `hosts.yml` is updated.
- [ ] Implement Fix B (or the simpler variant: respect `--claim` as a force-reactivate signal).
- [ ] Manual: reproduce the user flow (archive cluster in cloud → re-add → `npx generacy launch --claim=<new>` on a host whose docker volume still has the old key file) → confirm activation runs, wizard credentials reach the cluster, orchestrator's first PR-monitor poll succeeds without 401.
- [ ] Manual: drop a fresh credential via `PUT /credentials/github-main-org` to a running cluster → orchestrator's next `gh` invocation uses the new token (verifiable by minting a stale-then-fresh token and watching the API call succeed).

## Related

- `generacy-ai/generacy-cloud#567` (cloud-side root cause discussion)
- `generacy-ai/generacy-cloud#568` (cloud-side refresh-on-reconnect — does its job but cluster doesn't act on it)
- #547 (initial mint-at-wizard-time on cloud)
- #589 / #591 (cluster-side `wizard-env-writer` that consumes the initial wizard delivery)
- #572 (umbrella: cluster ↔ cloud connection contract — Fix C lives under this)

## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*

# Feature Specification: ## Summary

Managed/cloud cluster deploys **never auto-activate**

**Branch**: `739-summary-managed-cloud-cluster` | **Date**: 2026-06-02 | **Status**: Draft

## Summary

## Summary

Managed/cloud cluster deploys **never auto-activate**. The deploy pipeline pre-approves an activation code and bakes `GENERACY_PRE_APPROVED_ACTIVATION_CODE` into the cluster's `.env`, but the orchestrator never reads it — it always runs the **interactive device-code flow**, mints a *fresh* code, and waits for a human to approve it. For a managed deploy nobody does, so the cluster sits at "Connecting" until the code expires.

Reproduced on staging (droplet `574834991`): `.env` had `GENERACY_PRE_APPROVED_ACTIVATION_CODE=VH57-EJRH`, but the orchestrator logged `Requesting device code (cycle 1/3)` and printed a **different** code `2RGQ-KE6A` for manual entry. A 6-minute watch of the cluster doc showed no connection (`orchestratorVersion` stuck at the `device-flow` placeholder, `lastSeen` frozen).

## Root cause (verified on synced `origin/develop` across repos)

`packages/orchestrator/src/activation/index.ts` `activate()`:
1. If a **key file** exists → skip activation.
2. Else → `requestDeviceCode()` (mint fresh) → print "Cluster Activation Required, enter code" → `pollForApproval(device_code)`.

There is **no branch that consumes a pre-approved code**. The only env vars the activation path reads are `GENERACY_PROJECT_ID` (URL) and `GENERACY_RELAY_URL`/`GENERACY_CLOUD_URL` + `keyFilePath` (config loader). Codebase-wide there are **zero readers** of `GENERACY_PRE_APPROVED_ACTIVATION_CODE` — only writers (generacy-cloud cloud-init + the `scaffoldEnvFile` scaffolder). The cluster-base entrypoint doesn't redeem it or pre-seed a key file either.

On the producing side (generacy-cloud), `preApproveActivationCode` mints `{userCode, deviceCode, clusterId, apiKey}` and approves it, but cloud-deploy keeps only `userCode` — `apiKey` and `deviceCode` are discarded (companion issue: generacy-ai/generacy-cloud).

## Proposed fix (recommended: B)

- **A — deliver the key file:** the deploy writes the pre-minted `apiKey` (already produced by `preApproveActivationCode`) into the orchestrator's `keyFilePath` (+ `cluster.json` metadata). Zero orchestrator change — the existing "existing key → skip activation" path handles it. ⚠️ Puts the long-lived API key into cloud-init `user_data` (DO persists/retrieves it) — secret exposure.
- **B (recommended) — redeem a pre-approved device code:** the deploy delivers the pre-approved **`device_code`** (currently discarded) to the orchestrator (e.g. `GENERACY_PRE_APPROVED_DEVICE_CODE`). `activate()`, when it's set and no key file exists, **skips `requestDeviceCode` and calls `pollForApproval` with the provided device code directly** — `/device-code/poll` already returns the key for an approved code, so it redeems immediately. Reuses the existing endpoint; only the short-lived, single-use device code is baked in (not the API key); the `user_code` stays for human display only.
- **C — user-code redemption endpoint:** add a server endpoint to exchange an approved `user_code` → key; more surface, unnecessary given B reuses the poll path.

Apply the same consumption in the `scaffoldEnvFile`/scaffolder path so `generacy launch`/`deploy` benefit too.

## Acceptance criteria

- [ ] A deploy that supplies a pre-approved code activates **without human interaction** (no `Cluster Activation Required` prompt; `orchestratorVersion` flips off `device-flow`, `lastSeen` advances).
- [ ] Interactive device-code flow still works when no pre-approved code is supplied.
- [ ] The API key is not written into cloud-init `user_data` (assuming Design B).

Companion (delivery side): generacy-ai/generacy-cloud — cloud-deploy discards the pre-approved `apiKey`/`deviceCode`. Context: this is the last blocker after the cloud-init/compose fixes (generacy-cloud #778, #781, #782).

## Clarifications

Decisions resolved via `/clarify` (2026-06-02) — see [clarifications.md](./clarifications.md) for full rationale.

- **Env var name**: `GENERACY_PRE_APPROVED_DEVICE_CODE` (RFC 8628 terminology). Sibling `GENERACY_PRE_APPROVED_ACTIVATION_CODE` (the display-only `user_code`) is being removed from rendered env per generacy-cloud#783 Q3, so naming is unambiguous.
- **Post-redemption cleanup**: After the orchestrator persists the activation key file, it `delete process.env.GENERACY_PRE_APPROVED_DEVICE_CODE`. Defense-in-depth against accidental env/heap dumps; not a substitute for server-side single-use enforcement (the value still lives in `/opt/generacy/.env` on disk). The orchestrator must not log the device code.
- **Redemption failure behavior**: Distinguish failure modes.
  - *Transient* (5xx, network error): bounded retry of `pollForApproval` (~3× with backoff) before giving up.
  - *Terminal* (`expired`, `already_redeemed`, invalid): stop retrying and fall back to the interactive device-code flow (mint a fresh code, print the activation prompt).
  - Do **not** push a relay `error` event on failure: the relay channel does not exist until activation succeeds. Do **not** fail-fast/exit: a restart re-reads the same expired code from `.env` and crash-loops. Cloud-visible signal is already provided by generacy-cloud's Droplet poller (`provisioningStatus: failed`, reason `activation_timeout`, ~15 min).
- **CLI surface**: No `--pre-approved-device-code` flag on `generacy launch` / `generacy deploy`. Value flows from `LaunchConfig.preApprovedDeviceCode` (cloud-provided) into the scaffolded `.env`. Operators wanting manual testing can export the env var directly.
- **Activation-start logging**: Stdout JSON via the existing pino logger only (`{ event: 'activation-start', mode: 'pre-approved' | 'interactive' }`). No relay event — the relay isn't connected at activation time. Visible via `docker logs` / droplet console. Cloud-side pre-auth telemetry is out of scope for this issue.

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

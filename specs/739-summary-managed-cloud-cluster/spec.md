# Feature Specification: Orchestrator Auto-Activation via Pre-Approved Device Code

**Branch**: `739-summary-managed-cloud-cluster` | **Date**: 2026-06-02 | **Status**: Draft
**Issue**: [#739](https://github.com/generacy-ai/generacy/issues/739) — *Orchestrator ignores `GENERACY_PRE_APPROVED_ACTIVATION_CODE` — managed/cloud deploys never auto-activate*

## Summary

Managed/cloud cluster deploys never auto-activate. The deploy pipeline pre-approves an activation code and bakes `GENERACY_PRE_APPROVED_ACTIVATION_CODE` into the cluster's `.env`, but the orchestrator never reads it — it always runs the interactive device-code flow, mints a fresh code, and waits for a human to approve it. For a managed deploy nobody does, so the cluster sits at "Connecting" until the code expires.

This feature teaches the orchestrator to consume a **pre-approved device code** (Design B in the issue) so cloud-deployed and CLI-deployed clusters activate without human interaction, while preserving the interactive device-code flow for first-run local/manual setups.

### Reproduced symptom

Staging droplet `574834991`: `.env` contained `GENERACY_PRE_APPROVED_ACTIVATION_CODE=VH57-EJRH`, but the orchestrator logged `Requesting device code (cycle 1/3)` and printed a different code `2RGQ-KE6A` for manual entry. After a 6-minute watch of the cluster doc, `orchestratorVersion` was stuck at the `device-flow` placeholder and `lastSeen` was frozen.

### Root cause

`packages/orchestrator/src/activation/index.ts` `activate()`:
1. If a key file exists → skip activation.
2. Else → `requestDeviceCode()` (mint fresh) → print "Cluster Activation Required, enter code" → `pollForApproval(device_code)`.

There is **no branch that consumes a pre-approved code**. Codebase-wide there are zero readers of `GENERACY_PRE_APPROVED_ACTIVATION_CODE` — only writers (generacy-cloud cloud-init + `scaffoldEnvFile`). The cluster-base entrypoint doesn't redeem it or pre-seed a key file either.

On the producing side (generacy-cloud), `preApproveActivationCode` mints `{ userCode, deviceCode, clusterId, apiKey }` and approves it, but cloud-deploy keeps only `userCode` — `apiKey` and `deviceCode` are discarded (companion: generacy-ai/generacy-cloud).

## Design

**Selected approach: Design B — Redeem a pre-approved device code.**

The deploy pipeline delivers the pre-approved `device_code` (currently discarded) to the orchestrator via a new env var (`GENERACY_PRE_APPROVED_DEVICE_CODE`). When this is set and no key file exists, `activate()` **skips `requestDeviceCode` and calls `pollForApproval` with the supplied device code directly**. The existing `/device-code/poll` endpoint already returns the API key for an approved code, so redemption happens on the first poll.

The user-facing `GENERACY_PRE_APPROVED_ACTIVATION_CODE` (the human-readable `user_code` like `VH57-EJRH`) stays for display only; it is the `device_code` that is required for redemption.

The same consumption is applied to the `scaffoldEnvFile` / scaffolder path so `generacy launch` and `generacy deploy` benefit too.

### Why not A or C

- **A — deliver the key file:** would put the long-lived API key into cloud-init `user_data` (DO persists/retrieves it) — secret exposure. Rejected.
- **C — user-code redemption endpoint:** adds new server surface; unnecessary because B reuses the existing poll path. Rejected.

## User Stories

### US1: Managed cloud cluster activates without human interaction

**As a** Generacy cloud operator deploying a managed cluster via `generacy deploy` or the cloud deploy pipeline,
**I want** the orchestrator to redeem the pre-approved activation code baked into the cluster's `.env`,
**So that** the cluster comes online automatically without anyone needing to log into the droplet and paste a code.

**Acceptance Criteria**:
- [ ] When `GENERACY_PRE_APPROVED_DEVICE_CODE` is set and no key file exists, the orchestrator does **not** call `requestDeviceCode()` and does **not** print the "Cluster Activation Required" prompt.
- [ ] The orchestrator calls `pollForApproval` with the provided device code, receives the API key, persists it to `keyFilePath`, and proceeds to relay handshake.
- [ ] Cluster doc fields `orchestratorVersion` flips off the `device-flow` placeholder and `lastSeen` advances within 60 seconds of orchestrator startup.

### US2: Local/manual setups still use interactive device-code flow

**As a** developer running a local cluster via `generacy launch` (no cloud pre-approval),
**I want** the existing interactive device-code flow to keep working,
**So that** first-time setup with no pre-approved code is unaffected.

**Acceptance Criteria**:
- [ ] When neither a key file nor `GENERACY_PRE_APPROVED_DEVICE_CODE` is set, the orchestrator runs `requestDeviceCode()` + interactive prompt unchanged.
- [ ] The "Cluster Activation Required, enter code" message and 3-cycle retry budget are preserved on the interactive path.

### US3: Pre-approved code is delivered without exposing the API key

**As a** security-conscious deployer,
**I want** only the short-lived single-use device code (not the long-lived API key) baked into cloud-init `user_data`,
**So that** an attacker who recovers `user_data` cannot impersonate the cluster long-term.

**Acceptance Criteria**:
- [ ] No code path writes the pre-minted `apiKey` into the cluster's `.env`, cloud-init `user_data`, or `cluster.json` before activation completes.
- [ ] The device code embedded in `.env` becomes invalid after first redemption (single-use, server-enforced — out of scope here, called out for the cloud companion).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The orchestrator reads `GENERACY_PRE_APPROVED_DEVICE_CODE` from the environment during activation startup. | P1 | New env var. Distinct from `GENERACY_PRE_APPROVED_ACTIVATION_CODE` (which is the human-readable user_code). |
| FR-002 | When `GENERACY_PRE_APPROVED_DEVICE_CODE` is set and no key file exists, `activate()` skips `requestDeviceCode()` and calls `pollForApproval()` directly with the env-supplied device code. | P1 | New branch in `packages/orchestrator/src/activation/index.ts`. |
| FR-003 | On successful redemption, the orchestrator persists the API key and `cluster.json` metadata using the existing atomic write path (`persistence.ts`). | P1 | Reuse existing code; no new persistence surface. |
| FR-004 | When `GENERACY_PRE_APPROVED_DEVICE_CODE` is unset, the existing interactive device-code flow runs unchanged. | P1 | Backward compatibility for `generacy launch` local-flow and any manual setups. |
| FR-005 | When `GENERACY_PRE_APPROVED_DEVICE_CODE` is set but redemption fails (expired, already redeemed, invalid), the orchestrator logs a structured error and **falls back to the interactive flow** rather than crashing. | P2 | Lets a stale managed deploy still recover via human-in-the-loop if the deployer logs in. |
| FR-006 | The `scaffoldEnvFile` / scaffolder in `packages/generacy/src/cli/commands/cluster/scaffolder.ts` writes `GENERACY_PRE_APPROVED_DEVICE_CODE` to the generated `.env` when the value is supplied to it. | P1 | Lets `generacy launch` and `generacy deploy` benefit too; cloud companion (#TBD in generacy-cloud) will also use it. |
| FR-007 | The `LaunchConfig` schema accepts an optional `preApprovedDeviceCode?: string` field so the CLI deploy path can carry it from cloud → scaffolder → `.env`. | P1 | `packages/generacy/src/cli/commands/launch/types.ts`. |
| FR-008 | Activation log lines clearly distinguish "redeeming pre-approved device code" from "requesting new device code" so on-call can diagnose at a glance. | P2 | Structured log fields: `{ event: 'activation-start', mode: 'pre-approved' \| 'interactive' }`. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Managed cloud deploy auto-activates without human interaction. | 100% of deploys with a valid pre-approved device code reach `connected` state within 60s of container start. | Cloud-deploy E2E: fresh droplet, watch cluster doc's `lastSeen` field. |
| SC-002 | Interactive flow remains intact. | 100% of `generacy launch` runs without `--pre-approved` continue to show the device-code prompt. | Manual smoke test on local `generacy launch`. |
| SC-003 | No API key in cloud-init `user_data`. | Zero occurrences of the API key value in DO droplet `user_data` retrieval response. | Inspect `user_data` after a deploy; grep for the key prefix. |
| SC-004 | Stale/expired pre-approved code does not brick the orchestrator. | Container does not crash; falls back to interactive flow and logs `pre-approved-redemption-failed`. | Deliberately stale code in `.env`; confirm orchestrator still listens on `/health`. |

## Assumptions

- The cloud `/api/clusters/device-code/poll` endpoint accepts a device code that was pre-approved out-of-band and returns the API key on the first call (no waiting period needed). This is the **existing** behavior — Design B explicitly relies on it.
- `pollForApproval` in `packages/activation-client` does not require having first called `requestDeviceCode` in the same process — it just needs the `device_code` string. (Verified in `packages/activation-client/src/poller.ts`.)
- The cloud companion (generacy-ai/generacy-cloud) will be updated to deliver `deviceCode` alongside `userCode` in the cloud-init payload and `LaunchConfig`. This spec covers only the **consumer** side (orchestrator + scaffolder).
- Single-use enforcement (a device code can be redeemed at most once) is already enforced server-side by `/device-code/poll` — out of scope for this spec.

## Out of Scope

- Cloud-side changes to `preApproveActivationCode` / cloud-deploy to stop discarding `deviceCode` (tracked separately in generacy-ai/generacy-cloud).
- Removing or renaming `GENERACY_PRE_APPROVED_ACTIVATION_CODE` (the human-readable `user_code`). It stays for display/debugging.
- A new server endpoint for `user_code` → key exchange (Design C, explicitly rejected).
- Delivering the pre-minted API key via the key file (Design A, explicitly rejected — secret exposure).
- Cluster-base entrypoint changes beyond what's needed to pass the env var through (`docker-compose.yml` already propagates `.env`).

## Open Questions

- Should the orchestrator clear `GENERACY_PRE_APPROVED_DEVICE_CODE` from its own environment after a successful redemption (defense-in-depth against re-use)? Likely yes — clarify in `/speckit:clarify`.
- Should we add a `--pre-approved-device-code` CLI flag to `generacy launch` / `generacy deploy` for manual testing, or rely on the env var only? Clarify in `/speckit:clarify`.

---

*Generated by speckit*

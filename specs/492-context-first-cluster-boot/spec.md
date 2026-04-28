# Feature Specification: Cluster-side device-flow activation client

**Branch**: `492-context-first-cluster-boot` | **Date**: 2026-04-28 | **Status**: Draft

## Summary

On first cluster boot, the cluster has no API key and cannot authenticate to the relay. This feature adds an OAuth-style device-flow activation client to the orchestrator startup path. The cluster requests a device code from the cloud, displays it to the operator, polls for approval, and persists the resulting long-lived cluster API key. This runs **before** any relay handshake attempt.

Architecture reference: [docs/dev-cluster-architecture.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/dev-cluster-architecture.md) — "Onboarding flows" and "Cluster authentication to the relay".

## Scope

Add a new module at `packages/orchestrator/src/activation/` invoked from the orchestrator's main entry before relay-client construction. Behavior:

1. Check for `/var/lib/generacy/cluster-api-key` (mode 0600, owned by `node` uid). If present, skip activation and proceed.
2. If absent, call `POST {GENERACY_CLOUD_URL}/api/clusters/device-code`. Receive `{device_code, user_code, verification_uri, interval, expires_in}`.
3. Print to stdout in a clearly-formatted block:
   ```
   Cluster activation required.
   Visit: https://generacy.ai/cluster-activate?code=ABCD-1234
   Or enter code manually: ABCD-1234
   ```
4. Poll `POST .../device-code/poll {device_code}` at `interval`-second cadence (with `slow_down` honored). Bound by `expires_in`.
5. On `approved`, persist `cluster_api_key` to `/var/lib/generacy/cluster-api-key` (atomic write, mode 0600). Persist `cluster_id`, `project_id`, `org_id`, `cloud_url` to a non-secret companion file `/var/lib/generacy/cluster.json`.
6. Idempotent re-activation: if the key file is missing on subsequent boots (e.g. user blew away the volume), restart at step 2.

## User Stories

### US1: First-time cluster operator activation

**As a** cluster operator deploying Generacy for the first time,
**I want** the orchestrator to guide me through a device-code activation flow,
**So that** the cluster obtains its API key and can authenticate to the relay without manual configuration.

**Acceptance Criteria**:
- [ ] Clear activation instructions are printed to stdout with the verification URL and user code
- [ ] The orchestrator blocks until activation is approved or the code expires
- [ ] After approval the cluster API key is persisted and the orchestrator proceeds to relay handshake

### US2: Returning cluster operator (key already provisioned)

**As a** cluster operator rebooting an already-activated cluster,
**I want** the orchestrator to detect the existing API key and skip the activation flow,
**So that** boot is fast and requires no manual intervention.

**Acceptance Criteria**:
- [ ] Presence of `/var/lib/generacy/cluster-api-key` causes activation to be skipped entirely
- [ ] Boot proceeds directly to relay handshake

### US3: Re-activation after key loss

**As a** cluster operator who has lost the API key (e.g. volume wipe),
**I want** the activation flow to restart automatically on next boot,
**So that** the cluster can recover without manual debugging.

**Acceptance Criteria**:
- [ ] Missing key file triggers the device-code flow again (idempotent)
- [ ] New key is persisted exactly as on first boot

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Check for existing API key file at `/var/lib/generacy/cluster-api-key` on boot | P1 | Skip activation if present |
| FR-002 | Request device code from `POST {GENERACY_CLOUD_URL}/api/clusters/device-code` | P1 | Returns `device_code`, `user_code`, `verification_uri`, `interval`, `expires_in` |
| FR-003 | Print activation instructions to stdout with verification URI and user code | P1 | Must never log the API key |
| FR-004 | Poll `POST .../device-code/poll` at server-specified interval | P1 | Honor `slow_down` response by increasing interval |
| FR-005 | Persist `cluster_api_key` via atomic write with mode 0600 | P1 | Temp-file + rename pattern |
| FR-006 | Persist `cluster_id`, `project_id`, `org_id`, `cloud_url` to `/var/lib/generacy/cluster.json` | P1 | Non-secret companion metadata |
| FR-007 | Fail fast with clear error if `GENERACY_CLOUD_URL` is unreachable beyond retry budget | P1 | Bounded retries with backoff |
| FR-008 | Fail clearly when device code expires before approval | P2 | Print instructions to re-run |
| FR-009 | Module location: `packages/orchestrator/src/activation/` | P1 | Invoked before relay-client construction |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | First-boot activation completes | Device-code flow succeeds end-to-end | Integration test against fake cloud server |
| SC-002 | Reboot skips activation | Key detected, no cloud calls made | Unit test verifying early return |
| SC-003 | Re-activation after key deletion | Flow restarts and succeeds | Integration test deleting key file between runs |
| SC-004 | `slow_down` honored | Poll interval increases when server requests it | Integration test with slow_down response |
| SC-005 | Expired code handled | Clear error message, no crash | Integration test with expired device code |
| SC-006 | API key never logged | Key absent from all stdout/stderr output | Test assertion scanning captured output |

## Assumptions

- `GENERACY_CLOUD_URL` environment variable is always set in the cluster environment
- The cloud API endpoints (`/api/clusters/device-code` and `/api/clusters/device-code/poll`) are available and stable
- The orchestrator process runs as `node` uid with write access to `/var/lib/generacy/`
- The relay client constructor accepts the API key (loaded from file) after activation completes

## Out of Scope

- Cloud-side implementation of the device-code endpoints
- UI for the approval page at `verification_uri`
- Key rotation or expiry of the long-lived cluster API key
- Multi-cluster management from a single approval flow
- Encryption-at-rest for the key file beyond filesystem permissions

---

*Generated by speckit*

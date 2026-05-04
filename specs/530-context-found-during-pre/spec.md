# Feature Specification: Complete Cluster Control-Plane Lifecycle Handlers

Fix schema mismatch and implement missing lifecycle handlers that block the bootstrap wizard end-to-end flow.

**Branch**: `530-context-found-during-pre` | **Date**: 2026-05-04 | **Status**: Draft

## Summary

The cluster control-plane lifecycle is incomplete in two ways blocking the bootstrap wizard:
1. **Schema mismatch**: cloud allows 5 lifecycle actions but cluster-side `LifecycleActionSchema` only allows 3, causing `UNKNOWN_ACTION` errors for `set-default-role` and `stop`.
2. **Stub handlers**: `clone-peer-repos` returns 200 OK but does no work and emits no events, causing the wizard to hang indefinitely waiting for `cluster.bootstrap` SSE events.

## Context

Found during pre-staging integration sweep after #485 + #528 merged. The cluster control-plane lifecycle is incomplete in two ways that block bootstrap wizard end-to-end:

1. **Schema mismatch with cloud**: cloud-side `services/api/src/routes/clusters/lifecycle.ts` allows five actions (`clone-peer-repos`, `set-default-role`, `code-server-start`, `code-server-stop`, `stop`); cluster-side `LifecycleActionSchema` only allows three. **Wizard step 3 (Role selection) posts `set-default-role` → cluster returns `UNKNOWN_ACTION` and the wizard fails.**

2. **Stub handlers**: `lifecycle.ts:47-48` falls through to `{ accepted: true, action }` for any non-code-server action, with no actual work. **Wizard step 4 (Peer repos) posts `clone-peer-repos`, gets a 200 OK, then waits for `cluster.bootstrap` SSE events that never arrive — wizard hangs indefinitely.**

Even after fixing the schema, role-selection would silently no-op (no write to `.generacy/config.yaml`).

## Files

- `packages/control-plane/src/schemas.ts` — add `'set-default-role'` and `'stop'` to `LifecycleActionSchema` enum (currently 3 entries; should be 5 to match cloud's `ALLOWED_LIFECYCLE_ACTIONS`).
- `packages/control-plane/src/routes/lifecycle.ts` — replace stub fall-through with real handlers for `clone-peer-repos` and `set-default-role`. `stop` can stay a stub for v1.5 (cloud-only, lower priority).
- `packages/control-plane/src/services/` — likely a new `peer-repo-cloner.ts` and `default-role-writer.ts` (or similar), depending on factoring preference.

## Fix

### 1. Schema update

```typescript
export const LifecycleActionSchema = z.enum([
  'clone-peer-repos',
  'set-default-role',
  'code-server-start',
  'code-server-stop',
  'stop',
]);
```

### 2. `clone-peer-repos` handler

Reads peer repos list from request body (cloud forwards `repos: { primary, dev?, clone? }` derived from project metadata, or alternatively the cluster reads from `.generacy/config.yaml` / `cluster.yaml` if it persists those — verify which side has authority post-launch).

For each repo:
- Spawn `git clone <repo> /workspaces/<name>` (or wherever peer repos belong; check existing convention)
- Emit `cluster.bootstrap` event via the relay: `{ event: 'cluster.bootstrap', data: { repo, status: 'cloning' } }` at start, then `{ status: 'done' | 'failed', message? }` per repo on completion.

**Relay access pattern**: same as `TunnelHandler` (#519) — accept a `relayMessageSender` callback at boot. The orchestrator wires this in `server.ts` similar to how it wires `tunnelHandler`. Without this, the handler can't push events to the relay.

Idempotent (safe to retry per #440-Q5): existing repos at the target path skip cloning, just re-emit `done`.

### 3. `set-default-role` handler

Reads `{ role: string }` from request body. Validates the role exists in `.agency/roles/<role>.yaml` (committed by the project, not generated). Writes `defaults.role: <role>` to `.generacy/config.yaml`. Returns `{ accepted: true, action: 'set-default-role' }`.

Fail closed if role doesn't exist or config.yaml is missing.

### 4. `stop` handler

For v1.5, can stay as `{ accepted: true, action: 'stop' }` stub since the button only renders on cloud clusters and cloud-deploy testing isn't on the local-launch critical path. Real implementation (graceful orchestrator shutdown) can be a follow-up.

## Acceptance criteria

- `LifecycleActionSchema` accepts all 5 actions matching cloud's enum.
- `POST /lifecycle/set-default-role { role: 'developer' }` writes to `.generacy/config.yaml` and returns `{ accepted: true, action: 'set-default-role' }`.
- `POST /lifecycle/clone-peer-repos` clones each repo and emits per-repo `cluster.bootstrap` events on the relay channel; cloud-side SSE consumer (`services/api/src/routes/events/bootstrap.ts`) receives them.
- Role selection step in wizard advances on success.
- Peer repos step in wizard shows per-repo progress and auto-advances when all `done` (per #440-Q4 1.5s delay).
- Integration test exercises both handlers against a fake repo set; verifies events emitted in expected order.
- Idempotency: re-running `clone-peer-repos` on already-cloned set re-emits `done` events without re-cloning.

## Background

Identified during integration sweep after the previous round of fixes (#516-#521, #471-#477, plus #485 and #528) merged. This is one of the two remaining blockers for end-to-end local-launch staging testing.

## User Stories

### US1: Bootstrap Wizard Role Selection

**As a** developer setting up a new Generacy cluster,
**I want** the role selection step in the wizard to persist my chosen default role,
**So that** subsequent agent sessions use the correct credential profile without manual configuration.

**Acceptance Criteria**:
- [ ] `POST /lifecycle/set-default-role { role: 'developer' }` writes `defaults.role: developer` to `.generacy/config.yaml`
- [ ] Returns `{ accepted: true, action: 'set-default-role' }` on success
- [ ] Returns 400 if the specified role doesn't exist in `.agency/roles/`
- [ ] Wizard step 3 advances on success response

### US2: Bootstrap Wizard Peer Repo Cloning

**As a** developer setting up a new Generacy cluster,
**I want** the peer repos step to clone my project's repositories and show real-time progress,
**So that** my workspace is ready to use immediately after setup completes.

**Acceptance Criteria**:
- [ ] `POST /lifecycle/clone-peer-repos` clones each repo from the request body
- [ ] Per-repo `cluster.bootstrap` events emitted on the relay channel (`{ repo, status: 'cloning' }` → `{ repo, status: 'done'|'failed' }`)
- [ ] Cloud SSE consumer receives events and wizard shows per-repo progress
- [ ] Wizard auto-advances when all repos report `done` (with 1.5s delay per #440-Q4)
- [ ] Idempotent: already-cloned repos skip cloning and re-emit `done`

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Extend `LifecycleActionSchema` to 5 actions matching cloud enum | P0 | Schema: `clone-peer-repos`, `set-default-role`, `code-server-start`, `code-server-stop`, `stop` |
| FR-002 | Implement `set-default-role` handler — validate role, write config | P0 | Fail closed if role file missing |
| FR-003 | Implement `clone-peer-repos` handler — clone repos, emit events | P0 | Relay access via `relayMessageSender` callback (same pattern as TunnelHandler) |
| FR-004 | `stop` action accepted by schema but stays as stub | P2 | Cloud-only, not on local-launch critical path |
| FR-005 | Relay event emission for `cluster.bootstrap` channel | P0 | Required for wizard progress tracking |
| FR-006 | Idempotent clone behavior | P1 | Skip existing repos, re-emit `done` |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Wizard role-selection step | Advances without error | Manual E2E test |
| SC-002 | Wizard peer-repos step | Shows progress, auto-advances | Manual E2E test |
| SC-003 | Schema parity with cloud | 5/5 actions accepted | Unit test on LifecycleActionSchema |
| SC-004 | Clone idempotency | No re-clone on retry | Integration test with pre-existing repo dir |

## Assumptions

- `.agency/roles/<role>.yaml` files are committed to the project repo (not generated at runtime)
- Relay message sender is wirable via the same DI pattern used for `TunnelHandler` in #519
- Peer repos are cloned to `/workspaces/<repo-name>` (convention from existing workspace layout)
- Cloud forwards the repos list in the lifecycle request body (not read from local config)

## Out of Scope

- Real `stop` handler implementation (graceful orchestrator shutdown) — follow-up issue
- Cloud-side SSE changes (already implemented in `services/api/src/routes/events/bootstrap.ts`)
- Git authentication for private repos (handled by credhelper session env already in scope)
- Retry/backoff logic for failed clones (manual retry via wizard is acceptable for v1.5)

---

*Generated by speckit*

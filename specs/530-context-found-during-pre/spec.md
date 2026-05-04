# Feature Specification: Complete Cluster Control-Plane Lifecycle Handlers

**Issue**: [#530](https://github.com/generacy-ai/generacy/issues/530) | **Branch**: `530-context-found-during-pre` | **Date**: 2026-05-04 | **Status**: Draft

## Summary

The cluster control-plane lifecycle is incomplete in two ways that block the bootstrap wizard end-to-end:

1. **Schema mismatch**: Cloud allows 5 lifecycle actions; cluster-side `LifecycleActionSchema` only allows 3. Wizard step 3 (Role selection) posts `set-default-role` and gets `UNKNOWN_ACTION`.
2. **Stub handlers**: `clone-peer-repos` returns 200 OK but does no work; the wizard waits for `cluster.bootstrap` SSE events that never arrive and hangs indefinitely.

This is one of two remaining blockers for end-to-end local-launch staging testing.

## User Stories

### US1: Bootstrap wizard role selection

**As a** developer using the Generacy bootstrap wizard,
**I want** the role selection step to persist my chosen default role to cluster config,
**So that** the wizard advances past step 3 and my subsequent agent sessions use the correct credential role.

**Acceptance Criteria**:
- [ ] `POST /lifecycle/set-default-role { role: 'developer' }` writes `defaults.role: developer` to `.generacy/config.yaml`
- [ ] Returns `{ accepted: true, action: 'set-default-role' }`
- [ ] Fails closed with error if role doesn't exist in `.agency/roles/<role>.yaml`
- [ ] Wizard step 3 advances on success

### US2: Bootstrap wizard peer repo cloning

**As a** developer using the Generacy bootstrap wizard,
**I want** the peer repos step to clone all project repos and show per-repo progress,
**So that** my workspace is fully set up and the wizard auto-advances when all repos are cloned.

**Acceptance Criteria**:
- [ ] `POST /lifecycle/clone-peer-repos` clones each repo to `/workspaces/<name>`
- [ ] Emits `cluster.bootstrap` events via relay: `{ repo, status: 'cloning' }` at start, `{ status: 'done' | 'failed' }` on completion
- [ ] Cloud-side SSE consumer receives events; wizard shows per-repo progress
- [ ] Wizard auto-advances when all repos report `done` (per #440-Q4 1.5s delay)
- [ ] Idempotent: re-running on already-cloned repos re-emits `done` without re-cloning

### US3: Schema parity with cloud

**As a** cloud service forwarding lifecycle actions to the cluster,
**I want** the cluster to accept all 5 lifecycle actions (`clone-peer-repos`, `set-default-role`, `code-server-start`, `code-server-stop`, `stop`),
**So that** requests don't fail with `UNKNOWN_ACTION`.

**Acceptance Criteria**:
- [ ] `LifecycleActionSchema` accepts all 5 actions matching cloud's `ALLOWED_LIFECYCLE_ACTIONS`
- [ ] `stop` action returns stub response `{ accepted: true, action: 'stop' }` (real impl deferred)

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Update `LifecycleActionSchema` to include all 5 actions | P0 | `schemas.ts` — add `set-default-role` and `stop` |
| FR-002 | Implement `set-default-role` handler | P0 | Validate role exists in `.agency/roles/`, write to `.generacy/config.yaml` |
| FR-003 | Implement `clone-peer-repos` handler | P0 | Spawn `git clone` per repo, emit relay events |
| FR-004 | Wire relay message sender into control-plane | P0 | Same pattern as `TunnelHandler` (#519) — constructor DI of `RelayMessageSender` |
| FR-005 | Emit `cluster.bootstrap` events per repo | P0 | `{ event: 'cluster.bootstrap', data: { repo, status } }` |
| FR-006 | Idempotent clone-peer-repos | P1 | Skip cloning if target path exists, re-emit `done` |
| FR-007 | `stop` stub handler | P2 | Return accepted response, real shutdown deferred |

## Files

- `packages/control-plane/src/schemas.ts` — add `'set-default-role'` and `'stop'` to `LifecycleActionSchema`
- `packages/control-plane/src/routes/lifecycle.ts` — replace stub fall-through with real handlers
- `packages/control-plane/src/services/peer-repo-cloner.ts` — new: git clone logic + relay event emission
- `packages/control-plane/src/services/default-role-writer.ts` — new: role validation + config.yaml write

## Design Details

### Schema update

```typescript
export const LifecycleActionSchema = z.enum([
  'clone-peer-repos',
  'set-default-role',
  'code-server-start',
  'code-server-stop',
  'stop',
]);
```

### Relay access pattern

Same as `TunnelHandler` (#519): accept a `RelayMessageSender` callback via constructor DI. The orchestrator wires this in `server.ts` similar to how it wires `tunnelHandler`.

### `set-default-role` handler

- Reads `{ role: string }` from request body
- Validates role exists at `.agency/roles/<role>.yaml`
- Writes `defaults.role: <role>` to `.generacy/config.yaml`
- Fails closed if role file doesn't exist or config is missing

### `clone-peer-repos` handler

- Reads repos list from request body (`repos: { primary, dev?, clone? }`)
- For each repo: spawn `git clone <repo> /workspaces/<name>`
- Emit start/done/failed events via relay per repo
- Idempotent: existing repos at target path skip cloning, re-emit `done`

### `stop` handler

- v1.5 stub: returns `{ accepted: true, action: 'stop' }`
- Real graceful orchestrator shutdown deferred to follow-up

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Wizard step 3 (role selection) completes | 100% success | Manual + integration test |
| SC-002 | Wizard step 4 (peer repos) completes | 100% success | Manual + integration test with fake repo set |
| SC-003 | No `UNKNOWN_ACTION` errors for any of the 5 lifecycle actions | Zero errors | Integration test covers all 5 actions |
| SC-004 | Idempotent re-runs don't re-clone | No duplicate clones | Integration test: run twice, verify no re-clone |

## Assumptions

- Cloud forwards `repos` in the request body for `clone-peer-repos` (not read from local config)
- Peer repos are cloned to `/workspaces/<repo-name>` following existing convention
- `.agency/roles/` directory is present and populated by the project
- Relay message sender is available at control-plane boot (wired by orchestrator)

## Out of Scope

- Real `stop` handler (graceful orchestrator shutdown) — deferred to follow-up
- Cloud-deploy testing of the `stop` action
- Convergence of `clone-peer-repos` with any existing workspace provisioning logic
- Retry logic for failed clones beyond idempotent re-run

---

*Generated by speckit*

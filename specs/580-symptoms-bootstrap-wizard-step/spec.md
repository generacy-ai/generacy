# control-plane: GET /roles (list) endpoint + real role reads

**Branch**: `580-symptoms-bootstrap-wizard-step` | **Date**: 2026-05-11 | **Status**: Draft

## Summary

Bootstrap wizard step 3 (Role Selection) returns 404 because the control-plane has no `GET /roles` list endpoint. Additionally, the existing `GET /roles/:id` handler returns a hardcoded stub instead of reading `.agency/roles/<id>.yaml` from disk. Both must be fixed so the wizard can display available roles and the user can proceed past step 3.

## Symptoms

- Wizard step 3 fails with `Request failed (404)` on load.
- Console shows 404 for `api-staging.generacy.ai/.../control-plane/roles`.
- The "Next" button is permanently disabled because no roles can be loaded or selected.

## Root Cause

The cloud wizard calls `GET /control-plane/roles` via the relay proxy. The relay correctly strips the prefix and forwards `GET /roles` to the control-plane Unix socket. But the control-plane router (`packages/control-plane/src/router.ts`) only has routes for `GET /roles/:id` and `PUT /roles/:id` — no list route. The dispatch falls through to a `NOT_FOUND` error.

Secondary issue: `handleGetRole` in `packages/control-plane/src/routes/roles.ts` returns `{ id, description: 'Stub role', credentials: [] }` regardless of the requested role ID, never reading from disk.

## User Stories

### US1: Wizard lists available roles

**As a** cluster administrator running the bootstrap wizard,
**I want** the role selection step to load and display available roles from `.agency/roles/`,
**So that** I can select a default role and proceed to step 4.

**Acceptance Criteria**:
- `GET /roles` returns `{ roles: [...] }` with 200, even when the directory is empty (`{ roles: [] }`)
- Each role entry includes `id` and optional `description` parsed from the YAML file
- Wizard step 3 loads without errors

### US2: Wizard fetches individual role details

**As a** cluster administrator,
**I want** `GET /roles/:id` to return the actual role definition from `.agency/roles/<id>.yaml`,
**So that** the wizard can display role details and the selected role is real, not a stub.

**Acceptance Criteria**:
- `GET /roles/:id` reads and returns parsed YAML content from `.agency/roles/<id>.yaml`
- Returns 404 with `{ error, code: 'NOT_FOUND' }` if the role file doesn't exist
- Response includes `id`, `description`, and `credentials` array from the YAML

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add `GET /roles` route to `router.ts` mapping to `handleListRoles` | P0 | Unblocks wizard step 3 |
| FR-002 | Implement `handleListRoles` — reads `.agency/roles/*.yaml`, returns `{ roles: [{ id, description? }] }` | P0 | ENOENT returns `{ roles: [] }`, not error |
| FR-003 | Rewrite `handleGetRole` to read `.agency/roles/<id>.yaml` from disk | P1 | Currently returns hardcoded stub |
| FR-004 | `handleGetRole` returns 404 for missing role files | P1 | Match credential handler pattern |
| FR-005 | Agency dir resolved via `CREDHELPER_AGENCY_DIR` env var with `.agency` fallback | P1 | Consistent with `credentials.ts` pattern |

## Design

### Agency dir resolution

Use the same pattern as `credentials.ts:24`: `process.env['CREDHELPER_AGENCY_DIR'] ?? '.agency'`. The roles dir is `path.join(agencyDir, 'roles')`.

### `handleListRoles` implementation

- Read directory entries from `<agencyDir>/roles/`
- Filter to `.yaml` files only
- For each file: parse YAML, extract `description` field
- If individual file fails to parse, include the role with `id` only (graceful degradation)
- If roles directory doesn't exist (ENOENT), return `{ roles: [] }`
- Response: `{ roles: Array<{ id: string; description?: string }> }`

### `handleGetRole` rewrite

- Read `<agencyDir>/roles/<id>.yaml`
- Parse YAML, return `{ id, description?, credentials? }` (matching current stub shape)
- If file doesn't exist, return 404 with `{ error, code: 'NOT_FOUND' }`
- If file fails to parse, return 500 with `{ error, code: 'INTERNAL_ERROR' }`

### Router addition

Add before the existing `GET /roles/:id` route (list before detail):

```typescript
{ method: 'GET', pattern: /^\/roles$/, paramNames: [], handler: handleListRoles },
```

## Considerations

- **Empty-state UX**: When `roles: []`, the wizard disables "Next". The intended flow is for the wizard to show baked-in role recipes client-side and PUT the chosen recipe via `PUT /control-plane/roles/:id`. This is a cloud-side UX concern, out of scope for this fix.
- **Wizard mode**: During bootstrap (`GENERACY_BOOTSTRAP_MODE=wizard`), the workspace may not be cloned yet. `.agency/roles/` likely doesn't exist. The list endpoint handles ENOENT gracefully.
- **`PUT /roles/:id`**: Currently a stub (accepts body, returns `{ ok: true }`, doesn't persist). Not in scope for this issue — the wizard's PUT flow works independently once the role recipe is chosen.

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `GET /roles` returns 200 | Always (even empty dir) | Unit test |
| SC-002 | `GET /roles/:id` returns real YAML data | When file exists | Unit test |
| SC-003 | `GET /roles/:id` returns 404 for missing role | When file absent | Unit test |
| SC-004 | No 404 errors in wizard step 3 console | Zero errors | Manual E2E verification |

## Test Plan

- [ ] Unit: `GET /roles` with empty/missing agency dir returns `{ roles: [] }` (200, not 404)
- [ ] Unit: `GET /roles` with `.agency/roles/reviewer.yaml` present returns `{ roles: [{ id: 'reviewer', description: ... }] }`
- [ ] Unit: `GET /roles` with malformed YAML file still includes role with `id` only
- [ ] Unit: `GET /roles/reviewer` with file present returns parsed YAML content
- [ ] Unit: `GET /roles/nonexistent` returns 404 with `NOT_FOUND` code
- [ ] E2E: wizard step 3 loads without error

## Out of Scope

- `PUT /roles/:id` persistence (currently a stub, separate follow-up)
- Cloud-side empty-state UX / recipe picker behavior
- Credential list endpoint (not requested in this issue)

## Related

- #572 (cluster <-> cloud contract consolidation umbrella)
- #574 / cluster-base#24 (control-plane bootstrap)
- #577 (relay bridge initialization with control-plane routing)

---

*Generated by speckit*

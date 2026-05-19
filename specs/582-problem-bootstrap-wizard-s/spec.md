# Feature Specification: ## Problem

The bootstrap wizard's step 3 ("Role Selection") asks the user to pick a "default role" for the cluster and persists it via a \`set-default-role\` lifecycle action on the control-plane

**Branch**: `582-problem-bootstrap-wizard-s` | **Date**: 2026-05-11 | **Status**: Draft

## Summary

## Problem

The bootstrap wizard's step 3 ("Role Selection") asks the user to pick a "default role" for the cluster and persists it via a \`set-default-role\` lifecycle action on the control-plane. This is conceptually wrong.

In the agency model, roles are:
- **Per-workspace**, defined as YAML files in \`.agency/roles/\` (checked into the user's repo)
- **Per-workflow**, selected at spawn time — workflows declare which role they need, and the credhelper-daemon's [\`loadRole(roleId)\`](packages/credhelper-daemon/bin/credhelper-daemon.ts#L63-L68) hands back the matching \`RoleConfig\`

There is no "cluster default role" anywhere else in the system. The wizard step and its supporting cluster-side endpoints are a layer of configuration that doesn't correspond to anything real.

Originally surfaced when the wizard 404'd on \`GET /control-plane/roles\` (#580). The reflex was to add the missing list endpoint. The correct fix is to remove the step.

## What to remove

**generacy-cloud / web:**
- [\`packages/web/src/components/clusters/bootstrap/steps/RoleSelectionStep.tsx\`](https://github.com/generacy-ai/generacy-cloud/blob/main/packages/web/src/components/clusters/bootstrap/steps/RoleSelectionStep.tsx) — delete
- [\`packages/web/src/components/clusters/bootstrap/steps/__tests__/RoleSelectionStep.test.tsx\`](https://github.com/generacy-ai/generacy-cloud/blob/main/packages/web/src/components/clusters/bootstrap/steps/__tests__/RoleSelectionStep.test.tsx) — delete
- [\`packages/web/src/components/clusters/bootstrap/BootstrapWizard.tsx\`](https://github.com/generacy-ai/generacy-cloud/blob/main/packages/web/src/components/clusters/bootstrap/BootstrapWizard.tsx) — drop step 3 from the step array, renumber (5 → 4 steps), update step indicator labels
- [\`packages/web/src/lib/hooks/use-cluster-roles.ts\`](https://github.com/generacy-ai/generacy-cloud/blob/main/packages/web/src/lib/hooks/use-cluster-roles.ts) — delete (only the wizard step consumes it)

**generacy-cloud / api:**
- [\`services/api/src/routes/clusters/roles.ts\`](https://github.com/generacy-ai/generacy-cloud/blob/main/services/api/src/routes/clusters/roles.ts) — delete the \`PUT /:roleId\` forwarder route and its registration in \`index.ts\`
- Tests under \`services/api/src/__tests__/routes/clusters/roles.test.ts\` — delete

**generacy / control-plane:**
- [\`packages/control-plane/src/routes/roles.ts\`](packages/control-plane/src/routes/roles.ts) — delete
- [\`packages/control-plane/src/router.ts\`](packages/control-plane/src/router.ts) — remove the two \`/roles/:id\` route entries
- [\`packages/control-plane/src/services/default-role-writer.ts\`](packages/control-plane/src/services/default-role-writer.ts) — delete
- [\`packages/control-plane/src/routes/lifecycle.ts\`](packages/control-plane/src/routes/lifecycle.ts) — remove the \`set-default-role\` action branch and the \`setDefaultRole\` import
- [\`packages/control-plane/src/schemas.ts\`](packages/control-plane/src/schemas.ts) — drop \`set-default-role\` from the lifecycle action enum and the related body schema

## What NOT to touch

- [\`packages/web/src/app/org/[orgId]/settings/roles/\`](https://github.com/generacy-ai/generacy-cloud/tree/main/packages/web/src/app/org/[orgId]/settings/roles) — org-level role catalog management is a separate concern, leave it alone.
- [\`packages/web/src/components/roles/role-recipes.ts\`](https://github.com/generacy-ai/generacy-cloud/blob/main/packages/web/src/components/roles/role-recipes.ts) — recipes are used by the org settings page; leave them.
- credhelper-daemon's role loading from \`.agency/roles/\` — this is the correct, workspace-level path; leave it.

## Test plan
- [ ] After change: launch a fresh cluster, hit bootstrap wizard, verify there are 4 steps (not 5) and step 3 is now "Peer Repos"
- [ ] Existing wizard tests pass with the updated step count
- [ ] No remaining references to \`useClusterRoles\`, \`setDefaultRole\`, \`set-default-role\`, or \`handleGetRole\` / \`handlePutRole\` in the codebase (\`grep\` clean)

## Related
- Supersedes #580 (and PR #581, both closed)
- #572 (cluster ↔ cloud contract consolidation umbrella)

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

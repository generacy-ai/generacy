# Feature Specification: Update VS Code Extension Pricing Tiers

Update the generacy VS Code extension to reflect the new pricing model by replacing old tier names (starter/team), old prices ($49/$99), old min seat values (3/5), and upgrade flow logic.

**Branch**: `420-summary-generacy-vs-code` | **Date**: 2026-04-05 | **Status**: Draft

## Summary

The generacy VS Code extension still has old tier names (starter/team), old prices ($49/$99), old min seat values (3/5), and upgrade flow logic referencing the old tier structure. These need to be updated to match the new pricing model that has already been deployed to the latency, generacy-cloud, and orchestrator services.

## New Pricing Model (per-seat limits)

| Tier | Price | Active Clusters | Concurrent Workflows | Cloud UI |
|------|-------|----------------|----------------------|----------|
| Free | $0 (1 seat) | 1 | 1 | No |
| Basic | $20/seat/mo | 2 | 2 | Yes |
| Standard | $50/seat/mo | 3 | 5 | Yes |
| Professional | $100/seat/mo | 4 | 10 | Yes |
| Enterprise | Custom | Unlimited | Unlimited | Yes |

- All tiers: 1 seat minimum, unlimited projects
- Limits are per-seat (individual), not shared

## Files to Update

### `packages/generacy-extension/src/api/types.ts`
- Update `type OrgTier = 'starter' | 'team' | 'enterprise'` → `'free' | 'basic' | 'standard' | 'professional' | 'enterprise'`
- Update `z.enum(['starter', 'team', 'enterprise'])` → `z.enum(['free', 'basic', 'standard', 'professional', 'enterprise'])`

### `packages/generacy-extension/src/api/endpoints/orgs.ts`
- `getTierLimits()` — update cases:
  - Add `'free'` case (1 workflow, 1 cluster)
  - `'starter'` → `'basic'` (2 workflows, 2 clusters)
  - `'team'` → `'standard'` (5 workflows, 3 clusters)
  - Add `'professional'` case (10 workflows, 4 clusters)
- `getTierDisplayName()` — update display names for all tiers
- `getTierPricing()` — update pricing:
  - `'basic'` → `$20/seat/month`
  - `'standard'` → `$50/seat/month`
  - `'professional'` → `$100/seat/month`
  - Remove old min seat references (all tiers min 1)

### `packages/generacy-extension/src/views/cloud/dashboard/webview.ts`
- Update upgrade suggestion logic to new tier progression: basic → standard → professional → enterprise
- Update display text to new tier names
- Update tier comparison logic for upgrade prompts

## User Stories

### US1: Organization Admin Sees Correct Pricing

**As an** organization admin viewing the dashboard in VS Code,
**I want** to see the correct tier names and pricing for my organization,
**So that** I can make informed upgrade decisions based on accurate information.

**Acceptance Criteria**:
- [ ] Tier names display as Free/Basic/Standard/Professional/Enterprise
- [ ] Pricing shows $20/$50/$100 per seat per month
- [ ] No references to old min seat counts (3, 5)

### US2: Organization Admin Gets Correct Upgrade Suggestions

**As an** organization admin who has hit a tier limit,
**I want** to be prompted to upgrade to the correct next tier,
**So that** the upgrade path matches what's available on the billing page.

**Acceptance Criteria**:
- [ ] Free tier suggests upgrading to Basic
- [ ] Basic tier suggests upgrading to Standard
- [ ] Standard suggests Professional, Professional suggests Enterprise
- [ ] Upgrade text references correct pricing

### US3: Backend Consistency

**As a** developer working on the extension,
**I want** the OrgTier type and Zod schema to match the backend tier definitions,
**So that** API responses are correctly validated and typed.

**Acceptance Criteria**:
- [ ] OrgTier type includes all 5 tiers: free, basic, standard, professional, enterprise
- [ ] Zod enum matches the OrgTier type
- [ ] No type errors when backend returns new tier names

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | OrgTier type includes all 5 tiers (free, basic, standard, professional, enterprise) | P1 | Type definition |
| FR-002 | Zod schema validates all 5 tier values | P1 | Runtime validation |
| FR-003 | getTierLimits() returns correct cluster/workflow limits for each tier | P1 | See pricing table |
| FR-004 | getTierDisplayName() returns human-readable names for all tiers | P1 | |
| FR-005 | getTierPricing() returns $20/$50/$100 with no min seat references | P1 | All tiers min 1 seat |
| FR-006 | Upgrade flow suggests correct next tier in progression | P1 | basic→standard→professional→enterprise |
| FR-007 | No remaining references to 'starter' or 'team' as tier values | P1 | Search entire extension |
| FR-008 | No remaining references to old prices ($49, $99) or old min seats (3, 5) | P1 | Search entire extension |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Zero references to old tier names | 0 occurrences of 'starter'/'team' as tier values | grep search across extension package |
| SC-002 | Zero references to old pricing | 0 occurrences of $49/$99 or min seats 3/5 | grep search across extension package |
| SC-003 | All tier functions handle 5 tiers | 5 cases in each switch statement | Code review |
| SC-004 | TypeScript compiles without errors | 0 type errors | `pnpm tsc --noEmit` |

## Context

- The latency, generacy-cloud, and orchestrator have already been updated
- See `docs/generacy-business-model-pricing.md` in tetrad-development for the full pricing model
- This is the final service to update for the pricing model migration

## Assumptions

- The backend API already returns the new tier names (free/basic/standard/professional/enterprise)
- No database migration needed — this is purely a frontend/extension update
- The enterprise tier behavior remains unchanged (custom pricing, unlimited resources)

## Out of Scope

- Billing page UI changes (handled by generacy-cloud)
- Backend API changes (already completed)
- New feature gating based on tiers (separate issue)

---

*Generated by speckit*

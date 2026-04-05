# Implementation Plan: Update VS Code Extension Pricing Tiers

**Feature**: Update generacy VS Code extension to reflect new 5-tier pricing model
**Branch**: `420-summary-generacy-vs-code`
**Status**: Complete

## Summary

Replace the old 3-tier pricing model (starter/team/enterprise) with the new 5-tier model (free/basic/standard/professional/enterprise) across the VS Code extension. This is a pure frontend/type update — the backend already serves the new tier names. Changes span type definitions, Zod schemas, tier helper functions, dashboard webview HTML generation, upgrade flow logic, tests, and README.

## Technical Context

**Language/Version**: TypeScript 5.x (VS Code extension)
**Primary Dependencies**: `vscode` API, `zod` (runtime validation)
**Storage**: N/A (reads from cloud API)
**Testing**: Vitest
**Target Platform**: VS Code 1.108.0+
**Project Type**: VS Code extension within pnpm monorepo
**Constraints**: Must match backend tier values exactly; zero references to old tier names/prices after completion

## Constitution Check

No `.specify/memory/constitution.md` found — no gates apply.

## Project Structure

### Documentation (this feature)

```text
specs/420-summary-generacy-vs-code/
├── spec.md              # Feature specification (read-only)
├── plan.md              # This file
├── research.md          # Technology decisions
├── data-model.md        # Type definitions and tier data
└── quickstart.md        # Verification steps
```

### Source Code (files to modify)

```text
packages/generacy-extension/
├── src/
│   ├── api/
│   │   ├── types.ts                                    # OrgTier type + Zod schema
│   │   └── endpoints/orgs.ts                           # getTierLimits, getTierDisplayName, getTierPricing
│   └── views/
│       └── cloud/dashboard/
│           ├── webview.ts                              # Dashboard HTML generation + upgrade logic
│           └── __tests__/webview.test.ts               # Dashboard tests
├── README.md                                           # Pricing table
└── CHANGELOG.md                                        # "starter workflows" (template category, NOT tier — leave as-is)
```

## Change Analysis

### File 1: `packages/generacy-extension/src/api/types.ts`

| Line | Current | Target |
|------|---------|--------|
| 179 | `type OrgTier = 'starter' \| 'team' \| 'enterprise'` | `type OrgTier = 'free' \| 'basic' \| 'standard' \| 'professional' \| 'enterprise'` |
| 213 | `z.enum(['starter', 'team', 'enterprise'])` | `z.enum(['free', 'basic', 'standard', 'professional', 'enterprise'])` |

### File 2: `packages/generacy-extension/src/api/endpoints/orgs.ts`

**`getTierLimits()`** — replace 3-case switch with 5-case switch:

| Tier | executionSlots | maxClusters | agentHoursPerMonth | features |
|------|---------------|-------------|-------------------|----------|
| free | 1 | 1 | 50 | GitHub integration |
| basic | 2 | 2 | 100 | GitHub integration, Basic support, Cloud UI |
| standard | 5 | 3 | 500 | All integrations, SSO, Priority support, Cloud UI |
| professional | 10 | 4 | 1000 | All integrations, SSO, Dedicated support, Cloud UI |
| enterprise | -1 (unlimited) | -1 (unlimited) | -1 (unlimited) | All integrations, SSO, Dedicated support, SLA, Custom limits |

**`getTierDisplayName()`** — add Free, Basic, Standard, Professional cases.

**`getTierPricing()`** — update pricing:

| Tier | price | description |
|------|-------|-------------|
| free | 0 | Free (1 seat) |
| basic | 20 | $20/seat/month |
| standard | 50 | $50/seat/month |
| professional | 100 | $100/seat/month |
| enterprise | null | Contact sales for pricing |

### File 3: `packages/generacy-extension/src/views/cloud/dashboard/webview.ts`

1. **CSS tier badge classes** (line 389): Replace `.tier-starter` / `.tier-team` with `.tier-free` / `.tier-basic` / `.tier-standard` / `.tier-professional`
2. **Execution slot upgrade prompt** (line 176): Update tier progression logic — suggest next tier (free→basic, basic→standard, standard→professional, professional→enterprise)
3. **Cluster upgrade prompt** (line 188): Same tier progression logic
4. **Quick Actions upgrade CTA** (lines 299-307): Replace binary starter→team / team→enterprise with full tier progression

### File 4: `packages/generacy-extension/src/views/cloud/dashboard/__tests__/webview.test.ts`

- Update `mockDashboardData` tier from `'team'` to `'standard'`
- Update billing plan name from `'Team'` to `'Standard'`
- Update `pricePerSeat` from `99` to `50`
- Update assertions that check for old tier names/values

### File 5: `packages/generacy-extension/README.md`

Update pricing table (lines 105-109) to new 5-tier model.

### Files NOT modified (false positives)

- `templates.ts`, `templates.test.ts`, `workflow.test.ts` — use `category: 'starter'` for workflow template categories, unrelated to org tiers
- `CHANGELOG.md` — "starter workflows" refers to template category, not pricing tier

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| TypeScript compile errors from exhaustiveness | Low | High | Switch statements cover all 5 cases |
| Backend returns tier not in union | Low | Medium | Zod schema rejects unknown values (existing behavior) |
| Missed reference to old tier | Low | Medium | grep verification in success criteria |

## Verification Plan

1. `pnpm tsc --noEmit` in extension package — zero type errors
2. `pnpm vitest run` in extension package — all tests pass
3. `grep -rn "starter\|'team'" --include="*.ts" packages/generacy-extension/src/` returns only template-category hits
4. `grep -rn '\$49\|\$99\|min 3\|min 5' packages/generacy-extension/` returns zero hits

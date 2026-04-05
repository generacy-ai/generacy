# Data Model: Update VS Code Extension Pricing Tiers

**Feature**: #420 — Update VS Code extension pricing tiers
**Branch**: `420-summary-generacy-vs-code`

## Core Type Change

### OrgTier (types.ts:179)

```typescript
// Before
export type OrgTier = 'starter' | 'team' | 'enterprise';

// After
export type OrgTier = 'free' | 'basic' | 'standard' | 'professional' | 'enterprise';
```

### OrganizationSchema Zod enum (types.ts:213)

```typescript
// Before
tier: z.enum(['starter', 'team', 'enterprise'])

// After
tier: z.enum(['free', 'basic', 'standard', 'professional', 'enterprise'])
```

## Tier Data Tables

### Limits (per-seat)

| Tier | Concurrent Workflows (executionSlots) | Active Clusters (maxClusters) | Agent Hours/Month |
|------|--------------------------------------|------------------------------|-------------------|
| free | 1 | 1 | 50 |
| basic | 2 | 2 | 100 |
| standard | 5 | 3 | 500 |
| professional | 10 | 4 | 1000 |
| enterprise | -1 (unlimited) | -1 (unlimited) | -1 (unlimited) |

### Display Names

| Tier Value | Display Name |
|-----------|-------------|
| free | Free |
| basic | Basic |
| standard | Standard |
| professional | Professional |
| enterprise | Enterprise |

### Pricing

| Tier | Price (USD) | Description |
|------|-------------|-------------|
| free | 0 | Free (1 seat) |
| basic | 20 | $20/seat/month |
| standard | 50 | $50/seat/month |
| professional | 100 | $100/seat/month |
| enterprise | null | Contact sales for pricing |

### Features

| Tier | Features |
|------|----------|
| free | GitHub integration |
| basic | GitHub integration, Basic support, Cloud UI |
| standard | All integrations, SSO, Priority support, Cloud UI |
| professional | All integrations, SSO, Dedicated support, Cloud UI |
| enterprise | All integrations, SSO, Dedicated support, SLA, Custom limits |

### Upgrade Progression

```
free → basic → standard → professional → enterprise (terminal)
```

## Relationships

- `Organization.tier` is typed as `OrgTier` — changing the union propagates to all consumers
- `getTierLimits()`, `getTierDisplayName()`, `getTierPricing()` all accept `Organization['tier']` (= `OrgTier`)
- Webview reads tier from `OrgDashboardData.organization.tier` — no separate type needed

## Validation

- Zod `OrganizationSchema` validates API responses at runtime
- TypeScript exhaustiveness checking ensures all switch cases are covered
- No database or migration concerns — purely client-side type definitions

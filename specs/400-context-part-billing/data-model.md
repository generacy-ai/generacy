# Data Model: Display Execution Slot and Cluster Usage in Cloud Dashboard

## Modified Entities

### OrgUsage (modified)

Current fields unchanged. Two new optional fields added:

```typescript
export interface OrgUsage {
  // Existing fields (unchanged)
  periodStart: string;       // Billing period start (ISO datetime)
  periodEnd: string;         // Billing period end (ISO datetime)
  agentHoursUsed: number;    // Hours consumed this period
  agentHoursLimit: number;   // Hours limit for tier
  currentConcurrentAgents: number;  // Legacy field, kept for backwards compat

  // New fields (optional until backend lands)
  activeExecutions?: number;    // Current active execution slots (from lease system)
  connectedClusters?: number;   // Current connected cluster count
}
```

**Validation (Zod)**:
```typescript
export const OrgUsageSchema = z.object({
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  agentHoursUsed: z.number().nonnegative(),
  agentHoursLimit: z.number().positive(),
  currentConcurrentAgents: z.number().int().nonnegative(),
  activeExecutions: z.number().int().nonnegative().optional(),
  connectedClusters: z.number().int().nonnegative().optional(),
});
```

**Fallback rules**:
- `activeExecutions` → falls back to `currentConcurrentAgents` (same metric, different name)
- `connectedClusters` → falls back to `0` (new metric, no prior equivalent)

### TierLimits (modified return type of getTierLimits())

```typescript
// Before
{ concurrentAgents: number; agentHoursPerMonth: number; features: string[] }

// After
{ executionSlots: number; maxClusters: number; agentHoursPerMonth: number; features: string[] }
```

**Values per tier**:

| Tier | executionSlots | maxClusters | agentHoursPerMonth |
|------|---------------|-------------|-------------------|
| Starter | 3 | 1 | 100 |
| Team | 10 | 3 | 500 |
| Enterprise | -1 (unlimited) | -1 (unlimited) | -1 (unlimited) |

## Computed Values (frontend-only)

These are not persisted — calculated at render time in the webview:

| Value | Formula | Purpose |
|-------|---------|---------|
| `executionSlotPercent` | `min(100, active / limit * 100)` | Progress bar width |
| `clusterPercent` | `min(100, connected / limit * 100)` | Progress bar width |
| `executionSlotClass` | `>90%: critical, >75%: warning, else: normal` | Bar color |
| `clusterClass` | Same thresholds | Bar color |
| `isSlotOverage` | `active > limit && limit > 0` | Show overage text |
| `slotOverageCount` | `max(0, active - limit)` | "N completing from prior plan" |
| `isClusterOverage` | `connected > limit && limit > 0` | Show overage text |
| `clusterOverageCount` | `max(0, connected - limit)` | Overage count |

## Relationships

```
Organization (1) ──── OrgUsage (1)
     │                    │
     │ .tier              │ .activeExecutions  (→ executionSlots limit)
     │                    │ .connectedClusters (→ maxClusters limit)
     │                    │ .agentHoursUsed    (→ agentHoursPerMonth limit)
     ▼                    │
getTierLimits(tier) ──────┘  provides limits for percentage calculations
```

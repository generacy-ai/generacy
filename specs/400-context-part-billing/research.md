# Research: Display Execution Slot and Cluster Usage in Cloud Dashboard

## Technology Decisions

### 1. Optional Fields with Zod `.optional()` for Backend Compatibility

**Decision**: Add `activeExecutions` and `connectedClusters` as optional fields on `OrgUsage`, falling back to existing data.

**Rationale**: Backend issues generacy-cloud#234 and #235 are in parallel. The Zod schema's `.optional()` means the API response validates whether or not the new fields are present. The webview uses `usage.activeExecutions ?? usage.currentConcurrentAgents` for seamless transition.

**Alternative considered**: Adding stub/mock values in the API client interceptor layer. Rejected because it adds complexity and the optional-with-fallback pattern is simpler and self-documenting.

### 2. Rename `concurrentAgents` → `executionSlots` in getTierLimits()

**Decision**: Rename the field in the return type of `getTierLimits()`.

**Rationale**: Per clarification Q1, "execution slots" is the new user-facing term. The rename should flow through to all call sites so the codebase uses consistent terminology.

**Alternative considered**: Keeping `concurrentAgents` internally and only renaming in UI strings. Rejected because maintaining two names for the same concept increases confusion.

### 3. Inline Capacity Prompts vs Separate Component

**Decision**: Add capacity-specific upgrade prompts as inline HTML within `getUsageSection()`, below each progress bar.

**Rationale**: The dashboard uses raw HTML generation (no component framework). Extracting to a separate function adds overhead with no reuse benefit. The prompts are contextual to the usage bars they sit below.

**Alternative considered**: Adding prompts to the sidebar CTA. Rejected because context-specific prompts near the relevant metric are more actionable for users.

### 4. Overage Progress Bar Display

**Decision**: When usage exceeds limit, show bar at 100% fill with `critical` class, plus a text explanation.

**Rationale**: A bar exceeding 100% width would break the layout. Capping at 100% + showing the actual numbers in text ("5 of 3 slots active — 2 completing from prior plan") communicates the overage clearly.

## Implementation Patterns

### Progress Bar Pattern (existing)

```typescript
const percent = limit > 0 ? Math.min(100, (current / limit) * 100) : 0;
const barClass = percent > 90 ? 'critical' : percent > 75 ? 'warning' : 'normal';
```

### Overage Pattern (new)

```typescript
const isOverage = current > limit && limit > 0;
const overageCount = Math.max(0, current - limit);
// Bar is always capped at 100%, text shows actual numbers
const displayPercent = limit > 0 ? Math.min(100, (current / limit) * 100) : 0;
```

### Unlimited Tier Pattern (existing)

```typescript
// -1 means unlimited — skip percentage, show "X / Unlimited"
const displayLimit = limit < 0 ? 'Unlimited' : limit.toString();
const percent = limit > 0 ? Math.min(100, (current / limit) * 100) : 0;
// When unlimited, bar stays at 0% (no cap to measure against)
```

## Key Sources

- Spec: `specs/400-context-part-billing/spec.md`
- Clarifications: `specs/400-context-part-billing/clarifications.md` (Q1–Q5)
- Billing enforcement plan: `docs/billing-concurrent-workflow-enforcement.md` (in tetrad-development)
- Backend tracking: generacy-cloud#234 (lease system / activeExecutions), generacy-cloud#235 (cluster connections)

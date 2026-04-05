# Research: Update VS Code Extension Pricing Tiers

**Feature**: #420 — Update VS Code extension pricing tiers
**Branch**: `420-summary-generacy-vs-code`

## Technology Decisions

### Decision 1: No runtime migration layer needed

**Choice**: Direct replacement of tier values — no backward-compatibility shim.

**Rationale**: The backend already serves the new tier names. The extension is a client-only consumer; there is no stored local state referencing old tier names. Zod validation at the API boundary will reject any mismatched values, which is the desired behavior.

**Alternatives rejected**:
- *Migration map (`starter` → `basic`)* — unnecessary complexity since the backend cutover is already complete
- *Union of old + new types* — would hide bugs where old tier names leak through

### Decision 2: Tier progression as next-tier lookup

**Choice**: Use a simple `getNextTier()` helper or inline map for upgrade suggestions instead of hardcoded pairwise comparisons.

**Rationale**: The current code uses ad-hoc conditions like `tier === 'starter' ? 'team' : 'enterprise'`. With 5 tiers, a tier-ordering approach is cleaner and prevents missed cases.

**Pattern**:
```typescript
const TIER_ORDER: OrgTier[] = ['free', 'basic', 'standard', 'professional', 'enterprise'];
function getNextTier(current: OrgTier): OrgTier | null {
  const idx = TIER_ORDER.indexOf(current);
  return idx < TIER_ORDER.length - 1 ? TIER_ORDER[idx + 1] : null;
}
```

### Decision 3: CSS class naming follows tier values

**Choice**: `.tier-free`, `.tier-basic`, `.tier-standard`, `.tier-professional`, `.tier-enterprise`

**Rationale**: Consistent with existing pattern (`.tier-starter`, `.tier-team`, `.tier-enterprise`). Class name = tier value.

## Implementation Patterns

### Exhaustive switch statements

All three `getTier*()` functions use switch statements with no `default` case, relying on TypeScript exhaustiveness checking. This pattern must be preserved: adding the new cases and removing the old ones will cause compile errors if any case is missed.

### Webview string interpolation

The dashboard webview.ts generates HTML via template literals with inline expressions. Upgrade prompts use `onclick="upgrade('tierName')"` patterns. These must be updated to use the correct next-tier logic.

## Key Sources

- Spec: `specs/420-summary-generacy-vs-code/spec.md`
- New pricing model: `docs/generacy-business-model-pricing.md` (in tetrad-development)
- Backend tier definitions: already deployed to latency, generacy-cloud, orchestrator

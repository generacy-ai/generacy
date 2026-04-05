# Quickstart: Update VS Code Extension Pricing Tiers

**Feature**: #420 — Update VS Code extension pricing tiers
**Branch**: `420-summary-generacy-vs-code`

## Prerequisites

- Node.js and pnpm installed
- Repository cloned and on `420-summary-generacy-vs-code` branch

## Setup

```bash
pnpm install
```

## Verify Changes

### 1. TypeScript compilation (zero errors)

```bash
cd packages/generacy-extension
pnpm tsc --noEmit
```

### 2. Run tests

```bash
cd packages/generacy-extension
pnpm vitest run
```

### 3. Grep for stale references

No org-tier references to `starter` or `team` should remain in source:

```bash
# Should return ONLY template-category hits (templates.ts, workflow.test.ts), NOT tier/pricing hits
grep -rn "starter\|'team'" --include="*.ts" packages/generacy-extension/src/
```

No old pricing references:

```bash
# Should return zero results
grep -rn '\$49\|\$99\|min 3\|min 5' packages/generacy-extension/
```

## Files Modified

| File | Change |
|------|--------|
| `src/api/types.ts` | OrgTier union + Zod schema → 5 tiers |
| `src/api/endpoints/orgs.ts` | getTierLimits, getTierDisplayName, getTierPricing → 5 cases each |
| `src/views/cloud/dashboard/webview.ts` | CSS classes, upgrade prompts, tier progression |
| `src/views/cloud/dashboard/__tests__/webview.test.ts` | Mock data + assertions updated |
| `README.md` | Pricing table updated |

## Troubleshooting

**TypeScript error "not assignable to type 'OrgTier'"**: A file is still using an old tier name. Search for the literal string and update it.

**Test failure on tier badge assertion**: The CSS class and display name assertions need to match the new tier values (e.g., `tier-standard` instead of `tier-team`).

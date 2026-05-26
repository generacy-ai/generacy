# Data Model: Fix double-space in `formatTierLimitError`

**Feature**: 728-symptom-cli-s-resolver
**Phase**: 1 (Design)

## Scope

This feature is a behavioral fix to a pure formatting function. No new entities, types, schemas, or persisted data are introduced. The existing input contract is preserved verbatim — only the produced string is changed (and only in the `tier === ''` case).

## Existing Entity (Unchanged)

### `TierLimitErrorInput`

Location: `packages/activation-client/src/format-tier-limit-error.ts`

```ts
export interface TierLimitErrorInput {
  requested: number;  // Worker count the user requested (e.g. from --workers=N)
  cap: number;        // The org's tier cap (e.g. 2 for Basic)
  tier: string;       // Tier name (e.g. 'basic', 'pro'). Empty string when unknown.
}
```

**Validation rules**:
- `requested`, `cap`: non-negative integers. Not validated at runtime by the formatter (callers responsible).
- `tier`: a string. May be empty (`''`) when the caller has no tier name to supply — this is the case the fix targets.
- No `null`/`undefined` permitted by the TypeScript type. The implementation will additionally treat falsy values defensively (via `if (tier)` ternary), but this is a safety net rather than a contract.

## Output Contract

### `formatTierLimitError(input: TierLimitErrorInput): string`

| Case | `tier` value | Output |
|------|--------------|--------|
| Non-empty tier | `'basic'` | `Worker count of N exceeds your Basic plan limit of C. Upgrade your plan or retry with --workers=C.` |
| Non-empty tier | `'pro-plus'` | `Worker count of N exceeds your Pro-plus plan limit of C. ...` (title-cases first char only, unchanged) |
| **Empty tier** | `''` | `Worker count of N exceeds your plan limit of C. Upgrade your plan or retry with --workers=C.` (no double space; **new behavior**) |
| Zero cap | any | Renders `--workers=0` retry instruction. Unchanged. |

### Invariants

- The function is pure: identical input ⇒ strict-equal output. (Already asserted by `'is pure (identical input yields strict-equal output)'` test; must continue to hold.)
- The output never contains two consecutive spaces (`'  '`).
- The output always contains the `--workers=${cap}` retry hint, regardless of whether `tier` is empty.
- The output always begins with `Worker count of ${requested} exceeds your `.

## Relationships

`formatTierLimitError` has three call sites, all of which **remain unchanged**:

```text
┌─────────────────────────────────────────────────────────┐
│ packages/activation-client                              │
│   src/format-tier-limit-error.ts                        │
│     formatTierLimitError(input) ──┐                     │
└───────────────────────────────────┼─────────────────────┘
                                    │
            ┌───────────────────────┼───────────────────────┐
            │                       │                       │
            ▼                       ▼                       ▼
   ┌─────────────────┐  ┌──────────────────────┐  ┌────────────────────┐
   │ generacy CLI    │  │ orchestrator         │  │ generacy CLI       │
   │ launch command  │  │ activation flow      │  │ deploy command     │
   │                 │  │                      │  │                    │
   │ worker-count-   │  │ tier-limit-          │  │ tier-limit-        │
   │ resolver.ts     │  │ exceeded handler     │  │ exceeded handler   │
   │                 │  │                      │  │                    │
   │ passes:         │  │ passes:              │  │ passes:            │
   │ tier: ''        │  │ tier: 'basic' etc.   │  │ tier: 'basic' etc. │
   │ (THE BUG PATH)  │  │                      │  │                    │
   └─────────────────┘  └──────────────────────┘  └────────────────────┘
```

The fix lives entirely inside the producer node; no edges or downstream consumers are touched.

## Schema/Type Changes

**None.** `TierLimitErrorInput` is unchanged; the function signature is unchanged; the return type (`string`) is unchanged. This satisfies spec FR-004 (no call-site changes required).

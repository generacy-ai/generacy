# Contract: `formatTierLimitError`

**Issue**: [#726](https://github.com/generacy-ai/generacy/issues/726)
**File**: `packages/activation-client/src/format-tier-limit-error.ts` (new)
**Exported from**: `@generacy-ai/activation-client`

## Signature

```ts
export interface TierLimitErrorInput {
  requested: number;
  cap: number;
  tier: string;
}

export function formatTierLimitError(input: TierLimitErrorInput): string;
```

## Output specification

```
Worker count of <requested> exceeds your <Tier> plan limit of <cap>. Upgrade your plan or retry with --workers=<cap>.
```

Where `<Tier>` = `tier.charAt(0).toUpperCase() + tier.slice(1)`.

## Acceptance criteria

| ID  | Input                                              | Output                                                                                          |
|-----|----------------------------------------------------|-------------------------------------------------------------------------------------------------|
| F-1 | `{ requested: 8, cap: 4, tier: 'basic' }`          | `Worker count of 8 exceeds your Basic plan limit of 4. Upgrade your plan or retry with --workers=4.` |
| F-2 | `{ requested: 16, cap: 8, tier: 'pro' }`           | `Worker count of 16 exceeds your Pro plan limit of 8. Upgrade your plan or retry with --workers=8.` |
| F-3 | `{ requested: 32, cap: 16, tier: 'enterprise' }`   | `Worker count of 32 exceeds your Enterprise plan limit of 16. Upgrade your plan or retry with --workers=16.` |
| F-4 | `{ requested: 4, cap: 0, tier: 'basic' }`          | `Worker count of 4 exceeds your Basic plan limit of 0. Upgrade your plan or retry with --workers=0.` |
| F-5 | `{ requested: 2, cap: 1, tier: '' }`               | `Worker count of 2 exceeds your  plan limit of 1. Upgrade your plan or retry with --workers=1.` (degenerate — empty tier, formatter degrades gracefully) |

## Behavioral rules

1. **No validation**: trust the caller. The schema (`PollResponseSchema`) validates wire input upstream; the resolver gate validates user-flag input. The formatter is a pure string-shaping function and re-validating would duplicate work.
2. **Title-case the first character only**: `tier.charAt(0).toUpperCase() + tier.slice(1)`. Multi-word tiers degrade acceptably (`pro-plus` → `Pro-plus`).
3. **Pure function**: no side effects, no I/O, no logging. Caller decides whether to log, throw, or print.
4. **Stable output**: identical input → identical output across all callers (orchestrator, deploy, worker-count-resolver). This is the contract that eliminates wording drift (SC-002).

## Callers

| Call site                                                                                  | Use                                                                          |
|--------------------------------------------------------------------------------------------|------------------------------------------------------------------------------|
| `packages/orchestrator/src/activation/index.ts`                                            | Argument to `new ActivationError(message, 'TIER_LIMIT_EXCEEDED')`.           |
| `packages/generacy/src/cli/commands/deploy/activation.ts`                                  | Argument to `console.error(...)` before `process.exit(1)`.                   |
| `packages/generacy/src/cli/commands/launch/worker-count-resolver.ts`                       | Argument to `throw new Error(...)` in the over-cap rejection branch.         |

## Test coverage

`packages/activation-client/tests/unit/format-tier-limit-error.test.ts` (new):
- F-1 through F-3: standard tier names, exact string match.
- F-4: zero cap (boundary).
- F-5: empty tier (boundary; degrades).
- Pure-function assertion: calling the formatter twice with the same input yields strict-equal output (=== string comparison).

## Non-goals

- Localization (i18n). Single English string.
- Pluralization (`worker` vs `workers`) — message uses "Worker count of N" which reads cleanly for N=1 and N>1.
- Cloud-side validation. The cloud is the source of truth for `tier` and `cap`; the cluster side reflects them as given.
- A separate `parseTierLimitError(message): TierLimitErrorInput` reverse function (not needed; consumers already have the structured fields).

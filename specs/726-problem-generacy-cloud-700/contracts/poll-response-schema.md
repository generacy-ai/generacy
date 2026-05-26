# Contract: `PollResponseSchema` (`tier-limit-exceeded` variant)

**Issue**: [#726](https://github.com/generacy-ai/generacy/issues/726)
**File**: `packages/activation-client/src/types.ts`
**Type of change**: Additive — new discriminated-union variant.

## Wire shape (new variant)

```ts
z.object({
  status: z.literal('tier-limit-exceeded'),
  cap: z.number().int().min(0),
  requested: z.number().int().min(1),
  tier: z.string(),
})
```

## Acceptance criteria

| ID  | Behavior                                                                                                                       |
|-----|--------------------------------------------------------------------------------------------------------------------------------|
| C-1 | `PollResponseSchema.parse({ status: 'tier-limit-exceeded', cap: 4, requested: 8, tier: 'basic' })` succeeds.                   |
| C-2 | The parsed result narrows to a TypeScript type with `cap: number`, `requested: number`, `tier: string`.                        |
| C-3 | Parsing a `tier-limit-exceeded` response with missing `cap` / `requested` / `tier` throws `ZodError`.                          |
| C-4 | Parsing a `tier-limit-exceeded` response with `cap: -1` or `requested: 0` throws `ZodError`.                                   |
| C-5 | Parsing a `tier-limit-exceeded` response with non-string `tier` (e.g., number, null) throws `ZodError`.                        |
| C-6 | Parsing the four pre-existing variants (`authorization_pending`, `slow_down`, `expired`, `approved`) succeeds unchanged.        |
| C-7 | The Zod discriminated union remains the type — no shape-widening that could break the existing `switch` exhaustiveness checks.  |

## Acceptable values for `cap`

`cap` accepts `0` so the wire never blocks on a degenerate input (e.g., paused/frozen org). Display logic at the formatter doesn't special-case 0; the message reads `exceeds your Basic plan limit of 0. Upgrade your plan or retry with --workers=0.` — semantically odd but truthful, and not the failure mode we need to defend against here.

## Test coverage

`packages/activation-client/tests/unit/types.test.ts` adds at minimum:
- One positive parse case (C-1, C-2).
- One missing-field case (C-3).
- One out-of-range case (C-4).

Other cases (C-5, C-6, C-7) are covered by the existing test cases against the union or are TypeScript-checker concerns rather than runtime ones.

## Non-goals

- Validating tier-name format (the cluster side doesn't know which tier names are "valid" — the cloud is the source of truth).
- Capping `cap` upward (`z.number().int().min(0)` is sufficient; the cloud is responsible for sane values).
- Migrating any other PollResponse variant (out of scope per spec).

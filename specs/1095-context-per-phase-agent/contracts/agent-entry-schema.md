# Contract: AgentEntrySchema (extended)

**Location**: `packages/config/src/template-schema.ts` (source of truth; re-exported by `packages/generacy/src/config/schema.ts`).

## Public shape

```ts
export const AgentEntrySchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
}).strict();

export type AgentEntry = z.infer<typeof AgentEntrySchema>;
```

## Parse behavior

| Input | Result |
|-------|--------|
| `{}` | Accepted → `{}` |
| `{ provider: 'claude-code' }` | Accepted, `model` and `effort` undefined |
| `{ model: 'opus', effort: 'high' }` | Accepted, `provider` undefined |
| `{ effort: 'xhigh' }` | Accepted, other fields undefined |
| `{ effort: 'super' }` | **Rejected** — error path `.effort`, message names invalid enum value |
| `{ effort: 'HIGH' }` | **Rejected** — case-sensitive |
| `{ efort: 'high' }` | **Rejected** — `.strict()` catches typo |
| `{ provider: 'claude-code', foo: 'bar' }` | **Rejected** — `.strict()` catches unknown key |
| `{ provider: '' }` | **Rejected** — `.min(1)` |
| `{ model: null }` | **Rejected** — optional-not-nullable |

## Backward compat guarantees

- Any repo with no `effort` field parses byte-identically to today.
- Existing `provider` and `model` fields keep their `z.string().min(1).optional()` shape.
- The `.strict()` addition rejects previously-silently-stripped garbage (behavior change) but does not reject any input that was in-schema before.

## Enum vocabulary rationale

Matches the installed Claude CLI (`v2.1.150`) `--effort <level>` flag vocabulary verbatim. Fixed per spec Q2 answer A — stays stable across CLI upgrades. If a future CLI adds `ultra` or `numeric`, the schema does NOT auto-extend; a spec-level widening is required (single-source-of-truth invariant).

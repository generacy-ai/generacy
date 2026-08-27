# Contract: `resolveRoute` dependency on generacy-ai/generacy#1198

## Import

```typescript
import { resolveRoute } from '@generacy-ai/generacy-plugin-claude-code';
```

Both consumers (`collectGatewayWarnings` in `config/loader.ts` and the
`llm-gateway` doctor check's fallback-model search) use this import. Neither
defines a route classifier of its own (FR-011, Q1=A).

## Pinned signature (from #1198's spec FR-001)

```typescript
function resolveRoute(model?: string): 'subscription' | 'gateway';
```

| Input | Output |
|-------|--------|
| `undefined` | `'subscription'` |
| `'opus'` (no slash) | `'subscription'` |
| `'bifrost/claude-opus-4-7'` (contains `/`) | `'gateway'` |

#1200's spec used the loose names `anthropic \| gateway`; `anthropic` maps to
`'subscription'`. The owning sibling's naming wins.

## Block condition (Q1=A)

At implement time, run:

```bash
grep -rn "export.*resolveRoute" packages/generacy-plugin-claude-code/src/
```

- **Match found** → proceed. Also add
  `"@generacy-ai/generacy-plugin-claude-code": "workspace:*"` to
  `packages/generacy/package.json` dependencies.
- **No match** → #1198 has not shipped. This issue **blocks/requeues**. Do
  NOT define the helper, do NOT ship a local classifier.

The grep is deliberately scoped to the plugin package: the repo has an
unrelated `resolveRoute` (path-prefix dispatcher) in
`packages/cluster-relay/src/dispatcher.ts` that must not be mistaken for the
route classifier.

## Contract-shift handling

If #1198 lands with a different signature or route names, revisit plan
decision D-1 only — every other decision (D-2..D-8) is contract-agnostic.

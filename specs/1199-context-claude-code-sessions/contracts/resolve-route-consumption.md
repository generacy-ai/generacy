# Contract: `resolveRoute` consumption (orchestrator → plugin)

The orchestrator consumes — never defines — the route rule. This contract records the
shape #1199 binds against, as pinned by generacy#1198 (the export owner).

## Export

```ts
// @generacy-ai/generacy-plugin-claude-code (public index.ts export, owned by #1198)
export function resolveRoute(model?: string): 'subscription' | 'gateway';
```

- **Input**: the resolved model string for a phase (or `undefined`). Route is
  derivable from the model alone — no config or provider input needed at the
  orchestrator call sites.
- **Output**: a two-member opaque canonical string union (Q1→A). Not a structured
  object; no key extraction, no serialization.

## Consumption rules (FR-005, Q1→A)

1. **Equality**: strict `===` on the returned string. No normalization, no
   case-folding.
2. **Logging**: the string is logged verbatim in `agent.route.transition`, the
   spawn-site log, and the four direct-caller launch logs.
3. **Typing**: orchestrator types trackers/fields as
   `ReturnType<typeof resolveRoute>`; if #1198 exports a named route type, prefer it
   (re-verify at implement time after rebase).
4. **Dependency direction**: orchestrator → plugin only. The plugin MUST NOT import
   orchestrator types. The orchestrator MUST NOT reimplement or partially inline the
   classification rule (no model-prefix heuristics, no `startsWith('openrouter/')`
   shortcuts).
5. **Default semantics**: `'subscription'` is the default route; every phase of a
   gateway-free run resolves to it (SC-003 backward-compatibility anchor).

## Call sites

| Site | Input | Purpose |
|---|---|---|
| `phase-loop.ts` (after `resolveAgentForPhase`) | `nextModel` | tracker + invalidation + transition log + spawn options |
| `pr-feedback-handler.ts` | its resolved `model` | launch log field |
| `review-executor.ts` | its resolved `model` | launch log field |
| `remediate-executor.ts` | its resolved `model` | launch log field |
| `merge-conflict-handler.ts` | its resolved `model` | new launch log line |

## Test seam (D-4)

Unit tests partially mock the module:

```ts
vi.mock('@generacy-ai/generacy-plugin-claude-code', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveRoute: vi.fn(() => 'subscription'),
}));
```

- Tests steer route values per model via the mock — never by exercising #1198's real
  classification rule.
- The `'subscription'`-for-everything default is the SC-003 regression posture:
  existing phase-loop suites must stay green under it.

## Blocking status

Verified absent as of 2026-08-26 (only match repo-wide is cluster-relay's unrelated
dispatcher helper, `packages/cluster-relay/src/dispatcher.ts:19`). Implementation is
HARD-BLOCKED until #1198 merges to develop (Q4→A). Re-verify this contract against
the real export immediately after rebase.

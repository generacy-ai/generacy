# Contract: gateway-route validate warning matrix (SC-001 / SC-004)

## Function

```typescript
collectGatewayWarnings(config: GeneracyConfig, env: NodeJS.ProcessEnv = process.env): string[]
```

Called from `loadConfigWithWarnings` alongside `collectEffortWarnings`
(FR-001). Warnings-only: validate exit code stays 0 (FR-005).

## Warning condition (FR-003, D-2)

Emit one warning per entry iff ALL of:

1. Entry **explicitly sets** `model` (`if (!entry?.model) return;` — no
   inheritance-driven multiplication)
2. `resolveRoute(entry.model) === 'gateway'`
3. `!env.GENERACY_LLM_GATEWAY_URL`

## Warning text (D-7, FR-004)

```
${path}.model — set to '<model>' which resolves to the gateway route, but GENERACY_LLM_GATEWAY_URL is not set in this environment. The model will not route anywhere at spawn time.
```

## Matrix (test targets)

| Model | `GENERACY_LLM_GATEWAY_URL` | Result |
|-------|---------------------------|--------|
| `bifrost/claude-opus-4-7` | unset | 1 warning naming exact path + model |
| `bifrost/claude-opus-4-7` | set | silent |
| `opus` (subscription route) | unset | silent |
| `opus` | set | silent |
| (no model on entry) | unset | silent — no explicit set-site |

## Path fidelity (SC-004)

Warnings must name the exact set-site path:

- `orchestrator.agents.default.model`
- `orchestrator.agents.workflows.<wf>.default.model`
- `orchestrator.agents.workflows.<wf>.phases.<phase>.model`
- `cockpit.auto.agents.default.model`
- `cockpit.auto.agents.<role>.model` (role ∈ clarifier, reviewer, validator, fixer, diagnoser)

## Cockpit robustness (D-3, spec Assumption)

| Cockpit block state | Result |
|---------------------|--------|
| absent | no crash, no warnings |
| `cockpit: "junk string"` | no crash, no warnings |
| `cockpit: { auto: null }` | no crash, no warnings |
| `cockpit.auto.agents.reviewer: 42` | no crash, no warnings for that entry |
| `cockpit.auto.agents.reviewer.model: 'x/y'` + URL unset | 1 warning at `cockpit.auto.agents.reviewer.model` |

## Test harness (SC-001)

`vi.mock('@generacy-ai/generacy-plugin-claude-code')` supplying the pinned
`resolveRoute` semantics; env injected via the second parameter (never mutate
`process.env`).

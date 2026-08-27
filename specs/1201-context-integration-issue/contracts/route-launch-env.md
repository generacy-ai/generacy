# Contract: Route-dependent launch environment

**Owners**: #1198 (route resolution + launch env), #1199 (session invalidation + log).
**Asserted by**: `route-launch-env.test.ts` (US1/FR-001..003) and
`phase-loop.route-transition.test.ts` (US3/FR-006..007). This issue asserts these
contracts; it does not implement them. Exact API bindings resolve at implement time
against merged sibling code (plan D-6).

## Route resolution (`resolveRoute`, #1198)

| Input model | Route |
|---|---|
| contains `/` (provider-prefixed, e.g. `openai/gpt-4o`) | `gateway` |
| `undefined` | `subscription` |
| `claude-*` (full ids) | `subscription` |
| aliases (`opus`, `sonnet`, `haiku`) | `subscription` |

Consumed via the plugin's public export. Dependency direction: orchestrator → plugin;
the orchestrator never duplicates the routing rule.

## Launch env (asserted at `factory.spawn`)

| Route | `CLAUDE_CONFIG_DIR` in spawned env |
|---|---|
| `gateway` | present, `= <gatewayConfigDir>` (default `/home/node/.claude-gateway`; env override `GENERACY_CLAUDE_GATEWAY_CONFIG_DIR`) |
| `subscription` | **absent** — not set to empty string, not set to default; the key does not exist |

Negative case: a gateway-route intent with no gateway config available →
`GatewayRouteUnavailableError` thrown from `launch` (no spawn occurs).

## Wrapper preservation (FR-003)

The credentials wrapper
`sh -c '. "$GENERACY_SESSION_DIR/env" && exec "$@"' _ <command> <args...>`
MUST pass inherited env through to the final `exec` unmodified. Proven by a real spawn:
parent env carries `CLAUDE_CONFIG_DIR=<sentinel>`, a temp session env file is sourced,
child is `/usr/bin/env`, stdout must contain `CLAUDE_CONFIG_DIR=<sentinel>`.

## Route-aware session invalidation (#1199)

Given a phase sequence whose resolved per-phase agents produce routes
`subscription → gateway → subscription`:

1. Exactly **2** session drops occur — the CLI session id captured from phase N is NOT
   supplied as `resumeSessionId` to phase N+1 across either crossing.
2. One `agent.route.transition` log line is emitted per crossing, keyed on the
   `(provider, route)` tuple. Same-provider, same-route transitions emit nothing and
   drop nothing.

Observation seams: recording logger injected via the phase-loop deps; `resumeSessionId`
observed at the spawn boundary (mock cliSpawner / spy factory, bound at implement time).

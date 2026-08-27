# Data Model: P1 route plumbing end-to-end verification

No production entities are added — this issue ships tests + fixtures + docs. The data
model below covers the test artifacts.

## Golden fixture: `fixtures/subscription-baseline.json`

One JSON document keyed by spawn kind. Six keys exactly (matching the spec's enumeration;
`invoke` deliberately excluded).

```jsonc
{
  "$schema": "see contracts/golden-fixture.md",
  "capturedAt": "<ISO date>",          // informational only, not compared
  "sourceSha": "<PRE_P1_SHA>",         // pre-P1 merge-base commit, provenance
  "spawns": {
    "phase":             { "command": "sh", "args": ["-c", ". \"$GENERACY_SESSION_DIR/env\" && exec \"$@\"", "_", "claude", "..."], "env": { /* sorted keys */ } },
    "pr-feedback":       { "command": "...", "args": ["..."], "env": { } },
    "merge-conflict":    { "command": "...", "args": ["..."], "env": { } },
    "review":            { "command": "...", "args": ["..."], "env": { } },
    "remediate":         { "command": "...", "args": ["..."], "env": { } },
    "conversation-turn": { "command": "...", "args": ["..."], "env": { } }
  }
}
```

### `SpawnTriple` (per-kind entry)

| Field | Type | Notes |
|---|---|---|
| `command` | `string` | Final command after credentials wrapping (`sh` when credentials are applied) |
| `args` | `string[]` | Final argv, order-significant, compared verbatim |
| `env` | `Record<string, string>` | Complete merged env — keys sorted lexicographically at serialization time |

### Comparison rule (FR-005)

`stableStringify(actual) === stableStringify(fixture.spawns[kind])` per kind —
`stableStringify` recursively sorts object keys; arrays keep order. Any byte difference
fails the test with a unified diff of the two serializations.

### Determinism inputs (Q2=A — all fixed by the test)

| Input | Fixed value |
|---|---|
| `process.env` (base layer of the merge) | `{ PATH: '/usr/bin', HOME: '/home/fixed' }` (wholesale replacement, restored after) |
| Credhelper session | stub client → `sessionDir: '/fixed/session'`, fixed session env map |
| `request.cwd` | `/fixed/checkout` |
| Intent payloads | fixed literals per kind (issue number, prompt, model, resume id absent) |

## Route model (asserted, owned by #1198)

| Model value | Route |
|---|---|
| contains `/` (e.g. `openai/gpt-4o`) | `gateway` |
| `undefined` | `subscription` |
| `claude-*` and aliases (`opus`, `sonnet`, `haiku`) | `subscription` |

Gateway launches must set `CLAUDE_CONFIG_DIR=<gatewayConfigDir>`
(default `/home/node/.claude-gateway`, env override
`GENERACY_CLAUDE_GATEWAY_CONFIG_DIR`). Subscription launches must set nothing.
Gateway route without gateway config → `GatewayRouteUnavailableError`.

## Route-transition test model (owned by #1199, behavior pinned here)

| Concept | Shape |
|---|---|
| Phase sequence | 3 phases whose resolved agents alternate `subscription → gateway → subscription` |
| Expected drops | exactly 2 — session id NOT passed as `resumeSessionId` across either crossing |
| Expected logs | one `agent.route.transition` line per crossing, keyed on `(provider, route)` |
| Observation seam | injected recording logger (captures `{ level, msg, fields }`) |

## Test doubles

### `StubCredhelperClient`

```ts
// implements only what applyCredentials touches
{
  beginSession(req): Promise<{ sessionId: 'fixed-session-id', sessionDir: '/fixed/session',
                               env: { GENERACY_SESSION_DIR: '/fixed/session', /* fixed */ },
                               uid?: number, gid?: number }>,
  endSession(id): Promise<void>  // no-op
}
```

### `SpyProcessFactory`

```ts
{
  spawn: vi.fn((command, args, options) => fakeChildProcessHandle)
}
// registered per stdio profile: new Map([['default', spyA], ['interactive', spyB]])
```

`fakeChildProcessHandle` provides `exitPromise: Promise.resolve(0)` plus inert
stdin/stdout/stderr — mirrors `multi-provider.test.ts`'s mock factory.

## `--settings` guard scan model (FR-009)

| Property | Value |
|---|---|
| Roots | `packages/orchestrator/src/launcher/`, `packages/generacy-plugin-claude-code/src/launch/` |
| Include | `**/*.ts` |
| Exclude | any path segment `__tests__`, any `*.test.ts` |
| Assertion | `content.includes('--settings') === false` for every scanned file |

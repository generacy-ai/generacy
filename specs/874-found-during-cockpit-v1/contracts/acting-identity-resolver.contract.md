# Contract: `resolveActingIdentity`

**Module**: `packages/orchestrator/src/services/acting-identity.ts` (NEW)

## Signature

```typescript
export function resolveActingIdentity(logger: Logger): string | undefined;
```

## Semantics

### Success — env var set

1. Read `process.env['CLUSTER_ACTING_LOGIN']`.
2. Result is `trim()`ed.
3. If non-empty after trim:
   - Normalize via `normalizeLogin()` from `@generacy-ai/workflow-engine`.
   - Emit `logger.info({ actingLogin: <normalized>, source: 'env' }, 'Acting identity resolved: <normalized> (from CLUSTER_ACTING_LOGIN)')`.
   - Return the normalized value.

### Failure — env var unset or empty

1. Emit exactly one `logger.error(...)` line at boot with the following shape:

```json
{
  "level": "error",
  "triedChain": ["CLUSTER_ACTING_LOGIN"],
  "outcome": "unset-or-empty",
  "msg": "Acting identity unresolvable — cluster-identity trust rule will not fire. Set CLUSTER_ACTING_LOGIN to the App bot login (e.g., generacy-ai)."
}
```

2. Return `undefined`.

## Invariants

- **FR-006**: Called exactly once during `createServer()`. Result cached in the calling scope. Never re-invoked.
- **FR-007**: Does NOT read `CLUSTER_GITHUB_USERNAME`, `GH_USERNAME`, or `gh api /user`. The assignee chain is a distinct concern owned by `resolveClusterIdentity()`.
- **Q4=A**: No retry, no lazy evaluation, no re-attempt on failure.
- The `logger.error` line is emitted **iff** the env var is unset or empty after trim. Never emitted when resolution succeeds.

## Consumers

Called from `packages/orchestrator/src/server.ts` in `createServer()`, alongside the existing `resolveClusterIdentity()` call (near line 161). Result stored as a local `actingIdentity: string | undefined`.

Threaded into:
- `ClaudeCliWorkerDeps.clusterIdentity` at `server.ts:337` (currently receives `clusterGithubUsername`).
- `PrFeedbackMonitorService` construction site (currently receives `clusterGithubUsername`).

## Test coverage

| Test case | Input env | Expected return | Expected log |
|-----------|-----------|-----------------|--------------|
| env set to bot login | `CLUSTER_ACTING_LOGIN=generacy-ai` | `'generacy-ai'` | `info` line, no error |
| env set to display case | `CLUSTER_ACTING_LOGIN=Generacy-AI` | `'generacy-ai'` | `info` line, no error |
| env set with whitespace | `CLUSTER_ACTING_LOGIN=  generacy-ai  ` | `'generacy-ai'` | `info` line, no error |
| env set with `[bot]` suffix | `CLUSTER_ACTING_LOGIN=generacy-ai[bot]` | `'generacy-ai'` | `info` line, no error |
| env unset | (absent) | `undefined` | `error` line naming `CLUSTER_ACTING_LOGIN` |
| env empty | `CLUSTER_ACTING_LOGIN=` | `undefined` | `error` line naming `CLUSTER_ACTING_LOGIN` |
| env whitespace-only | `CLUSTER_ACTING_LOGIN=   ` | `undefined` | `error` line naming `CLUSTER_ACTING_LOGIN` |

## Non-goals

- No config-file layer (single-source per Q1=A).
- No cross-process caching (each orchestrator boot resolves fresh).
- No metric emission (pino log is the observability surface).

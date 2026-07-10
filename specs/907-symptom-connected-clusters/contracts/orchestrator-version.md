# Contract: `resolveOrchestratorVersion()`

**Feature**: #907
**Module**: `packages/orchestrator/src/services/orchestrator-version.ts` (NEW)
**Signature**: `export function resolveOrchestratorVersion(): string`

---

## Purpose

Resolve the identifier of the running orchestrator build once per process, for `GET /health` to surface. Precedence: build-time env var, then package.json fallback, then a locked `"unknown"` sentinel.

## Signature

```ts
export function resolveOrchestratorVersion(): string;
```

## Pre-conditions

- None. The function is safe to call at any point after Node initialization.
- Callers may call it exactly once at handler-registration time and cache the return in a closure (see `packages/orchestrator/src/routes/health.ts` `setupHealthRoutes`).

## Post-conditions

The return value is a `string` satisfying **all** of:

1. `typeof returnValue === 'string'`.
2. `returnValue.length > 0`.
3. `returnValue !== '0.0.0'`.
4. Either:
   - Equals `process.env.ORCHESTRATOR_VERSION` (when set and passes the `isRealVersion` guard), OR
   - Equals `packages/orchestrator/package.json` `.version` (when env var didn't resolve and file read succeeded and the value passes the guard), OR
   - Equals the literal string `"unknown"` (sentinel — both prior tiers fell through).

## Precedence table

| Env var (`ORCHESTRATOR_VERSION`) | Package.json `.version` | Return |
|---|---|---|
| `"sha-abc1234"` | any | `"sha-abc1234"` |
| `"1.2.3-preview"` | any | `"1.2.3-preview"` |
| `""` (empty) | `"0.1.0"` | `"0.1.0"` |
| `undefined` | `"0.1.0"` | `"0.1.0"` |
| `"0.0.0"` (literal) | `"0.1.0"` | `"0.1.0"` |
| `undefined` | `"0.0.0"` (literal) | `"unknown"` |
| `undefined` | file unreadable | `"unknown"` |
| `undefined` | malformed JSON | `"unknown"` |
| `undefined` | `{}` (no `version` key) | `"unknown"` |
| `"0.0.0"` | `"0.0.0"` | `"unknown"` |
| `""` | `""` | `"unknown"` |

## Invariants

### `isRealVersion` guard (internal)

```ts
function isRealVersion(candidate: string | undefined): candidate is string {
  return candidate !== undefined && candidate !== '' && candidate !== '0.0.0';
}
```

- Applied uniformly to both env var and package.json values (Q1 → A).
- Literal string equality on `"0.0.0"`. No trimming (research.md §Decision 3).
- No `null` case — `process.env['X']` is `string | undefined` in TypeScript; package.json's `.version` is either a `string` post-JSON.parse or absent from the object.

### Sentinel string

- Exactly `"unknown"` (Q2 → A). No whitespace, no suffix, no synonym.
- Duplicated verbatim in the resolver body and in the FR-007 test as an independent assertion (research.md §Decision 7).

## Failure handling

The function **never throws**. All error paths fall through to the sentinel:

- Env var access — cannot fail (Node globals).
- Package.json read — wrapped in try/catch. `readFileSync` errors (ENOENT, EACCES, EISDIR) all fall through.
- `JSON.parse` — wrapped in try/catch. Malformed JSON falls through.
- Missing `.version` key on the parsed object — treated as `undefined` by the guard, falls through.
- Non-string `.version` value — treated as `undefined` by the guard (defense-in-depth: if package.json had `"version": 1.0` for some reason, we'd fall through rather than coerce).

## Side effects

- On env-var-hit path: none.
- On package.json path: one synchronous `readFileSync` of `../../package.json` relative to the module's URL. Bounded ≤ a few kilobytes; called at most once per handler registration when the caller caches (recommended pattern).
- No mutations of `process.env` or any other global.

## Determinism

For a given process instance:
- `process.env.ORCHESTRATOR_VERSION` is set at process spawn and doesn't change (Docker `ENV` semantics).
- `packages/orchestrator/package.json` on disk in a running container doesn't change under a running process.

Therefore `resolveOrchestratorVersion()` returns the same value for every call within a single process. Callers may cache the first return value indefinitely.

## Testing

### `isRealVersion` — pure-function tests

Direct unit tests, no I/O:
- `isRealVersion('sha-abc1234')` → `true`
- `isRealVersion('0.1.0')` → `true`
- `isRealVersion('')` → `false`
- `isRealVersion(undefined)` → `false`
- `isRealVersion('0.0.0')` → `false`
- `isRealVersion(' 0.0.0 ')` → `true` (documented: no trimming — research.md §Decision 3)
- `isRealVersion('0.0.0-preview')` → `true` (documented: literal-only, no semver-parse — research.md §Decision 3)

### `resolveOrchestratorVersion` — integration tests

Exercised end-to-end via the FR-007 test in `packages/orchestrator/src/__tests__/health-version.test.ts` — sees the field on the wire, which is the load-bearing behavior. See plan.md §Test for the split shape (env-var manipulation for realism, resolver mock for the sentinel corner).

## ESM package.json read

Uses `readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')` + `JSON.parse`. See research.md §Decision 4 for why this over `import ... with { type: 'json' }` or a build-time codegen.

## Non-goals

- Not a general-purpose version resolver — orchestrator-specific.
- Does not read `packages/orchestrator/dist/package.json` or any built artifact; always reads the source-tree package.json alongside the module. In production (built image), the source-tree package.json is present next to the built code.
- Does not consult git; SHAs are supplied via the env var, not computed at runtime.
- Does not parse or validate semver.

## Related contracts

- `contracts/health-response.md` — the wire contract this feeds.

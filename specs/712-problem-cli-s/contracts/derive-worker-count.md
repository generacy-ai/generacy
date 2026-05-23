# Contract: `deriveWorkerCount` and `reconcileWorkerCount`

**Module**: `packages/generacy/src/cli/commands/cluster/worker-count-deriver.ts`
**Issue**: [#712](https://github.com/generacy-ai/generacy/issues/712)

## `deriveWorkerCount(generacyDir, logger)` — async

### Signature

```ts
export async function deriveWorkerCount(
  generacyDir: string,
  _logger: Logger,
): Promise<DeriveResult>;
```

Becomes async; previously sync. Logger param remains unused (warnings flow via `DeriveResult.warnings`).

### Inputs

| Param          | Type     | Required | Notes                                                         |
|----------------|----------|----------|---------------------------------------------------------------|
| `generacyDir`  | `string` | yes      | Absolute path to the project's `.generacy/` directory.        |
| `_logger`      | `Logger` | yes      | Pino logger. Unused by `deriveWorkerCount`; reserved for symmetry with `syncEnvWorkerCount`. |

### Returns

`Promise<DeriveResult>` — see `data-model.md`. Never throws; all error paths are folded into `source: 'default'` (or `'cluster.yaml'` on degraded read) with a populated `warnings` array.

### Behavior

1. Call `readMergedClusterConfig(generacyDir)`. On success:
   - If `local.workers` is set and valid: `source = 'cluster.local.yaml'`. Use `local.workers`.
   - Else if `canonical.workers` is set and valid: `source = 'cluster.yaml'`. Use `canonical.workers`.
   - Else: `source = 'default'`, `workerCount = 1`, warning describing what was missing.
   - If both files were absent (`canonical === {} && local === {}`): `source = 'default'`, warning `"cluster.yaml not found at <path>; using default 1"`.
2. On any throw from `readMergedClusterConfig` (malformed local, schema rejection on local):
   - Fall back to a canonical-only read using the existing per-file logic (`readFileSync` + `parseYaml` + `RawClusterYamlSchema`).
   - Push a warning: `"cluster.local.yaml unreadable; using cluster.yaml value"`.
   - Resolve the canonical layer's `workers`. `source = 'cluster.yaml'`. (If canonical is *also* malformed, the canonical-only path resolves to `source: 'default'` per the existing per-file behavior.)
3. Numeric clamping (applied to whichever layer's value won):
   - Integer ≥ 1 → use as-is.
   - Integer ≤ 0 → `workerCount = 1`, `source = 'clamped'`, warning `"<file> has workers: <n>; clamping to 1"`.
   - Non-integer / wrong type → `workerCount = 1`, `source = 'default'`, warning `"<file> workers field is malformed (got: <value>); using default 1"`.
4. Missing canonical + valid local (Q3=B) → emit warning `"cluster.yaml not found at <path>; using cluster.local.yaml value (workers: <n>). Run 'npx generacy init' to restore the template config."` alongside `source = 'cluster.local.yaml'`.

### Error handling

| Condition                                  | `workerCount` | `source`              | `warnings` content                                  |
|--------------------------------------------|---------------|-----------------------|-----------------------------------------------------|
| `cluster.yaml` present, valid; `cluster.local.yaml` absent | canonical    | `cluster.yaml`        | —                                                   |
| both present, both valid                   | local        | `cluster.local.yaml`  | —                                                   |
| canonical valid, local malformed YAML/schema | canonical | `cluster.yaml`        | "cluster.local.yaml unreadable; …"                  |
| canonical absent, local valid              | local         | `cluster.local.yaml`  | "cluster.yaml not found … run `npx generacy init`"  |
| both absent                                | 1             | `default`             | "cluster.yaml not found at <path>; using default 1" |
| canonical malformed, local absent          | 1             | `default`             | "cluster.yaml … (got: …); using default 1"          |
| canonical malformed, local valid           | local         | `cluster.local.yaml`  | warning about canonical malformedness               |
| any layer yields integer ≤ 0               | 1             | `clamped`             | "<file> has workers: <n>; clamping to 1"            |

### Invariants

- Always resolves; never rejects.
- `workerCount` is always an integer ≥ 1.
- `cluster.yaml` and `cluster.local.yaml` are read but **never written** by this function or any function it calls.

---

## `reconcileWorkerCount(generacyDir, logger)` — async

### Signature

```ts
export async function reconcileWorkerCount(
  generacyDir: string,
  logger: Logger,
): Promise<{ workerCount: number; envWrote: boolean }>;
```

### Behavior

1. `const derived = await deriveWorkerCount(generacyDir, logger);`
2. Emit each `derived.warnings[]` entry via `logger.warn`.
3. **No write-back to `cluster.yaml`.** The current `if (derived.source !== 'cluster.yaml') { … atomicWriteSync(yamlPath, …) }` block (lines 156–181 of the pre-fix file) is removed entirely.
4. Call `syncEnvWorkerCount(generacyDir, derived.workerCount, logger)`. This writes the `WORKER_COUNT` line into `.generacy/.env` if the file exists; otherwise logs a skip and returns.
5. If `.env` was actually written, emit a single info log:
   - `'Reconciled WORKER_COUNT from cluster.local.yaml: <n>'` when `derived.source === 'cluster.local.yaml'`.
   - `'Reconciled WORKER_COUNT from cluster.yaml: <n>'` otherwise.
6. Return `{ workerCount: derived.workerCount, envWrote: sync.wrote }`.

### Invariants

- `cluster.yaml` and `cluster.local.yaml` are read but **never written**.
- `.env` is the only file mutated, and only when it already exists.
- After this function runs, `git status --porcelain .generacy/cluster.yaml` is empty.

---

## Callers

| Caller                                                       | Change                                       |
|--------------------------------------------------------------|----------------------------------------------|
| `packages/generacy/src/cli/commands/up/index.ts:29`          | `reconcileWorkerCount(...)` → `await reconcileWorkerCount(...)` |
| `packages/generacy/src/cli/commands/update/index.ts:93`      | `reconcileWorkerCount(...)` → `await reconcileWorkerCount(...)` |

Both callers already execute inside an `async` Commander action handler — no extra plumbing.

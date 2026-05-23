# Research — #708

Phase 0 design decisions. Each decision links back to a spec FR or clarification Q where applicable.

## D1: `.env` write semantics — in-place vs append

**Decision**: When updating `WORKER_COUNT` in an existing `.env`, replace the matching `^WORKER_COUNT=...$` line in place and preserve all other lines. If no `WORKER_COUNT=` line exists, append a single `WORKER_COUNT=<N>` line (no preceding blank line). Use the same regex pattern the pre-#706 implementation used: `/^WORKER_COUNT=\d+$/m`, but allow the existing line to carry any non-newline tail value when matching — replace, don't validate the prior value (FR-002).

**Rationale**: The scaffolder-written `.env` is a small key-value file with grouped sections, comments, and trailing newlines. Re-serializing the entire file (e.g. through a generic .env parser) would risk lossy round-trips on comments and ordering. The in-place regex replace preserves byte-for-byte everything outside the one line we own. Append-when-missing matches the pre-#706 behavior the spec explicitly references as the model.

**Alternatives considered**:

- *Parse-and-rewrite via `dotenv`* — rejected. Adds a dependency, and `dotenv`'s parser does not preserve comments or ordering. Would re-emit a normalized file on every scale call, churning git diffs in development.
- *Append-only (no in-place replace)* — rejected. Compose interprets the last occurrence of a key, so it would technically work, but the `.env` file would grow unboundedly across scale operations.

**Source**: spec FR-001, FR-002; pre-#706 implementation (visible in `git show 4b7876f -- packages/control-plane/src/services/worker-scaler.ts`).

## D2: Write ordering — `cluster.yaml` first, `.env` second

**Decision**: In `doScale()`, the `.env` write happens after `updateClusterYaml(...)` completes. If the `.env` write throws, log a warning and return the scale result normally — do not re-throw.

**Rationale**: Per clarification Q2=B. `cluster.yaml` is the source of truth; if the second write fails, source-of-truth remains correct and the next CLI re-derivation (D5) reconciles `.env` automatically. The reverse order would create a self-destructive failure mode: `.env`-then-`cluster.yaml` with a cluster.yaml-failure leaves `.env` ahead, then the next CLI re-derive reads the stale cluster.yaml and *overwrites* the user's scale, losing it entirely.

**Source**: clarifications.md Q2; spec FR-006, FR-007.

## D3: Missing `.env` handling in `scaleWorkers`

**Decision**: If the host project's `.env` file does not exist at the resolved path, skip the write and emit a `console.warn` with the path. Do NOT create a new `.env` (FR-008, Q1=B).

**Rationale**: Worker-scaler does not own `.env`'s existence — the scaffolder does, on cluster bootstrap. A one-line `.env` synthesized by worker-scaler would lack the other required keys (`GENERACY_CLUSTER_ID`, `REPO_URL`, etc.) and would silently shadow whatever environment defaults compose would otherwise inherit. The CLI re-derivation path is not the right fix either — if there is no `.env`, the CLI invocation that runs next has the full LaunchConfig context to recreate it properly via the scaffolder (out of scope for this PR). The right v1 behavior is: skip, warn, let the human or the CLI fix it.

**Source**: clarifications.md Q1; spec FR-008.

## D4: Reuse `atomicWrite` for `.env`

**Decision**: Use the existing private `atomicWrite(targetPath, content)` helper in `worker-scaler.ts` for `.env` writes. No need to extract or generalize it.

**Rationale**: `.env` lives in the same `.generacy/` directory as `cluster.yaml`, on the same filesystem, with the same uid/gid and trust boundary. The helper's contract (write to temp in target dir, rename atomically) holds verbatim. Extracting it to a shared module is a separate refactor and out of scope.

**Source**: spec FR-001 ("Uses the existing `atomicWrite` helper"); inspection of `worker-scaler.ts:529-533`.

## D5: CLI re-derivation point — `worker-count-deriver.ts`

**Decision**: Add a new module `packages/generacy/src/cli/commands/cluster/worker-count-deriver.ts` exporting two functions:

- `deriveWorkerCount(generacyDir: string, logger: Logger): { workerCount: number; source: 'cluster.yaml' | 'default' | 'clamped'; warnings: string[] }` — pure-ish: reads `cluster.yaml`, applies FR-009/FR-010 sanitization rules, returns the sanitized count plus reason metadata.
- `syncEnvWorkerCount(generacyDir: string, workerCount: number, logger: Logger): { wrote: boolean; reason?: string }` — reads `.env` if it exists, replaces or appends the `WORKER_COUNT` line, writes atomically. Returns `wrote: false` (and a reason) when `.env` doesn't exist.

Call site in `up/index.ts` and `update/index.ts`: after `getClusterContext()`, before `runCompose(ctx, ['up', '-d'])`. Failures from `deriveWorkerCount` (e.g. cluster.yaml unreadable) are non-fatal — fall through to the scaffolder default of 1 and log. `syncEnvWorkerCount` failures are non-fatal — compose will read whatever `.env` already has.

**Rationale**: Both `up` and `update` need identical pre-compose reconciliation logic. Co-locating the helper next to `compose.ts` and `context.ts` matches the existing module-organization pattern in `commands/cluster/`. Exposing the warning metadata lets `up` and `update` log a consistent message ("Reconciled WORKER_COUNT from cluster.yaml: 5") without duplicating string-formatting logic.

**Alternatives considered**:

- *Inline the logic in both commands* — rejected. Six lines × two commands = drift risk and twice the test surface.
- *Push reconciliation into `runCompose`* — rejected. `runCompose` is generic across `pull`, `up`, `ps`, `logs`, `down`, etc.; injecting WORKER_COUNT on `pull` is wasted work. Keeping reconciliation in the command entry points keeps the responsibility explicit.
- *Add reconciliation to `getClusterContext`* — rejected. `getClusterContext` is read-only; mutating `.env` inside a "context loader" is a surprising side-effect for callers like `status` (read-only listing).

**Source**: spec FR-003, FR-004; clarifications.md Q3 (clamp), Q4 (treat malformed as missing).

## D6: Looser parsing in CLI re-derivation

**Decision**: The CLI re-derivation reads `cluster.yaml` raw (via `yaml.parse(fs.readFileSync(...))`) and inspects the `workers` field with a narrow local Zod schema:

```ts
const RawClusterYamlSchema = z.object({
  workers: z.unknown(),
}).partial();
```

It does NOT go through `ClusterYamlSchema.parse()` because the strict schema enforces `z.number().int().positive()` and would throw on the FR-009 case (`workers: 0` or negative) before our sanitization runs. The narrow schema yields `unknown`, which the helper then checks against the FR-009/FR-010 rules: positive integer → use as-is; zero or negative integer → clamp to 1 + warn (`source: 'clamped'`); any other shape → use default 1 + warn (`source: 'default'`).

The rest of `cluster.yaml` is not consulted by this helper, so we do not need to relax `ClusterYamlSchema` itself. The strict schema continues to gate `getClusterContext()`, which the `up`/`update` commands still call for `projectName`, `composePath`, etc. — but note: `getClusterContext` would also throw on `workers: 0`. To handle the hand-edited-to-zero case end-to-end, the deriver runs *before* `getClusterContext()` in the CLI flow, OR `getClusterContext` itself is taught to tolerate (and clamp) zero. The chosen approach is the former — run `deriveWorkerCount` first, then re-write `.env` so the subsequent `getClusterContext` call sees a sanitized `WORKER_COUNT` (though `getClusterContext` doesn't read `.env`, it reads `cluster.yaml` independently, so the strict-schema crash is still latent).

**Resolution**: To eliminate the latent crash without weakening the schema, `deriveWorkerCount` *also rewrites `cluster.yaml`* when it has to clamp or default. That re-write goes through the existing `worker-scaler.ts`-style atomic temp+rename. Specifically:

- If we clamped `0`/negative → `1`, we write `workers: 1` back to `cluster.yaml` (and log "clamped 0 → 1").
- If the value was malformed (string, null, array, missing), we write the scaffolder default `workers: 1` back to `cluster.yaml` (and log "malformed workers field, defaulting to 1").

This keeps the strict `ClusterYamlSchema` valid for all downstream readers (`getClusterContext`, future commands) and makes the re-derivation idempotent: running `npx generacy up` twice on a malformed yaml yields a sanitized yaml on the first run, no-op on the second.

**Rationale**: Per Q3/Q4 the user-visible behavior must be: malformed/invalid → default + warn, not crash. The cheapest way to deliver that is local sanitization at the re-derivation site combined with a self-healing yaml write. No schema changes, no surprise behavior elsewhere.

**Source**: clarifications.md Q3, Q4; spec FR-005, FR-009, FR-010; inspection of `ClusterYamlSchema` in `packages/generacy/src/cli/commands/cluster/context.ts:32-37`.

## D7: Warning log format

**Decision**: All warnings from this feature use `getLogger().warn(...)` with a consistent prefix and a single-line, human-readable message. No structured JSON requirement (the existing pino logger is text-friendly in CLI context).

Examples:

- `worker-scaler`: `WORKER_COUNT sync to .env skipped: file not found at /path/to/.generacy/.env`
- `worker-scaler`: `WORKER_COUNT sync to .env failed: <error.message>; cluster.yaml is the source of truth`
- CLI deriver: `cluster.yaml has workers: 0; clamping to 1`
- CLI deriver: `cluster.yaml workers field is malformed (got: "five"); using default 1`
- CLI deriver: `cluster.yaml has no workers field; using default 1`

**Rationale**: Per Q3/Q4 reasoning, the warning needs to distinguish "missing" from "malformed" from "clamped" for log readers debugging post-hoc. Three explicit messages (plus the sync-failure cases) are enough; we do not need a structured log schema for this volume.

**Source**: clarifications.md Q3, Q4; spec FR-005, FR-009, FR-010.

## D8: Test strategy

**Decision**: Three test surfaces.

1. **`worker-scaler.test.ts`** — add cases:
   - Scale to N when `.env` exists with `WORKER_COUNT=M` (M ≠ N): assert `.env` now contains `WORKER_COUNT=N`, all other lines preserved.
   - Scale to N when `.env` exists without a `WORKER_COUNT` line: assert appended.
   - Scale to N when `.env` does not exist: assert no file created, warning logged, scale operation succeeds.
   - Scale to N when `.env` write throws (mock `atomicWrite`): assert scale result returned unchanged, warning logged.
   - Write order: `cluster.yaml` updated even if `.env` write throws (mock the env-write path to throw after cluster.yaml succeeds).

2. **`worker-count-deriver.test.ts`** (new) — pure-function table tests:
   - `workers: 5` (positive int) → returns 5, source `'cluster.yaml'`, no warnings.
   - `workers: 0` → returns 1, source `'clamped'`, warning includes "clamping to 1".
   - `workers: -3` → returns 1, source `'clamped'`, warning includes the negative value.
   - `workers: "five"` → returns 1, source `'default'`, warning identifies malformed.
   - `workers: null` → returns 1, source `'default'`, warning identifies malformed.
   - `workers` key missing → returns 1, source `'default'`, warning identifies missing.
   - Missing or unreadable `cluster.yaml` → returns 1, source `'default'`, warning identifies missing.
   - Self-healing yaml rewrite: after `deriveWorkerCount` clamps or defaults, re-reading `cluster.yaml` shows `workers: 1`.

3. **`up`/`update` command tests** — integration with mocked `runCompose`:
   - Stub `runCompose` to capture invocation; assert it was called after the deriver synced `.env`.
   - With `cluster.yaml` `workers: 5` and `.env` `WORKER_COUNT=1`: assert `.env` updated to `WORKER_COUNT=5` before `runCompose` runs.
   - With `cluster.yaml` `workers: 0`: assert `.env` updated to `WORKER_COUNT=1`, warning logged, `cluster.yaml` re-written to `workers: 1`.

**Rationale**: Each surface tests one responsibility — worker-scaler tests verify orchestrator-side `.env` sync, deriver tests verify sanitization purity (no IO mocks beyond tmp dir), command tests verify the wiring between deriver and `runCompose`.

**Source**: spec SC-001 through SC-004 (success criteria are integration-test-shaped); existing test patterns in `worker-scaler.test.ts`.

## D9: Out of scope (re-confirmed from spec)

The following are *not* part of this PR, even though they touch adjacent code:

- Removing `.env` or `WORKER_COUNT` from the compose interpolation contract (would require coordinated cluster-base / cluster-microservices template changes).
- Adding cross-file transactional writes or locks.
- Promoting the FR-009/FR-010 warnings to cloud-UI notifications.
- Migrating away from `.env` entirely (e.g. compose env injection from `cluster.yaml` only).
- Generalizing `atomicWrite` into a shared utility (separate refactor).
- Extending `worker-count-deriver` to handle additional `cluster.yaml` fields beyond `workers`.

**Source**: spec "Out of Scope".

## Key references

- Pre-#706 implementation (the model for layer 1): `git show 4b7876f -- packages/control-plane/src/services/worker-scaler.ts`
- Compose interpolation pattern: `packages/generacy/src/cli/commands/cluster/scaffolder.ts:210` — `replicas: '${WORKER_COUNT:-1}'`
- `.env` scaffold reference: `packages/generacy/src/cli/commands/cluster/scaffolder.ts:272-310`
- Strict cluster.yaml schema: `packages/generacy/src/cli/commands/cluster/context.ts:32-37`
- Existing atomic write helper: `packages/control-plane/src/services/worker-scaler.ts:529-533`

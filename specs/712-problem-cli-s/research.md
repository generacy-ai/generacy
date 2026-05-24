# Research: CLI worker-count-deriver must read merged cluster config

**Issue**: [#712](https://github.com/generacy-ai/generacy/issues/712)
**Branch**: `712-problem-cli-s`

## Decision 1 — Use `readMergedClusterConfig` from `@generacy-ai/config`

**Decision**: Replace the inline canonical-only YAML read in `worker-count-deriver.ts` with a call to the existing `readMergedClusterConfig(generacyDir)` helper.

**Rationale**:
- The helper already implements the local-wins semantics that #709 standardized for `cluster.local.yaml` overlay (shallow merge per top-level key).
- It already calls `ClusterYamlSchema` and `ClusterLocalYamlSchema` Zod validators, with documented fail-loud behavior on malformed YAML / schema rejection.
- Orchestrator-side readers (`relay-bridge.ts`, `app-config.ts`) already migrated to this helper after #709; only the CLI deriver was missed. Using the same helper closes the divergence.
- It's already exported from `packages/config/src/index.ts` line 41 — no package-graph changes required.

**Alternatives considered**:
- **Reimplement merged read inside the CLI**. Rejected: duplicates the canonical helper, drifts when the schema or merge semantics evolve, and re-introduces the exact "two readers, one writer" hazard #712 is filed against.
- **Have the CLI read `cluster.local.yaml` directly and only fall back to `cluster.yaml`**. Rejected: bypasses the schema validators in `@generacy-ai/config`, so a manually-edited `workers: 0` in the local overlay wouldn't be caught by the same rules.
- **Move `reconcileWorkerCount` into `@generacy-ai/config`**. Rejected: the CLI's `.env` sync is CLI-specific (Pino logger, `commander` lifecycle wiring); pushing it into `@generacy-ai/config` would leak CLI concerns into a config-utility package.

**Sources**:
- `packages/config/src/cluster-config.ts` lines 59–76 — `readMergedClusterConfig` definition.
- `packages/config/src/cluster-config-schema.ts` lines 14–20 — `ClusterLocalYamlSchema.workers: z.number().int().min(1).optional()`.
- `packages/control-plane/src/services/worker-scaler.ts:466-470` — where the runtime writer puts the value.

## Decision 2 — Degraded fallback on corrupt local overlay (Q1=C)

**Decision**: Wrap `readMergedClusterConfig(generacyDir)` in try/catch. On throw, fall back to reading `cluster.yaml` directly via the existing per-file path (the current implementation's read+parse+`RawClusterYamlSchema` chain, factored into a `readCanonicalOnly` helper). Emit a warning identifying `cluster.local.yaml` as the corruption source.

**Rationale**:
- The CLI's primary job is to keep the cluster running. A corrupted overlay shouldn't make `npx generacy up` exit non-zero (rejecting option B from the clarifications).
- The user's hand-edited `cluster.yaml` value is still useful when the overlay is broken; defaulting to `1` (option A) silently throws it away.
- The data hierarchy is documented: `cluster.yaml` is the template/canonical layer, `cluster.local.yaml` is an overlay. When the overlay fails to parse, falling through to the layer beneath matches the documented model.
- Per Q2=B: this path reuses `source: 'cluster.yaml'`. The warning carries the "local was broken" signal — no enum bloat.

**Alternatives considered**:
- See clarifications.md Q1 options A and B.

**Sources**:
- `specs/712-problem-cli-s/clarifications.md` Q1 (resolved C).
- `packages/config/src/cluster-config.ts:35-37` — documents the throw path (`Failed to parse YAML at <path>: <message>`).

## Decision 3 — Drop the `cluster.yaml` write-back branch entirely

**Decision**: Remove lines 156–181 of `worker-count-deriver.ts` (the `if (derived.source !== 'cluster.yaml')` block that rewrites `cluster.yaml`). On a missing/malformed/clamped source, the deriver returns the clamped/default value, logs the warning, and updates `.env` only.

**Rationale**:
- This is the direct violation of #709 that #712 was filed against. Keeping any form of "self-heal" of `cluster.yaml` mutates a git-tracked file from a CLI lifecycle command, which is the exact behavior #709 eliminated everywhere else.
- The acceptance criterion explicitly states: `git status` after `npx generacy up` on a project with missing/malformed `workers` must be clean.
- If the user wants to fix a hand-edit, they edit `cluster.yaml` themselves. The CLI doesn't silently rewrite hand-edited files.

**Alternatives considered**:
- **Keep self-heal but gate it behind `--auto-fix`**. Rejected as scope creep; not in the spec and adds a flag whose default behavior must also be silent-rewrite or silent-no-rewrite — the latter is what we're doing without the flag.
- **Move self-heal into `npx generacy init`**. Rejected as out of scope; `init` already owns canonical scaffolding, and #712 doesn't require relocating the behavior, only removing it from lifecycle commands.

**Sources**:
- `packages/generacy/src/cli/commands/cluster/worker-count-deriver.ts:156-181` — current write-back branch.
- Issue #709 — `cluster.local.yaml` separation policy.

## Decision 4 — Extend `DeriveResult.source` with `'cluster.local.yaml'` (Q2=B)

**Decision**: `DeriveResult.source` becomes `'cluster.yaml' | 'cluster.local.yaml' | 'clamped' | 'default'`.

**Rationale**:
- Tests (FR-005, FR-006 row "present, valid | present, valid → local value") need to assert the value came from the overlay, not the canonical layer.
- Log lines like `Reconciled WORKER_COUNT from cluster.yaml: <n>` become inaccurate when the value came from the overlay; the variant lets us emit `from cluster.local.yaml` correctly.
- No current consumer branches on `source`, so adding a variant is a non-breaking type widening for internal callers.

**Alternatives considered**:
- A (keep current enum, treat `'cluster.yaml'` as "from on-disk config"): rejected — silently-wrong logs are a debugging hazard.
- C (structured shape `{ source: 'config', file: 'cluster.yaml' | 'cluster.local.yaml' } | ...`): rejected as over-engineering.

**Sources**:
- `specs/712-problem-cli-s/clarifications.md` Q2 (resolved B).

## Decision 5 — Missing `cluster.yaml` + valid `cluster.local.yaml` → use local with warning (Q3=B)

**Decision**: When the canonical file is absent but the overlay carries a valid `workers`, return the local value with `source: 'cluster.local.yaml'` and emit a warning recommending `npx generacy init`.

**Rationale**:
- The merged read in `@generacy-ai/config` already produces this shape (`canonical = {}`, `local = { workers: N }`, `merged.workers = N`). No special-case needed in the deriver beyond the warning.
- A missing canonical file is unusual enough that the user should hear about it (rejecting A's silent acceptance), but blocking lifecycle work because of it (option C) is hostile.
- The warning text recommends a recovery action, matching the CLI's tone elsewhere.

**Sources**:
- `specs/712-problem-cli-s/clarifications.md` Q3 (resolved B).
- `packages/config/src/cluster-config.ts:70-74` — empty-object default on ENOENT.

## Decision 6 — Async signature for `deriveWorkerCount` and `reconcileWorkerCount`

**Decision**: Both functions become `async`. `readMergedClusterConfig` is async (it uses `fs/promises`), so the deriver must be too. Callers (`up/index.ts`, `update/index.ts`) update from `reconcileWorkerCount(...)` to `await reconcileWorkerCount(...)`.

**Rationale**:
- The existing helper is async; wrapping in `readFileSync` would either reimplement it sync or block the event loop on a busy startup path. Neither is acceptable.
- Both callers already live inside an `async` command handler (`up/index.ts:29`, `update/index.ts:93`), so the change is a one-line `await` insertion in each.

**Alternatives considered**:
- Add a `readMergedClusterConfigSync` to `@generacy-ai/config`. Rejected: forks the helper, doubles the surface, and the existing async path is fine for CLI startup.

**Sources**:
- `packages/generacy/src/cli/commands/up/index.ts:29`, `packages/generacy/src/cli/commands/update/index.ts:93`.

## Decision 7 — Tests live in the same file (`worker-count-deriver.test.ts`)

**Decision**: Extend the existing Vitest file with the new merged-config matrix; do not split into a separate test file.

**Rationale**:
- The matrix is small (8 rows). Splitting adds setup duplication.
- The existing file already has the `mkdtempSync` + `writeFileSync` fixture pattern that the new tests need; reusing it keeps the file self-contained.

**Sources**:
- `packages/generacy/src/cli/commands/cluster/__tests__/worker-count-deriver.test.ts` lines 27–133.

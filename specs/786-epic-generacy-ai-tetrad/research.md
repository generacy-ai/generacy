# Research: @generacy-ai/cockpit foundation

## R1: Package layout reference

**Decision**: Mirror `@generacy-ai/credhelper`'s layout — `src/` with subfolders by concern, `src/__tests__/` for vitest, `tsc` build to `dist/`, no separate `tests/` directory.

**Rationale**: This pattern is already in use by typed-utility packages in the monorepo (`credhelper`, `config`, `cluster-relay`). It keeps test files adjacent to the source under test and is the path of least resistance for CI (`pnpm --filter @generacy-ai/cockpit test` works without extra glob config).

**Alternatives considered**:
- `tests/` at the package root (used by `activation-client`). Rejected for consistency with the more recent packages and because manifest fixtures live more naturally next to the code that consumes them.
- A flat `src/` with no subfolders. Rejected — five concerns (state, config, manifest, gh, orchestrator) is too many for one directory and obscures the public-surface boundary.

**Source**: `packages/credhelper/`, `packages/config/`, `packages/cluster-relay/`.

## R2: Node version floor

**Decision**: `engines.node` = `>=22.0.0`.

**Rationale**: The CLI package (`packages/generacy/bin/generacy.js`) already gates on Node >= 22, and the cluster-side runtime targets Node 22 (`packages/control-plane/src/services/file-store.ts` relies on Node 22's `FileHandle.lock`). Picking 22 keeps cockpit aligned with the consumers most likely to depend on it (CLI subcommands, in-cluster jobs).

**Alternatives considered**:
- `>=20` (matches credhelper / activation-client). Acceptable but introduces a fork in monorepo policy. Picking 22 keeps the runtime baseline consistent with the rest of the recent v1.5 work.

## R3: HTTP client — `NativeHttpClient` is the existing pattern

**Decision**: Copy the `NativeHttpClient` shape from `packages/activation-client/src/client.ts` into `packages/cockpit/src/orchestrator/http.ts`, adding a `get<T>(url, headers?)` method. Zero new HTTP deps.

**Rationale**: Spec FR-009 mandates this pattern. The activation-client implementation is well-tested in production, handles HTTPS vs HTTP, has a 30s timeout, and parses JSON responses defensively. It's a small file — duplicating it (rather than depending on `@generacy-ai/activation-client`) keeps the cockpit's dependency graph minimal and avoids importing device-flow types that have no relevance here.

**Alternatives considered**:
- Depend on `@generacy-ai/activation-client`. Rejected — it brings device-flow request/response types we don't need and ties the cockpit to that package's release cadence.
- Add `undici` or `node-fetch`. Rejected — explicit spec requirement to use the existing pattern with no new HTTP deps.

**Source**: `packages/activation-client/src/client.ts:22-68`.

## R4: `WORKFLOW_LABELS` is the only label source of truth

**Decision**: Import `WORKFLOW_LABELS` directly from `@generacy-ai/workflow-engine` (already re-exported at `packages/workflow-engine/src/index.ts:93`). Never copy label data into the cockpit.

**Rationale**: SC-001 requires 100% coverage of `WORKFLOW_LABELS`. The only way to guarantee non-drift between cockpit and workflow-engine is a direct import. A vitest unit test iterates `WORKFLOW_LABELS` and asserts `classify([label.name]).state !== 'unknown'` for every entry — this fails loudly if the workflow-engine adds a label the cockpit hasn't mapped.

**Source**: `packages/workflow-engine/src/actions/github/label-definitions.ts:20-97`.

## R5: Precedence rule mechanics

**Decision**: Implement the curated-tier comparator `terminal > error > waiting > active > pending > unknown` plus the documented tie-break:

- Within `waiting`: prefer earlier index in `WAITING_PIPELINE_ORDER = ['waiting-for:spec-review', 'waiting-for:clarification', 'waiting-for:plan-review', 'waiting-for:tasks-review', 'waiting-for:implementation-review', 'waiting-for:manual-validation']`. Unlisted `waiting-for:*` / `needs:*` labels sort after the listed ones, preserving `WORKFLOW_LABELS` order among themselves.
- Within any other tier: prefer earlier index in `WORKFLOW_LABELS`.

**Rationale**: Clarification Q2 made this rule authoritative. Capturing the pipeline order as a hard-coded list (rather than a derived rule from `WORKFLOW_LABELS` order) protects against accidental reordering of the catalog. Tests in `classifier.test.ts` will exercise: (1) one case per state, (2) tier precedence (e.g. `terminal` wins over `error`), (3) waiting tie-break (e.g. `[waiting-for:clarification, waiting-for:plan-review]` → `clarification`), (4) generic tier tie-break by index.

**Alternatives considered**:
- Derive `WAITING_PIPELINE_ORDER` from `WORKFLOW_LABELS` order. Rejected — `WORKFLOW_LABELS` is a catalog, not a pipeline; coupling them makes catalog reordering a behavioral change.
- Lexicographic tie-break. Rejected — spec explicitly names a deterministic non-lexicographic rule.

## R6: Manifest schema location

**Decision**: Own the `EpicManifestSchema` inside `@generacy-ai/cockpit` (`src/manifest/schema.ts`) and read manifests from `.generacy/epics/<slug>.yaml` paths.

**Rationale**: Clarification Q3 (Option A): lock the path in this package, not via config. The schema lives where the reader lives so consumers get IntelliSense and validation in one import. The on-disk path is fixed at `.generacy/epics/<slug>.yaml` — the resolver globs that directory.

**Source**: Spec lines 48, 88; clarifications Q3.

## R7: Atomic write pattern

**Decision**: Write manifest changes via `<path>.tmp` + `fs.rename()` (single-file atomic on POSIX). No advisory locking needed — manifest writes are operator-driven, not concurrent.

**Rationale**: Matches existing precedent in `packages/credhelper/src/backends/file-store.ts` and `packages/orchestrator/src/activation/persistence.ts`. The simpler `temp+rename` pattern is sufficient here because the cockpit is not a high-concurrency writer; manifest mutations come from one CLI invocation at a time.

**Alternatives considered**:
- fd-based advisory lock (Node 22 `FileHandle.lock`). Rejected as overkill — added in #521 specifically for cross-process credhelper writes; manifests don't have that concurrency profile.

**Source**: `packages/credhelper/src/backends/file-store.ts`, `packages/orchestrator/src/activation/persistence.ts`.

## R8: `gh` invocation pattern — injected runner, not module-level spawn

**Decision**: Build a `CommandRunner` adapter so unit tests never spawn `gh`. Default runner uses `node:child_process.execFile` (or the existing `executeCommand` helper if exported from a sibling package); injected runner in tests returns canned stdout.

**Rationale**: The workflow-engine's `GhCliGitHubClient` (`packages/workflow-engine/src/actions/github/client/gh-cli.ts`) demonstrates the right pattern: thin wrapper, parameterized command execution, structured error mapping. We want the same testability without depending on workflow-engine internals (it would create a circular boundary — workflow-engine already exports `WORKFLOW_LABELS` to us).

**Alternatives considered**:
- Direct `execFile` calls inside wrapper methods. Rejected — untestable without spawning real processes.
- Reuse `GhCliGitHubClient` from `@generacy-ai/workflow-engine`. Rejected — its interface is shaped for workflow actions (issue mutation, PR creation, merge), not the read-only listing + label-mutation + check-run subset the cockpit needs. Pulling it in inflates the dependency surface.

**Source**: `packages/workflow-engine/src/actions/github/client/gh-cli.ts`.

## R9: Config loader — extend behavior without touching `@generacy-ai/config`

**Decision**: `loadCockpitConfig()` calls `findWorkspaceConfigPath()` from `@generacy-ai/config` to locate `.generacy/config.yaml`, then reads + parses the file manually and validates the `cockpit:` sub-key with `CockpitConfigSchema` owned in this package. No edits to `@generacy-ai/config`.

**Rationale**: SC-007 limits this PR's blast radius to `packages/cockpit/**`. The shared loader (`tryLoadWorkspaceConfig`) does not currently expose a "give me an arbitrary block" helper — and adding one would expand the contract beyond what this issue requires. Reading the YAML again in our loader is cheap (the file is tiny) and keeps the cockpit's schema co-located with its consumer.

**Alternatives considered**:
- Add a generic block-loader to `@generacy-ai/config`. Rejected — violates SC-007 isolation and prematurely generalizes.
- Read via `tryLoadWorkspaceConfig` then re-parse only the `cockpit:` key. Same effective cost and an unnecessary indirection through the workspace schema.

**Source**: `packages/config/src/loader.ts`.

## R10: Orchestrator endpoint mapping for v1

**Decision**: Map `health()` → `GET ${baseUrl}/health`, `getJobs()` → `GET ${baseUrl}/queue`, `getWorkers()` → `GET ${baseUrl}/dispatch/queue/workers`.

**Rationale**: These routes exist today (`packages/orchestrator/src/routes/health.ts`, `queue.ts`, `dispatch.ts`). The spec defers exact endpoint mapping to "plan-phase detail" (FR-009), and locks behavior at "shape + degraded mode" (SC-005). G5.1 will expand the method surface — picking endpoints that already exist means the live path is verifiable today without a sibling change.

**Source**: `packages/orchestrator/src/routes/queue.ts`, `dispatch.ts`, `health.ts`.

## R11: Logging — injectable logger, default to console

**Decision**: Loader and resolver functions accept an optional `logger?: { warn: (msg: string) => void; info?: ...; error?: ... }`. Default is `console`.

**Rationale**: Spec calls for warn-level logging on absent-config (FR-005) and the activation-client's `ActivationLogger` is a tiny good-enough interface. Injection makes tests assert on warn messages without monkey-patching `console`. Keeping the surface minimal (just `warn`) avoids over-designing this for a foundation issue.

**Source**: `packages/activation-client/src/types.ts` (`ActivationLogger`).

## R12: Testing fixtures

**Decision**: Commit one reference manifest fixture under `src/__tests__/fixtures/epic-cockpit.yaml` matching the shape described in spec line 48 / clarification Q3 answer. Use it to exercise `readManifest`, `writeManifest`, `appendChildIssue`, and `resolveEpicIssues` (manifest branch).

**Rationale**: Spec line 115 names a reference manifest at `.generacy/epics/epic-cockpit.yaml` in the tetrad-development repo — but we can't depend on that repo at test time. Committing our own fixture inside the test tree pins behavior and provides a worked example for the README (FR-013).

## References

- Spec: `specs/786-epic-generacy-ai-tetrad/spec.md`
- Clarifications: `specs/786-epic-generacy-ai-tetrad/clarifications.md`
- `WORKFLOW_LABELS`: `packages/workflow-engine/src/actions/github/label-definitions.ts`
- HTTP client pattern: `packages/activation-client/src/client.ts`
- Package layout reference: `packages/credhelper/`
- Atomic file write reference: `packages/credhelper/src/backends/file-store.ts`
- Workspace loader: `packages/config/src/loader.ts`
- Orchestrator route shape: `packages/orchestrator/src/routes/{queue,dispatch,health}.ts`

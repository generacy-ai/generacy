# Clarifications: CLI worker-count-deriver must read merged cluster config

**Issue**: [#712](https://github.com/generacy-ai/generacy/issues/712)
**Branch**: `712-problem-cli-s`

## Batch 1 — 2026-05-23

### Q1: Schema-strict throw behavior
**Context**: `readMergedClusterConfig` is documented as fail-loud — it throws on malformed YAML and Zod rejects schema-invalid values. `ClusterLocalYamlSchema.workers` is `z.number().int().min(1).optional()`, so a corrupted/manually-edited `cluster.local.yaml: workers: 0` (or any non-integer) causes the merged read to throw. The existing `deriveWorkerCount` catches every error path and falls back to `1` with a warning. The spec (FR-004) says "warn but no git-tracked file is mutated" but does not say whether the CLI should remain tolerant or become strict on this surface.
**Question**: When `readMergedClusterConfig` throws (malformed YAML, schema rejection on `cluster.local.yaml`), what should `deriveWorkerCount` do?
**Options**:
- A: Catch the throw, log a warning, return `{ workerCount: 1, source: 'default', warnings: [...] }` — preserves the current swallow-and-continue UX and keeps `npx generacy up` succeeding on a corrupted local overlay.
- B: Propagate the throw — `npx generacy up`/`update` exits non-zero. Matches the helper's documented fail-loud contract; user must repair `cluster.local.yaml` before lifecycle commands work.
- C: Catch the throw, attempt a degraded read of just `cluster.yaml` (ignoring the broken local overlay), warn, and continue. Combines safety of A with awareness that the user's last good canonical value is still useful.

**Answer**: *Pending*

### Q2: `DeriveResult.source` enum granularity
**Context**: Today `DeriveResult.source` is `'cluster.yaml' | 'clamped' | 'default'`. After the switch, the value can legitimately come from `cluster.local.yaml` (local-wins). The spec is silent on whether the enum should change. This affects test assertions (FR-005, FR-006), log messages ("Reconciled WORKER_COUNT from cluster.yaml" would be wrong when value came from local), and any future telemetry consumers.
**Question**: Should `DeriveResult.source` be extended to distinguish where the value came from?
**Options**:
- A: Keep current enum. `'cluster.yaml'` becomes a sentinel meaning "from on-disk config (merged)" — minimal API change, but log/test wording becomes inaccurate when local wins.
- B: Add `'cluster.local.yaml'` so the union becomes `'cluster.yaml' | 'cluster.local.yaml' | 'clamped' | 'default'`. Tests and logs can accurately report local-wins. Caller code stays simple (no one branches on this today).
- C: Replace the file-name variants with a structured shape: `{ source: 'config', file: 'cluster.yaml' | 'cluster.local.yaml' } | { source: 'clamped' } | { source: 'default' }`. Most future-proof but a wider refactor.

**Answer**: *Pending*

### Q3: `cluster.local.yaml` present, `cluster.yaml` absent
**Context**: The expected real-world layout has `cluster.yaml` always present (scaffolded at init) with `cluster.local.yaml` as an optional overlay. But nothing prevents the inverse — a user could delete `cluster.yaml` while keeping their scaled overlay. `readMergedClusterConfig` returns `merged: { ...canonical, ...local }` with both defaulting to `{}` on ENOENT, so a local-only project would resolve to the local's `workers` value without complaint. The spec (US1 line 69) calls `cluster.yaml` the "template fallback" but doesn't specify behavior when it's missing entirely.
**Question**: When `cluster.local.yaml` has a valid `workers` value and `cluster.yaml` is missing, what should the CLI do?
**Options**:
- A: Use the local value silently — treat the local file as sufficient.
- B: Use the local value but log a warning that `cluster.yaml` is missing (project layout is unusual; recommend re-running `npx generacy init` or restoring the file).
- C: Treat missing `cluster.yaml` as a hard error regardless of local — refuse to proceed until the canonical file exists.

**Answer**: *Pending*

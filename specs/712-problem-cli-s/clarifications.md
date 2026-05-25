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

**Answer**: **C** — catch the throw, fall back to a `cluster.yaml`-only read, warn.

- A loses the user's hand-edited `cluster.yaml` value silently. A user with `cluster.yaml: workers: 3` and a corrupted `cluster.local.yaml` shouldn't end up running with 1 worker — `cluster.yaml` is right there with a usable value.
- B blocks every lifecycle command on a single corrupted overlay file. The CLI's primary job is to keep the cluster running; refusing to operate because of runtime-state corruption is the wrong tradeoff.
- C respects the data hierarchy: `cluster.yaml` is the documented fallback layer, local is an overlay. When the overlay is broken, falling through to the layer underneath is the right semantics.

Implementation: wrap the `readMergedClusterConfig` call in try/catch; on throw, fall back to a direct read of `cluster.yaml` (same parse+validate logic, without the local overlay). Add a warning class "`cluster.local.yaml` corrupted, using `cluster.yaml` value".

### Q2: `DeriveResult.source` enum granularity
**Context**: Today `DeriveResult.source` is `'cluster.yaml' | 'clamped' | 'default'`. After the switch, the value can legitimately come from `cluster.local.yaml` (local-wins). The spec is silent on whether the enum should change. This affects test assertions (FR-005, FR-006), log messages ("Reconciled WORKER_COUNT from cluster.yaml" would be wrong when value came from local), and any future telemetry consumers.
**Question**: Should `DeriveResult.source` be extended to distinguish where the value came from?
**Options**:
- A: Keep current enum. `'cluster.yaml'` becomes a sentinel meaning "from on-disk config (merged)" — minimal API change, but log/test wording becomes inaccurate when local wins.
- B: Add `'cluster.local.yaml'` so the union becomes `'cluster.yaml' | 'cluster.local.yaml' | 'clamped' | 'default'`. Tests and logs can accurately report local-wins. Caller code stays simple (no one branches on this today).
- C: Replace the file-name variants with a structured shape: `{ source: 'config', file: 'cluster.yaml' | 'cluster.local.yaml' } | { source: 'clamped' } | { source: 'default' }`. Most future-proof but a wider refactor.

**Answer**: **B** — add `'cluster.local.yaml'` to the enum.

- A breaks log accuracy without saving meaningful API surface. Silently-wrong telemetry/logs are a debugging hazard.
- C (structured shape) is over-engineering for a value with zero current branching consumers.
- B: add the new variant, update log messages to use the variant. `source === 'cluster.yaml'` and `source === 'cluster.local.yaml'` both mean "from on-disk config"; `'clamped'` and `'default'` keep their meanings.

For the Q1=C degraded-read path: reuse `'cluster.yaml'` (the value did come from that file; the warning log carries the "local was broken" signal). Keeps the enum tight.

### Q3: `cluster.local.yaml` present, `cluster.yaml` absent
**Context**: The expected real-world layout has `cluster.yaml` always present (scaffolded at init) with `cluster.local.yaml` as an optional overlay. But nothing prevents the inverse — a user could delete `cluster.yaml` while keeping their scaled overlay. `readMergedClusterConfig` returns `merged: { ...canonical, ...local }` with both defaulting to `{}` on ENOENT, so a local-only project would resolve to the local's `workers` value without complaint. The spec (US1 line 69) calls `cluster.yaml` the "template fallback" but doesn't specify behavior when it's missing entirely.
**Question**: When `cluster.local.yaml` has a valid `workers` value and `cluster.yaml` is missing, what should the CLI do?
**Options**:
- A: Use the local value silently — treat the local file as sufficient.
- B: Use the local value but log a warning that `cluster.yaml` is missing (project layout is unusual; recommend re-running `npx generacy init` or restoring the file).
- C: Treat missing `cluster.yaml` as a hard error regardless of local — refuse to proceed until the canonical file exists.

**Answer**: **B** — use the local value with a warning recommending `generacy init`.

- A is too silent: a missing `cluster.yaml` is unusual enough that the user should know about it.
- C is too strict: blocking the lifecycle command when runtime state is perfectly readable is hostile.
- B preserves operability and surfaces the anomaly. Suggested log: `cluster.yaml not found at <path>; using cluster.local.yaml value (workers: N). Run 'npx generacy init' to restore the template config.`

`source` for this case is `'cluster.local.yaml'` per Q2 — the value genuinely came from local, regardless of whether the canonical layer also existed.

---

## Resolved test matrix

| canonical | local | result | source | warnings |
|---|---|---|---|---|
| present, valid | absent | canonical value | `cluster.yaml` | — |
| present, valid | present, valid | local value (local wins) | `cluster.local.yaml` | — |
| present, valid | present, malformed | canonical value (degraded) | `cluster.yaml` | local-corrupted |
| absent | present, valid | local value | `cluster.local.yaml` | canonical-missing |
| absent | absent | 1 | `default` | both-missing |
| present, malformed | absent | 1 | `default` | canonical-malformed |
| present, malformed | present, valid | local value | `cluster.local.yaml` | canonical-malformed |
| any | any (workers: 0 or invalid) | 1 (clamped) | `clamped` | clamp-warning |

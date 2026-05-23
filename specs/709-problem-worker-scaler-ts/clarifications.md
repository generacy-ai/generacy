# Clarifications: Decouple worker-scaler runtime state from git-tracked cluster.yaml

## Batch 1 — 2026-05-23

### Q1: Runtime-state filename
**Context**: FR-001 introduces a new file to hold per-cluster runtime state but explicitly defers the filename. Two candidates are proposed in the spec — `cluster.local.yaml` (sibling of `cluster.yaml`, mirrors the `*.local.*` convention used by Next.js/Vite for git-ignored overrides) and `.generacy/state.yaml` (different basename, makes the "this is mutable runtime state" intent explicit). The chosen name ends up in the template `.gitignore`, in worker-scaler's write path, and in every merged reader — once shipped it is hard to rename.
**Question**: What basename should the runtime-state file use, sitting alongside `cluster.yaml` in `.generacy/`?
**Options**:
- A: `cluster.local.yaml` — mirrors the `*.local.*` convention (Next.js, Vite, dotenv). Visually pairs with `cluster.yaml`.
- B: `state.yaml` — different basename signals "not user-edited"; less likely to be mistaken for a sibling config.
- C: `cluster.runtime.yaml` — explicit about purpose, still pairs visually with `cluster.yaml`.

**Answer**: *Pending*

---

### Q2: Scope of fields moved into the runtime-state file
**Context**: FR-001 says "only fields actually mutated at runtime are present." Today the only mutating writer is `worker-scaler.ts`, which writes `workers`. Other fields in `cluster.yaml` (`channel`, `variant`, `appConfig.env`, `appConfig.files`) are also mutated through the control-plane's app-config and cluster-config endpoints (e.g. `app-config.ts` writes `appConfig` into `cluster.yaml`). The spec is ambiguous about whether this fix moves only `workers` or all currently-runtime-mutated fields. A narrow scope leaves the same uncommitted-changes / merge-conflict problem in place for `appConfig` PUTs; a wide scope is a much bigger refactor.
**Question**: Which fields should this bugfix move out of `cluster.yaml` into the new runtime-state file?
**Options**:
- A: Only `workers`. Minimal scope; matches the issue title literally. Other runtime mutators (appConfig PUTs, channel changes) keep writing `cluster.yaml` until a follow-up.
- B: `workers` plus any other field currently mutated by a control-plane writer (notably `appConfig.*`). Solves the same class of bug for every known writer in one PR.
- C: `workers` for now, but reserve the runtime-state file's schema so future fields can be added without another structural change. Other writers tracked as explicit follow-up issues.

**Answer**: *Pending*

---

### Q3: Behaviour for existing projects whose `cluster.yaml` was already mutated
**Context**: FR-008 lists two possibilities ("`cluster.local.yaml` created from current `cluster.yaml` values on next scale" OR "hand-edit required") without choosing. After this fix lands, an existing project may have `cluster.yaml` with `workers: 3` committed (from past worker-scaler writes pre-fix). When that project next scales — say 3 → 5 — the orchestrator now sees template `workers: 3` (because the committed file reflects past mutation, not the original template). The choice changes what users experience on first scale after upgrade.
**Question**: On the first scale event in an existing project that has a pre-fix mutated `cluster.yaml`, what should worker-scaler do?
**Options**:
- A: Write the new count to `cluster.local.yaml` only. Leave `cluster.yaml` untouched. Effective count = `cluster.local.yaml` value (local-wins). The stale `cluster.yaml` value becomes a misleading "default" but no working-tree churn.
- B: On first scale, copy the current `cluster.yaml` `workers:` value into `cluster.local.yaml` AND reset `cluster.yaml` `workers:` to the template default (e.g. `1`). One-time working-tree change that "completes the migration." Subsequent scales touch only `cluster.local.yaml`.
- C: On first scale, only write `cluster.local.yaml`. Add a one-shot warning log/event recommending the user hand-edit `cluster.yaml` to the template default. No automatic mutation of `cluster.yaml`.

**Answer**: *Pending*

---

### Q4: Where does the read-side merge live?
**Context**: FR-003 says readers "merge `cluster.yaml` with `cluster.local.yaml` (local wins per field)." Today three places read `cluster.yaml`: `worker-scaler.ts` (writer, reads to update), `relay-bridge.ts` (`readClusterYaml()` for metadata), and `app-config.ts` (`readManifest()` for the appConfig block). The spec doesn't say whether the merge lives in one shared helper (every caller imports it) or each caller implements its own merge inline. A shared helper means a new module/export; inline keeps each call site self-contained but risks divergence.
**Question**: Where should the merge logic be implemented?
**Options**:
- A: Single shared helper (e.g. `readMergedClusterConfig()`) in `packages/control-plane/src/services/` (or `packages/config/`) — all current and future readers import it. Worker-scaler and `app-config.ts`/`relay-bridge.ts` migrate to use it.
- B: Inline merge at each read site. No new module. Each caller reads both files and shallow-merges per top-level key. Lower coordination cost; higher drift risk.
- C: Helper for orchestrator-process readers (relay-bridge, app-config); worker-scaler reads only `cluster.local.yaml` directly because it only ever cares about its own writes.

**Answer**: *Pending*

---

### Q5: Merge depth — shallow per-top-level-key or deep?
**Context**: FR-003 says "shallow per top-level key for v1; deep-merge can be added if nested keys gain runtime mutation." `cluster.yaml` contains `appConfig` as a nested object with sub-blocks (`env`, `files`, `secrets`). If Q2 = A (only `workers`), shallow is fine. If Q2 = B or C with `appConfig` in scope, shallow merge means setting any single `env` var via the local file replaces the entire `appConfig` block from the template — almost certainly wrong. The merge-depth choice is coupled to the field-scope choice in Q2.
**Question**: Should the merge be shallow per top-level key, or deep-merge nested objects?
**Options**:
- A: Shallow per top-level key (matches FR-003 default). Acceptable only if Q2 = A (only `workers` moves).
- B: Deep-merge for known nested objects (`appConfig.env`, `appConfig.files`), shallow elsewhere. Required if `appConfig` fields are in scope.
- C: Defer the decision: implement shallow now and add deep-merge in the same PR that brings the first nested-field writer into scope.

**Answer**: *Pending*

---

**How to answer**: Reply to issue #709 with your answers in the format:
```
Q1: your answer here
Q2: your answer here
Q3: your answer here
Q4: your answer here
Q5: your answer here
```
and add the `completed:clarification` label when done.

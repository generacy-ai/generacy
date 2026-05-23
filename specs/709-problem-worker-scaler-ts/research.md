# Research: Decoupling runtime state from git-tracked cluster.yaml

## Decision 1 — Sibling-file pattern (`cluster.local.yaml`)

**Decision**: Introduce a sibling file `cluster.local.yaml` in `.generacy/`, git-ignored by the cluster template, that holds runtime-mutated state. Writers target it directly; readers compose it with `cluster.yaml` at read time.

**Rationale**:
- The `*.local.*` convention is already familiar to anyone who has touched Next.js (`next.config.local.js`), Vite (`.env.local`), or any dotenv-style stack. First-glance comprehension is high.
- Pairs alphabetically with `cluster.yaml` so a directory listing visually communicates "this is the local override of that."
- Keeps the surface in one place (`.generacy/`) instead of splitting between `.generacy/` and a separate runtime dir.

**Alternatives considered**:
- `state.yaml` — different basename, more explicit "this is mutable runtime state." Rejected: more documentation overhead than `.local`, doesn't reuse a known convention, and reads as a separate concept rather than an override.
- `cluster.runtime.yaml` — explicit purpose, still visually pairs. Rejected: longer name, no ecosystem convention behind it.
- Docker named volume (`generacy-runtime`) for runtime state (spec option B) — cleaner separation but adds a new persistence surface, requires a migration path, and would make local dev iteration harder (state hidden inside a volume). Rejected for this PR; flagged as a revisit if the runtime-state surface grows substantially.
- Inlining runtime state into `cluster.json` (spec option C) — `cluster.json` is also git-tracked today, so this has the same root problem.

**Sources**:
- Issue #709 spec — "Fix options" section, recommendation A.
- Clarifications Q1, answer A.

## Decision 2 — Scope: `workers` only in this PR

**Decision**: Move only the `workers` field out of `cluster.yaml` into `cluster.local.yaml`. Other currently-mutating writers (`appConfig.env`, `appConfig.files`, `channel`) stay on `cluster.yaml` for now and are tracked as sibling follow-ups.

**Rationale**:
- Worker-scaler is the only writer named in the issue title; expanding scope re-opens the design surface.
- `appConfig.*` writes have the same bug shape **but** require deep-merge semantics (nested `env`/`files`/`secrets` blocks). Designing deep-merge speculatively is harder than designing it alongside the writer that actually needs it.
- The runtime-state file is a YAML object: adding fields later costs zero structural change.

**Alternatives considered**:
- All currently-mutated fields in one PR — biggest review surface; couples shallow-vs-deep merge decision into the bug-fix PR.
- Status-quo `workers` only with no schema reservation — same outcome but signals nothing to future contributors about extension intent. Rejected because we want the new file to read as "this is where runtime state goes" not "this is where workers go."

**Sources**: Clarifications Q2, answer C.

## Decision 3 — Existing-project behavior on first post-fix scale

**Decision**: Worker-scaler writes only to `cluster.local.yaml` and leaves any pre-existing mutated `cluster.yaml workers:` value untouched. Local-wins semantics make a stale canonical value benign.

**Rationale**:
- The whole point of the PR is "stop mutating git-tracked files." A one-shot migration mutation in the same PR that establishes the no-mutation principle would be self-contradictory.
- A stale `workers: 3` in `cluster.yaml` and `workers: 5` in `cluster.local.yaml` produces effective count = 5 via local-wins. The stale value is a documentation issue, not a correctness issue.
- The upstream merge-conflict scenario (user pulls template update with `workers: 1`, has stale local `workers: 3`) still exists for existing projects but is the same conflict they'd face under any option. New projects (post-template-update) never hit this.

**Alternatives considered**:
- Migration mutation: copy `cluster.yaml workers:` → `cluster.local.yaml`, reset `cluster.yaml workers:` to template default. Rejected: violates the PR's own principle; one-shot working-tree dirty.
- Warning log recommending user hand-edit. Rejected: log spam, user can fix organically.

**Sources**: Clarifications Q3, answer A.

## Decision 4 — Single shared merge helper

**Decision**: One shared helper `readMergedClusterConfig(generacyDir)` in `@generacy-ai/config`. All three current readers (`worker-scaler.ts`, `relay-bridge.ts`, `app-config.ts`) migrate onto it. Future readers import the same helper.

**Rationale**:
- Three call sites today; "future" already exists in design conversations (channel runtime mutation, secret refresh, app-config follow-up).
- Inline merge at each site invites drift — the same subtle bug that bit us in #549 (multiple cloud-URL fallback chains) and #594 (multiple separate IPC mechanisms).
- A single helper means future rule changes (e.g. adding deep-merge for Q5 follow-up) are one-file edits.

**Alternatives considered**:
- Inline merge at each read site (spec option B). Rejected: drift risk, repeated YAML parse code, separate test surface.
- Helper for orchestrator-process readers only; worker-scaler reads only `cluster.local.yaml` directly (spec option C). Rejected: works today (worker-scaler doesn't read cluster.yaml for behavior; only to update it) but creates inconsistent semantics across packages — a future maintainer reading `worker-scaler.ts` won't know whether to expect merged or local-only semantics.

**Sources**: Clarifications Q4, answer A.

## Decision 5 — Shallow per-top-level-key merge

**Decision**: Implement shallow per-top-level-key merge now. Defer deep-merge of nested objects to the PR that brings the first nested-field writer (`appConfig.*`) into scope.

**Rationale**:
- Only `workers` (a flat number) is moving in this PR. Shallow merge is correct and sufficient.
- Deep-merge over `appConfig.env`/`files`/`secrets` requires care: arrays-of-objects with id-like fields need merge-by-id, plain arrays might be replace-all, scalars override. That design is best made alongside the writer that needs it, with concrete test cases driving it.
- Pre-deciding deep-merge for a use case that isn't landing yet is speculative.

**Alternatives considered**:
- Deep-merge from day one. Rejected: speculative.
- Shallow forever. Rejected: forecloses on the obvious follow-up (`appConfig.*` migration).

**Sources**: Clarifications Q5, answer C.

## Implementation patterns

- **Atomic file write**: temp-in-target-dir + `rename(2)`. Already the pattern in `worker-scaler.ts:529-533`; reused in `updateClusterLocalYaml`.
- **YAML parse with permissive fallback**: `parseYaml(content) as Record<string, unknown> ?? {}`. Already the pattern in `worker-scaler.ts:494`; reused in helper for parse-then-merge.
- **`.generacy/` directory resolution**: 4-tier discovery via `resolveGeneracyDir()` in `packages/control-plane/src/services/project-dir-resolver.ts`. Helper does not duplicate this — callers pass in the resolved dir.
- **ENOENT-tolerant read**: `catch (err) { if (err.code === 'ENOENT') return null; throw err }` — used in `app-config.ts:50-53`; helper applies it to both files.

## Open questions deferred to follow-ups

- Should `cluster.local.yaml` get a JSON schema header comment so editors can validate? (Not in scope; can be added once the schema stabilizes.)
- Should orchestrator log when `cluster.local.yaml` is created vs. updated, for diagnostics? (Not in scope; metadata-refresh path already pushes the new value to cloud, where diagnostics live.)
- Migration of `appConfig.*` writes (deep-merge PR): tracked as sibling follow-up issue per spec.

## Key references

- `packages/control-plane/src/services/worker-scaler.ts` — current write site (lines 487–502 for `updateClusterYaml`).
- `packages/orchestrator/src/services/relay-bridge.ts:608-623` — current `readClusterYaml()` body.
- `packages/control-plane/src/routes/app-config.ts:42-61` — current `readManifest()` body.
- `packages/generacy/src/cli/commands/cluster/scaffolder.ts:104-112` — `scaffoldClusterYaml()` writer (template-time, no change needed).
- `packages/control-plane/src/services/project-dir-resolver.ts` — 4-tier `.generacy/` resolution.
- Companion repos: `generacy-ai/cluster-base`, `generacy-ai/cluster-microservices` — need `.gitignore` updates.

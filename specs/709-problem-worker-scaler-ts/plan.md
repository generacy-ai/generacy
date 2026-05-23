# Implementation Plan: Decouple worker-scaler runtime state from git-tracked cluster.yaml

**Feature**: Stop `worker-scaler.ts` mutating the git-tracked `.generacy/cluster.yaml`; introduce a sibling `.generacy/cluster.local.yaml` runtime-state file and a shared merged-read helper.
**Branch**: `709-problem-worker-scaler-ts`
**Status**: Complete

## Summary

Today `worker-scaler.ts` updates `workers:` in `.generacy/cluster.yaml` on every successful scale. That file is part of the cluster-base / cluster-microservices template merged into the user's project repo on creation, and is therefore git-tracked. Every scale dirties the working tree, can produce upstream merge conflicts, and can be silently destroyed by `git restore .` or `--clean` re-clones.

This change introduces a sibling **`.generacy/cluster.local.yaml`** runtime-state file that is `.gitignore`d by the template, and moves the `workers` write there. A new shared helper `readMergedClusterConfig()` returns the shallow-merged view (`cluster.local.yaml` wins per top-level key) and replaces the three current ad-hoc readers (`worker-scaler.ts`, `relay-bridge.ts`'s `readClusterYaml()`, `app-config.ts`'s `readManifest()`).

Scope is intentionally narrow per the clarifications: **only `workers`** moves in this PR, with shallow per-top-level-key merge; `appConfig.*` and deep-merge are filed as follow-ups.

## Technical Context

**Language/Version**: TypeScript (ESM), Node >=22
**Primary Dependencies**: `yaml` (parse/stringify), `node:fs/promises`, `zod` (validation in `@generacy-ai/config`)
**Storage**: File-based — `.generacy/cluster.yaml` (git-tracked, read-only after this PR for the `workers` field) and `.generacy/cluster.local.yaml` (git-ignored, writable)
**Testing**: Vitest (unit for merge helper + worker-scaler write path; integration via existing worker-scaler test suite)
**Target Platform**: Linux container (cluster-base / cluster-microservices images)
**Project Type**: Monorepo (pnpm workspaces)
**Constraints**: Template `.gitignore` update lives in companion `cluster-base` and `cluster-microservices` repos (out-of-scope for this repo's PR but tracked as a blocker for the user-visible fix).

## Project Structure

### Documentation (this feature)

```text
specs/709-problem-worker-scaler-ts/
├── spec.md              # Feature specification (read-only)
├── clarifications.md    # Resolved Q1–Q5
├── plan.md              # This file
├── research.md          # Technology decisions
├── data-model.md        # Types and interfaces
├── contracts/           # No new HTTP contracts (file-format contract only)
└── quickstart.md        # Testing/usage guide
```

### Source Code (files to modify/create)

```text
packages/config/                                  # NEW reader helper lives here
├── src/
│   ├── cluster-config.ts                         # NEW: readMergedClusterConfig(generacyDir)
│   ├── cluster-config-schema.ts                  # NEW: ClusterYamlSchema + ClusterLocalYamlSchema (Zod)
│   └── index.ts                                  # ADD exports
└── __tests__/
    └── cluster-config.test.ts                    # NEW: unit tests for merge semantics

packages/control-plane/
├── package.json                                  # ADD @generacy-ai/config dep
├── src/
│   ├── services/
│   │   └── worker-scaler.ts                      # MODIFY: write to cluster.local.yaml; drop cluster.yaml write
│   └── routes/
│       └── app-config.ts                         # MODIFY: readManifest() → readMergedClusterConfig().appConfig
└── __tests__/
    └── services/worker-scaler.test.ts            # MODIFY: assert writes go to cluster.local.yaml
        routes/app-config.test.ts                 # MODIFY: feed merged input via fixtures (no behavior change)

packages/orchestrator/
└── src/services/
    └── relay-bridge.ts                           # MODIFY: readClusterYaml() → readMergedClusterConfig()
        services/__tests__/relay-bridge.test.ts   # MODIFY: fixture path covers merged read
```

### Companion repos (out-of-scope for this PR; tracked as follow-ups)

- `generacy-ai/cluster-base` — add `cluster.local.yaml` to template `.gitignore`.
- `generacy-ai/cluster-microservices` — same.

## Implementation Phases

### Phase 1: Shared merged-read helper (no behavior change yet)

1. Add `packages/config/src/cluster-config-schema.ts`:
   - `ClusterYamlSchema` — full superset of fields used by current readers (`workers?: number`, `channel?: 'preview'|'stable'`, `variant?`, `appConfig?: AppConfig | undefined`). All fields optional. (Re-export `AppConfigSchema` shape — keep cross-package dep minimal; use a `z.unknown().optional()` passthrough for `appConfig` and let the caller re-parse with its own schema if needed.)
   - `ClusterLocalYamlSchema` — currently `{ workers?: number }`. Schema is intentionally a permissive `z.object({...}).passthrough()` so future fields can be added without lock-in.
2. Add `packages/config/src/cluster-config.ts`:
   - `readMergedClusterConfig(generacyDir: string): Promise<MergedClusterConfig>` — reads both files (ENOENT → `{}`), parses each, returns a shallow per-top-level-key merge with `cluster.local.yaml` winning. Also returns each file's raw parsed form for callers that need to write back to a specific file (worker-scaler writes only to local; app-config writes only to canonical).
   - Returns `{ merged, canonical, local }` shape so callers can disambiguate read vs. write targets without re-parsing.
3. Export from `packages/config/src/index.ts`.
4. Unit tests in `packages/config/__tests__/cluster-config.test.ts`:
   - Both files missing → empty merged.
   - Only canonical present → equals canonical.
   - Only local present → equals local.
   - Both present, disjoint keys → union.
   - Both present, overlapping key (e.g. `workers`) → local wins.
   - Local present, malformed YAML → throw with helpful message (fail loud — don't silently fall through to canonical).
   - Canonical malformed YAML → throw (same).

### Phase 2: Migrate worker-scaler write path

5. `packages/control-plane/package.json`: add `"@generacy-ai/config": "workspace:*"` dependency.
6. `packages/control-plane/src/services/worker-scaler.ts`:
   - Add `updateClusterLocalYaml(localYamlPath, count)` — same atomic temp+rename pattern as the existing `updateClusterYaml`, but parses local file (not canonical), sets `workers`, writes back.
   - In `doScale()`, replace the existing `updateClusterYaml(yamlPath, actualCount)` call with `updateClusterLocalYaml(join(generacyDir, 'cluster.local.yaml'), actualCount)`.
   - Delete the now-unused `updateClusterYaml` export (or keep it un-exported for one release if external callers exist — verify with grep; nothing in this repo calls it externally).
   - Read-side: nothing changes for worker-scaler's own logic — it reads worker count from the Docker Engine (`enumerateWorkers`), not from `cluster.yaml`. So no read-path migration here. (Worker-scaler's only use of `cluster.yaml` was the write; the spec's Q4 statement that worker-scaler "still reads `cluster.yaml` today to update the field" referred to the read-then-write inside `updateClusterYaml`; that read now targets `cluster.local.yaml` instead.)
7. Update `packages/control-plane/__tests__/services/worker-scaler.test.ts`:
   - Existing tests that fixture `cluster.yaml` and assert post-scale value move to fixture `cluster.local.yaml`.
   - New negative assertion: after `scaleWorkers(...)`, `cluster.yaml` content is byte-identical to its pre-scale content (proves no write happens to git-tracked file).

### Phase 3: Migrate relay-bridge read path

8. `packages/orchestrator/src/services/relay-bridge.ts`:
   - Replace `readClusterYaml()` (lines 608–623) body with a call to `readMergedClusterConfig(dirname(this.config.clusterYamlPath))`. Keep the existing return shape (`{ workers?, channel? }`) so `collectMetadata()` (line 545) is untouched.
   - Make the method `async` (the helper is async). Propagate `await` into `collectMetadata()`/`sendMetadata()` — both are already async per #596 fix.
9. Update `packages/orchestrator/src/services/__tests__/relay-bridge.test.ts` and `relay-bridge-metadata.test.ts`:
   - Fixture both `cluster.yaml` and `cluster.local.yaml` in the test temp dir.
   - Existing test asserting `workers` is read from yaml still works; new test confirms `cluster.local.yaml`'s `workers` overrides `cluster.yaml`'s.

### Phase 4: Migrate app-config read path

10. `packages/control-plane/src/routes/app-config.ts`:
    - Replace `readManifest()` (lines 42–61) body with `readMergedClusterConfig(await resolveGeneracyDir())`, then validate the `merged.appConfig` block with the existing `AppConfigSchema`.
    - Behavior preserved: ENOENT on either file → `null` if `appConfig` absent; otherwise parsed.
    - Note: `appConfig.*` writes still target `cluster.yaml` (out-of-scope per Q2=C). The read merge only matters if a follow-up moves them to local; for now `cluster.local.yaml` won't contain `appConfig` so the shallow merge is a no-op for this block.
11. Update `packages/control-plane/__tests__/routes/app-config.test.ts`:
    - Existing fixtures still pass (only `cluster.yaml` in fixture → read returns its `appConfig`).
    - New regression test: when `cluster.local.yaml` exists but lacks `appConfig`, `readManifest()` still returns `cluster.yaml`'s `appConfig` unchanged.

### Phase 5: Cross-cutting checks

12. Grep for any remaining direct `cluster.yaml` reads in `packages/control-plane` and `packages/orchestrator` `src/`. Migrate any not covered above onto the helper, or document why they should not (e.g. `cluster/context.ts` in CLI is host-side template parsing, out-of-scope).
13. Build + test all affected packages: `pnpm --filter @generacy-ai/config build test`, then control-plane, then orchestrator.

## Key Technical Decisions

| Decision | Rationale | Source |
|----------|-----------|--------|
| Sibling file named `cluster.local.yaml` | `*.local.*` convention (Next.js, Vite, dotenv); visually pairs with `cluster.yaml`. | Q1=A |
| Only `workers` moves in this PR | Minimal structural change; `appConfig.*` requires deep-merge — bundled with a separate PR. Runtime-state schema reserved/extensible (YAML object) so future fields drop in without further structural change. | Q2=C |
| Existing projects: leave pre-fix `cluster.yaml workers:` untouched | "Stop mutating git-tracked files" applies to the migration too; local-wins makes a stale value benign. No one-shot migration mutation. | Q3=A |
| Shared helper in `@generacy-ai/config` | Single source of truth for merge semantics; three current readers + future readers all use it. Avoids drift. | Q4=A |
| Shallow per-top-level-key merge | Sufficient for `workers` (flat number). Deep-merge designed alongside the first nested-field writer migration. | Q5=C |
| Atomic temp+rename writes | Already the pattern in `worker-scaler.ts`; preserves crash safety. | existing code |
| Helper returns `{ merged, canonical, local }` | Callers that read (app-config, relay-bridge) use `merged`; future writers can target `local` or `canonical` deliberately. | new |
| Malformed local YAML → throw, not silently fall through | Fail loud on corruption; silent fallthrough hides real bugs. | new |

## Constitution Check

No `.specify/memory/constitution.md` is present in this repo (verified via `Glob`). No constitution-mandated gates apply.

Independent check against repo conventions captured in `CLAUDE.md`:
- Adds no comments beyond the WHY (per "Default to writing no comments" rule).
- Does not add backwards-compatibility shims (per "Avoid backwards-compatibility hacks"): the helper replaces, doesn't wrap, the three legacy reads.
- No new error-handling for impossible scenarios; only validates at the file boundary.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Template `.gitignore` update lands later than this PR — fresh launches still commit `cluster.local.yaml` until then | Filed as companion PRs against `cluster-base` and `cluster-microservices`. This PR's spec acceptance ("git status clean after scale") only holds once those land; document in PR description. |
| Helper is now sync-blocking for what was an inline read | `readClusterYaml()` in relay-bridge already runs on the metadata heartbeat (not a hot path); making it async via `fs/promises` keeps it consistent with the other migrated callers. |
| Existing projects with mutated `cluster.yaml workers:` see "wrong" template default in cloud UI | Per Q3=A this is intentional. Cloud UI displays merged value; only the canonical file's default looks stale. Documentation issue, not correctness. |
| Adding `@generacy-ai/config` as a control-plane dep introduces a new package boundary | `@generacy-ai/config` is already small and used by orchestrator. The helper is pure (file I/O + YAML parse); no transitive deps surprises. |
| Helper malformed-YAML throw could crash callers that previously absorbed errors | Worker-scaler's old `updateClusterYaml` swallowed parse errors (`catch { doc = {}; }`). For consistency on the **read** side we throw; for the **write** side we preserve the existing tolerant pattern. Callers that read on a hot path (relay-bridge) already wrap in try/catch returning `null`. |

## Dependencies

- **Companion PR (cluster-base)**: add `cluster.local.yaml` to the template `.gitignore`. Without this, fresh launches will still commit the new file on first scale.
- **Companion PR (cluster-microservices)**: same.
- **Internal**: `resolveGeneracyDir()` from `packages/control-plane/src/services/project-dir-resolver.ts` — used unchanged.
- **Internal**: `@generacy-ai/config` package — gains a new module.

## Out of Scope (re-stated for traceability)

- Migrating existing projects' `cluster.yaml workers:` to `cluster.local.yaml`. New projects from updated templates get the right shape; existing projects rely on local-wins (Q3=A).
- Moving `appConfig.*` (and any other currently-mutating writer beyond worker-scaler) onto the runtime-state file. Same bug shape, separate PR because it needs deep-merge. (Sibling follow-up.)
- Deep-merge of nested objects in `readMergedClusterConfig`. Deferred to the `appConfig.*` migration PR (Q5=C).
- Channel switching (`channel:`) migration. Out of scope until/unless a runtime writer exists for it — today the field is read-only at runtime.

## Suggested Next Step

`/speckit:tasks` to generate the dependency-ordered task list.

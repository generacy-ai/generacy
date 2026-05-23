# Feature Specification: Decouple worker-scaler runtime state from git-tracked cluster.yaml

**Branch**: `709-problem-worker-scaler-ts` | **Date**: 2026-05-23 | **Status**: Draft
**Issue**: [#709](https://github.com/generacy-ai/generacy/issues/709)
**Workflow**: speckit-bugfix

## Summary

`worker-scaler.ts` mutates `<repo>/.generacy/cluster.yaml` on every successful scale event. That file is shipped by the cluster-base/microservices templates and is git-tracked inside the user's project repo. Treating a git-tracked, template-owned file as runtime state creates four concrete failure modes — uncommitted-tree noise, template-pull merge conflicts, accidental overwrite by `git checkout`/`restore`, and total wipe on forced re-clone.

The root cause is that one file is being used for two purposes: **launch-time defaults** (belong in git) and **per-cluster runtime state** (must not be in git). This bugfix splits those roles by introducing a sibling, `.gitignore`d file for runtime state, and updating worker-scaler + readers to merge template + local with local-wins precedence.

## Problem

`worker-scaler.ts` writes the user's `<repo>/.generacy/cluster.yaml` on every successful scale. That file lives **inside the user's git-tracked project repo** (it's part of the cluster-base/microservices template merged into the new repo on project creation).

Implications:

1. **Uncommitted changes** sit in the user's working tree after every scale. `git status` shows a dirty file the user didn't edit. Workflows that check for a clean tree before publishing/releasing will flag it.
2. **Merge conflicts**: if the user pulls upstream changes to cluster-base (or microservices) and the template's `workers:` value differs from the locally-scaled value, `git pull` produces a conflict in a file the user has no intent of owning runtime state for.
3. **Accidental destruction**: `git checkout .`, `git restore .`, or some IDE clean-up actions overwrite the scaled value. Next metadata refresh shows the wrong count.
4. **Forced re-clone scenarios** (e.g. `generacy setup workspace --clean`) wipe the scaled value entirely.

## Why this is structural, not cosmetic

The fundamental mismatch: `cluster.yaml` is being used for two different things:
- **Source-of-truth launch defaults** that ship in the template repo. Properly git-tracked.
- **Per-cluster runtime state** mutated by the orchestrator. Should not be git-tracked.

Conflating these two roles in one git-tracked file is the root cause. Worker count, channel selection, future runtime knobs all have the same problem: they're declared in the template, mutated at runtime, and the template-vs-state distinction is lost.

## Fix options considered

**A. Split into two files** *(recommended)*: `cluster.yaml` stays git-tracked and holds launch-time defaults (`workers: 1`, `channel: stable`, etc.). Runtime overrides go into `cluster.local.yaml` (or `.generacy/state.yaml`) which is `.gitignore`d by the template. Worker-scaler writes only to the local file; orchestrator merges template + local at read time, with local winning. The cloud UI's Cluster Config endpoint reads the merged view.

**B. Move runtime state into a docker-volume mount**: a separate `generacy-runtime` named volume holds `workers` and `channel` state at `/var/lib/generacy/runtime.yaml` (or similar). `cluster.yaml` becomes read-only documentation of defaults. State persists across container restarts (named volume) and never touches the git repo.

**C. Inline state into cluster.json**: `cluster.json` already exists in `.generacy/` and contains identity fields (cluster_id, project_id, etc.). Could extend it with a `runtime: { workers, channel }` block. But `cluster.json` is also git-tracked today; same problem.

Option A is the smallest disruption — keeps the existing surface, adds a sibling file. Option B is cleanest separation but adds infrastructure.

**Recommendation: A**, with a follow-up to revisit B if the runtime-state surface grows.

## User Stories

### US1: Clean working tree after scale (Primary)

**As a** developer using a Generacy cluster on a project repo,
**I want** scaling worker count to leave my git working tree clean,
**So that** CI-style "no uncommitted changes" gates pass and `git status` only shows files I actually edited.

**Acceptance Criteria**:
- [ ] After `worker-scaler` runs to completion, `git status` in the project repo is identical to before the scale.
- [ ] No file under version control in `.generacy/` is modified by a scale event.

### US2: Survive template upstream pulls without conflict

**As a** developer pulling updated `cluster-base`/`cluster-microservices` template changes into my project repo,
**I want** locally-set worker count to be preserved without producing a merge conflict,
**So that** I can take template upgrades without manual conflict resolution every time.

**Acceptance Criteria**:
- [ ] Pulling a template change that touches `workers:` in `cluster.yaml` does not produce a conflict when the local cluster has been scaled.
- [ ] Post-pull, the cluster continues to operate at the locally-scaled count (local wins).

### US3: Survive `git checkout`/`restore` without losing scale state

**As a** developer using IDE clean-up or `git restore .`,
**I want** my locally-scaled worker count to persist,
**So that** routine working-tree resets don't silently change cluster capacity.

**Acceptance Criteria**:
- [ ] Running `git checkout .` or `git restore .` in the project repo does not alter the orchestrator-observed worker count.
- [ ] Next metadata refresh from the orchestrator reports the pre-checkout scaled value.

### US4: Orchestrator/cloud read merged view

**As an** orchestrator (and the cloud Cluster Config endpoint),
**I want** to read a merged template+local view of cluster config,
**So that** callers see the effective runtime state without needing to know about the split.

**Acceptance Criteria**:
- [ ] Read path returns `local` value where set, falling back to `cluster.yaml` template default otherwise.
- [ ] Cloud UI "Cluster Config" view reflects the merged value, not the raw template.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Introduce `.generacy/cluster.local.yaml` as the runtime-state file. Schema is a partial of `cluster.yaml` — only fields actually mutated at runtime are present. | P1 | Filename TBD in clarify; `cluster.local.yaml` vs `.generacy/state.yaml` — recommendation is `cluster.local.yaml` (mirrors `*.local.*` convention). |
| FR-002 | `worker-scaler.ts` writes only to `cluster.local.yaml`. It must not modify `cluster.yaml`. | P1 | Core behavior change. |
| FR-003 | Cluster config readers (orchestrator, control-plane, cloud Cluster Config endpoint) merge `cluster.yaml` (defaults) with `cluster.local.yaml` (overrides), with local winning per field. | P1 | Merge is shallow per top-level key for v1; deep-merge can be added if nested keys gain runtime mutation. |
| FR-004 | `cluster.local.yaml` is added to `.gitignore` in the cluster-base and cluster-microservices templates. | P1 | New projects pick this up automatically. |
| FR-005 | If `cluster.local.yaml` is missing, readers must fall back cleanly to `cluster.yaml` only — no error, no warning. | P1 | First scale creates the file; pre-first-scale state is fully template-driven. |
| FR-006 | Writes to `cluster.local.yaml` are atomic (temp+rename) to prevent partial-write corruption under concurrent scale operations. | P1 | Existing atomic-write helper should be reused if one exists in the workspace. |
| FR-007 | Worker-scaler must not create or modify any git-tracked file in the project repo as part of a normal scale operation. | P1 | Validated by SC-001. |
| FR-008 | Existing projects (created before this fix) need a documented migration path: either `cluster.local.yaml` is created from current `cluster.yaml` values on next scale, or a hand-edit is required. | P2 | Out of scope: automated `generacy migrate` tooling. In scope: behavior on first scale must be safe — overwrite current `cluster.yaml` mutation pattern. |
| FR-009 | Cloud UI "Cluster Config" endpoint response shape is unchanged. The merge happens server-side / in-orchestrator before exposing to the UI. | P2 | Backwards compatibility for the cloud-side consumer. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `git status` in the project repo immediately after a scale event | Clean (zero modified, zero new files) | Manual test: scale 1→2, run `git status` |
| SC-002 | `git pull` of a template-upstream change that touches `cluster.yaml`'s `workers:` field, with a locally-scaled value | Pull succeeds, no merge conflict, locally-scaled value preserved | Manual test: branch with diverging template `workers:`, scaled local; merge |
| SC-003 | `git restore .` after scaling | Orchestrator continues to observe the scaled worker count | Manual test: scale 1→3, `git restore .`, observe orchestrator state |
| SC-004 | `cluster.local.yaml` not committed by accident | File appears in `.gitignore` and `git check-ignore .generacy/cluster.local.yaml` returns the path | `git check-ignore` invocation post-template-update |
| SC-005 | Read-side merge correctness | Where local sets `workers: 3` and template has `workers: 1`, the merged read returns `3` | Unit test on the merge function |
| SC-006 | Fallback when local file absent | Reads with no `cluster.local.yaml` return the template values, with no error path triggered | Unit test on the merge function |

## Assumptions

- The `.gitignore` for `.generacy/cluster.local.yaml` ships from the cluster-base and cluster-microservices template repos. This generacy-repo PR coordinates the read/write split; the template-repo PR adds the `.gitignore` entry. Both must land for new projects to benefit.
- Only `workers` is currently mutated at runtime by worker-scaler. The split design accommodates future fields (e.g. `channel`) without further structural change.
- Orchestrator and cloud are the only readers of `cluster.yaml` config values. CLI commands (e.g. `generacy status`) read through the orchestrator or fall back to template-only — to be verified during plan.
- Concurrent scale operations are already serialized by worker-scaler's existing locking (or are single-flight by construction). This bugfix does not introduce new concurrency surface.

## Out of Scope

- Automated migration tooling (`generacy migrate`) for existing projects whose `cluster.yaml` has already been mutated by past scale events. Hand-edit or first-scale overwrite is acceptable.
- Adopting Option B (named docker volume for runtime state). Tracked as a follow-up if runtime-state surface grows.
- Adopting Option C (`cluster.json` extension). Rejected because `cluster.json` is itself git-tracked.
- Resolving `.env` drift from issue [#708](https://github.com/generacy-ai/generacy/issues/708). Related but separate fix.
- Backporting the split to projects scaffolded before the template change.

## Related

- [#706](https://github.com/generacy-ai/generacy/issues/706) — established `cluster.yaml` as the runtime-mutated source-of-truth without addressing the git-tracking implication.
- [#708](https://github.com/generacy-ai/generacy/issues/708) — same source-of-truth question seen from a different angle (`.env` drift). Likely best fixed together at the conceptual level, but mechanics differ.

---

*Generated by speckit*

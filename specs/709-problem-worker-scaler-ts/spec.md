# Feature Specification: ## Problem

\`worker-scaler

**Branch**: `709-problem-worker-scaler-ts` | **Date**: 2026-05-23 | **Status**: Draft

## Summary

## Problem

\`worker-scaler.ts\` writes the user's \`<repo>/.generacy/cluster.yaml\` on every successful scale. That file lives **inside the user's git-tracked project repo** (it's part of the cluster-base/microservices template merged into the new repo on project creation).

Implications:

1. **Uncommitted changes** sit in the user's working tree after every scale. \`git status\` shows a dirty file the user didn't edit. Workflows that check for a clean tree before publishing/releasing will flag it.
2. **Merge conflicts**: if the user pulls upstream changes to cluster-base (or microservices) and the template's \`workers:\` value differs from the locally-scaled value, \`git pull\` produces a conflict in a file the user has no intent of owning runtime state for.
3. **Accidental destruction**: \`git checkout .\`, \`git restore .\`, or some IDE clean-up actions overwrite the scaled value. Next metadata refresh shows the wrong count.
4. **Forced re-clone scenarios** (e.g. \`generacy setup workspace --clean\`) wipe the scaled value entirely.

## Why this is structural, not cosmetic

The fundamental mismatch: \`cluster.yaml\` is being used for two different things:
- **Source-of-truth launch defaults** that ship in the template repo. Properly git-tracked.
- **Per-cluster runtime state** mutated by the orchestrator. Should not be git-tracked.

Conflating these two roles in one git-tracked file is the root cause. Worker count, channel selection, future runtime knobs all have the same problem: they're declared in the template, mutated at runtime, and the template-vs-state distinction is lost.

## Fix options

**A. Split into two files**: \`cluster.yaml\` stays git-tracked and holds launch-time defaults (\`workers: 1\`, \`channel: stable\`, etc.). Runtime overrides go into \`cluster.local.yaml\` (or \`.generacy/state.yaml\`) which is \`.gitignore\`d by the template. Worker-scaler writes only to the local file; orchestrator merges template + local at read time, with local winning. The cloud UI's Cluster Config endpoint reads the merged view.

**B. Move runtime state into a docker-volume mount**: a separate \`generacy-runtime\` named volume holds \`workers\` and \`channel\` state at \`/var/lib/generacy/runtime.yaml\` (or similar). \`cluster.yaml\` becomes read-only documentation of defaults. State persists across container restarts (named volume) and never touches the git repo.

**C. Inline state into cluster.json**: \`cluster.json\` already exists in \`.generacy/\` and contains identity fields (cluster_id, project_id, etc.) that look more like runtime state than template config. Could extend it with a \`runtime: { workers, channel }\` block. But \`cluster.json\` is also git-tracked today; same problem.

Option A is the smallest disruption — keeps the existing surface, adds a sibling file. Option B is cleanest separation but adds infrastructure.

Recommendation: **A**, with a follow-up to revisit B if the runtime-state surface grows.

## Resolved decisions (from clarifications.md)

- **Runtime-state filename** (Q1): \`cluster.local.yaml\`, sibling of \`cluster.yaml\` in \`.generacy/\`. Mirrors the \`*.local.*\` convention (Next.js, Vite, dotenv). Added to the template \`.gitignore\` so it never enters the user's repo.
- **Scope of fields moved** (Q2): \`workers\` only in this PR. The runtime-state schema is reserved/extensible (YAML object) so future fields can be added without another structural change. \`appConfig.*\` and other currently-mutating writers stay on \`cluster.yaml\` and are tracked as explicit follow-up issues.
- **Existing-project behaviour** (Q3): Worker-scaler writes only to \`cluster.local.yaml\` and leaves any pre-existing mutated \`cluster.yaml\` untouched. Local-wins semantics make a stale \`workers:\` value in \`cluster.yaml\` benign. No migration mutation, no warning prompt, no hand-edit required.
- **Read-side merge location** (Q4): Single shared helper (e.g. \`readMergedClusterConfig()\`). All three current readers (\`worker-scaler.ts\`, \`relay-bridge.ts\`'s \`readClusterYaml()\`, \`app-config.ts\`'s \`readManifest()\`) migrate onto it, and future readers import the same helper.
- **Merge depth** (Q5): Shallow per top-level key for this PR. Deep-merge is deferred to the PR that brings the first nested-field writer (\`appConfig.*\`) into scope, where the nested use case can drive the design.

## Out of scope

- Migrating existing projects' \`cluster.yaml\` to \`cluster.local.yaml\`. New projects from cluster-base/microservices templates get the right shape; existing projects rely on local-wins semantics to stay correct without mutation (Q3=A).
- Moving \`appConfig.*\` writes (and any other currently-mutating writer beyond worker-scaler) onto the runtime-state file. Same bug shape, same fix shape, but bundled with deep-merge semantics — filed as a sibling follow-up issue.
- Deep-merge of nested objects in the read-side helper. Deferred until the first nested-field writer is migrated.

## Related

- [#706](https://github.com/generacy-ai/generacy/issues/706) — established cluster.yaml as the runtime-mutated source-of-truth without addressing the git-tracking implication.
- [#708](https://github.com/generacy-ai/generacy/issues/708) — same source-of-truth question seen from a different angle (\`.env\` drift). The two are likely best fixed together.

## Acceptance

- Worker-scale does not modify any git-tracked file in the user's project repo.
- \`git status\` after scaling is clean.
- A pull from the template upstream does not conflict with locally-set runtime state.

## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*

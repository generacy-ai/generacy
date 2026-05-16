# Implementation Plan: Sync launch scaffolder docker-compose with cluster-base

**Feature**: Add missing app-config tmpfs and volume entries to `npx generacy launch` scaffolder
**Branch**: `634-summary-npx-generacy-launch`
**Status**: Complete

## Summary

The `scaffoldDockerCompose()` function in `packages/generacy/src/cli/commands/cluster/scaffolder.ts` is missing four entries that were added to the canonical cluster-base compose in cluster-base#38. This causes app-config persistence and secret env rendering to break on every freshly scaffolded cluster. The fix adds:

1. A tmpfs mount for `/run/generacy-app-config` (both services)
2. A named volume `generacy-app-config-data` on orchestrator (rw) and worker (ro)
3. A top-level volume declaration for `generacy-app-config-data`

This is a small, surgical change to one source file and its corresponding test file.

## Technical Context

**Language/Version**: TypeScript, ESM, Node >= 22
**Primary Dependencies**: `yaml` (for compose file serialization), `vitest` (testing)
**Testing**: `vitest` — unit tests in `__tests__/scaffolder.test.ts`
**Target Platform**: CLI (`npx generacy launch`)
**Project Type**: Monorepo package (`packages/generacy`)

## Constitution Check

No `.specify/memory/constitution.md` found. No gates to check.

## Project Structure

### Documentation (this feature)

```text
specs/634-summary-npx-generacy-launch/
├── spec.md              # Feature specification (read-only)
├── plan.md              # This file
├── research.md          # Technology decisions
├── data-model.md        # Data model (compose YAML shape)
└── quickstart.md        # Verification guide
```

### Source Code (repository root)

```text
packages/generacy/src/cli/commands/cluster/
├── scaffolder.ts                         # PRIMARY: add tmpfs + volumes
└── __tests__/
    └── scaffolder.test.ts                # PRIMARY: add assertions
```

**Structure Decision**: No new files needed. Two existing files modified.

## Implementation Details

### Change 1: Add app-config tmpfs mount (FR-001)

**File**: `scaffolder.ts:162-165`

Add `/run/generacy-app-config:mode=1750,uid=1000,gid=1000` to the `tmpfsMounts` array. This array is shared by both orchestrator (line 181) and worker (line 211) services.

### Change 2: Add orchestrator app-config volume (FR-002)

**File**: `scaffolder.ts:156-160`

Add `generacy-app-config-data:/var/lib/generacy-app-config` to the `orchestratorVolumes` array. Read-write (no suffix).

### Change 3: Add worker app-config volume (FR-003)

**File**: `scaffolder.ts:210`

Worker currently uses `sharedVolumes` directly. Add `generacy-app-config-data:/var/lib/generacy-app-config:ro` to the worker volumes. Two approaches:
- **Option A** (minimal): Inline spread `[...sharedVolumes, 'generacy-app-config-data:/var/lib/generacy-app-config:ro']`
- **Option B** (named): Create `workerVolumes` array mirroring `orchestratorVolumes` pattern

Prefer **Option A** for minimal diff — the worker only needs one extra volume beyond shared.

### Change 4: Add top-level volume declaration (FR-004)

**File**: `scaffolder.ts:247-255`

Add `'generacy-app-config-data': null` to the top-level `volumes` object.

### Change 5: Update tests (FR-005)

**File**: `__tests__/scaffolder.test.ts`

Add assertions to existing tests and/or new test cases:
- Extend tmpfs test (line 185-193) to assert `/run/generacy-app-config:mode=1750,uid=1000,gid=1000` on both services
- Add test: orchestrator has `generacy-app-config-data:/var/lib/generacy-app-config` (rw)
- Add test: worker has `generacy-app-config-data:/var/lib/generacy-app-config:ro` (ro)
- Extend named volumes test (line 303-313) to assert `generacy-app-config-data`

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Existing tests break | Low | Changes are additive — no existing entries removed |
| Deploy command also needs update | None | Deploy uses same `scaffoldDockerCompose()` function |
| Future drift recurrence | Medium | Out of scope (follow-up CI lint guard) |

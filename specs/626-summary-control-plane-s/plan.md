# Implementation Plan: Control-plane GET /app-config/manifest envelope mismatch

**Feature**: Fix `handleGetManifest` response envelope to return bare `AppConfig | null`
**Branch**: `626-summary-control-plane-s`
**Status**: Complete

## Summary

The control-plane's `handleGetManifest` handler wraps the response in `{ appConfig: <manifest|null> }` instead of returning the bare manifest object. The cloud expects `{ schemaVersion, env, files }` directly (matching `appConfigManifestSchema`). This is a one-line production fix plus test updates.

## Technical Context

**Language/Version**: TypeScript (ESM), Node >=20
**Primary Dependencies**: `zod`, `yaml`, `node:http`
**Storage**: N/A (reads `cluster.yaml` from filesystem)
**Testing**: Vitest (`vitest run`)
**Target Platform**: Linux (in-cluster Unix-socket service)
**Project Type**: Monorepo package (`packages/control-plane`)
**Constraints**: Zero-downtime fix — response shape change is backwards-compatible with cloud's existing `appConfigManifestSchema`

## Constitution Check

No `.specify/memory/constitution.md` found. No gates to check.

## Project Structure

### Documentation (this feature)

```text
specs/626-summary-control-plane-s/
├── spec.md              # Feature specification (read-only)
├── clarifications.md    # No clarifications needed
├── plan.md              # This file
├── research.md          # Root cause analysis
├── data-model.md        # Response shape contract
└── quickstart.md        # Verification steps
```

### Source Code (affected files)

```text
packages/control-plane/
├── src/routes/app-config.ts           # Line 111: production fix
└── __tests__/routes/app-config.test.ts # Lines 99-101, 121-126, 133-134: test updates
```

## Change Detail

### 1. Production Fix — `app-config.ts:111`

**Before**:
```ts
res.end(JSON.stringify({ appConfig }));
```

**After**:
```ts
res.end(JSON.stringify(appConfig));
```

This aligns `handleGetManifest` with the sibling `handleGetValues` (line 157), which already returns the bare shape `{ env: [...], files: [...] }`.

### 2. Test Updates — `app-config.test.ts`

Three test cases assert the old envelope shape (`body.appConfig`). Each must be updated to assert the bare shape:

| Test | Line | Old Assertion | New Assertion |
|------|------|---------------|---------------|
| "returns null when no appConfig" | 99-100 | `body.appConfig` is null | `body` is null |
| "returns parsed appConfig when present" | 121-125 | `body.appConfig.env` | `body.env`, `body.files`, `body.schemaVersion` |
| "returns null when cluster.yaml does not exist" | 133-134 | `body.appConfig` is null | `body` is null |

The updated tests should also assert SC-001: when non-null, top-level keys are `schemaVersion`, `env`, `files` (no `appConfig` wrapper).

## Risk Assessment

- **Blast radius**: One handler, one response shape. No other consumers in-cluster.
- **Backwards compatibility**: Cloud already has a defensive unwrap (generacy-cloud#588) that becomes a no-op.
- **Rollback**: Revert single commit.

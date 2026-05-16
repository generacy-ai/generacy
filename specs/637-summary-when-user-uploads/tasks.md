# Tasks: Boot-render uploaded file blobs on container recreate

**Input**: Design documents from `/specs/637-summary-when-user-uploads/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Export shared helpers

- [ ] T001 [US1] Export `isPathDenied()` from `packages/control-plane/src/routes/app-config.ts` — add `export` keyword to the function at line 30; no logic change
- [ ] T002 [US1] Export `readManifest()` from `packages/control-plane/src/routes/app-config.ts` — add `export` keyword to the function at line 43; no logic change

## Phase 2: Core implementation

- [ ] T003 [US1] Extract `atomicWriteFile()` private method on `AppConfigFileStore` (`packages/control-plane/src/services/app-config-file-store.ts`) — move temp+datasync+rename+mkdir logic from `setFile()` lines 89-99 into a reusable `private async atomicWriteFile(absPath: string, data: Buffer): Promise<void>` method
- [ ] T004 [US1] Refactor `setFile()` to call `this.atomicWriteFile()` — replace inline atomic-write block at lines 89-99 with a call to the new helper; verify no behavior change
- [ ] T005 [US1] [US2] Add `renderAll(readManifest)` method to `AppConfigFileStore` — iterate `values.yaml` file metadata, resolve `mountPath` from manifest, validate via `isPathDenied()`, fetch encrypted blob from backend, decode base64, write atomically; return `{ rendered: string[], failed: string[] }`; emit structured log `{ event: "files-rendered", count, skipped }`; handle all edge cases (disabled store, orphaned blob, missing manifest entry, denylisted path, EACCES)

## Phase 3: Wiring

- [ ] T006 [US1] Wire file boot-render in `packages/control-plane/bin/control-plane.ts` — import `readManifest` from `app-config.ts`; call `appConfigFileStore.renderAll(readManifest)` after the secret env render block (after line 152); add failures to `initResult.warnings[]`; wrap in try/catch matching existing pattern

## Phase 4: Tests

- [ ] T007 [P] [US1] Unit test: `renderAll()` happy path — upload file via `setFile()`, call `renderAll()` with mock manifest, verify file written to `mountPath` and `rendered` array contains the id
- [ ] T008 [P] [US2] Unit test: denylisted `mountPath` skipped — manifest declares `/etc/foo`, verify file skipped with structured warning, added to `failed[]`
- [ ] T009 [P] [US2] Unit test: missing blob in backend — metadata entry exists but `fetchSecret()` throws, verify skipped with warning, no crash
- [ ] T010 [P] [US2] Unit test: orphaned file (id not in manifest) — metadata has entry, manifest does not, verify skipped with warning
- [ ] T011 [P] [US2] Unit test: disabled store returns `{ rendered: [], failed: [] }` immediately
- [ ] T012 [P] [US1] Unit test: `atomicWriteFile()` refactor — verify `setFile()` still writes file correctly after extraction (no regression)

## Dependencies & Execution Order

- **T001, T002**: Independent of each other, but both must complete before T005 (which imports `isPathDenied`)
- **T003 → T004**: Extract helper first, then refactor caller
- **T005**: Depends on T001 (isPathDenied export) and T003 (atomicWriteFile helper)
- **T006**: Depends on T002 (readManifest export) and T005 (renderAll method exists)
- **T007-T012**: All parallelizable; depend on T005 being complete
- **Critical path**: T001 → T003 → T004 → T005 → T006

**Parallel opportunities**: T001 and T002 can run together; all Phase 4 tests (T007-T012) can run together.

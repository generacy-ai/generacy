# Tasks: Fix vscode-tunnel-manager CONNECTED_PATTERN

**Input**: Design documents from `/specs/606-symptoms-user-clicks-vs/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Fix

- [X] T001 [US1] Update `CONNECTED_PATTERN` regex at `packages/control-plane/src/services/vscode-tunnel-manager.ts:40` — change from `/is connected|tunnel is ready/i` to `/https:\/\/vscode\.dev\/tunnel\/[\w-]+|is connected|tunnel is ready/i`
- [X] T002 [US1] Add `TUNNEL_URL_PATTERN` constant (e.g., `/(https:\/\/vscode\.dev\/tunnel\/[\w-]+[\w\-/]*)/)` for full URL extraction (FR-003)
- [X] T003 [US1] Update `handleStdoutLine()` connected branch (line 219-225) to extract tunnel URL via `TUNNEL_URL_PATTERN` and include `tunnelUrl` in the `connected` event payload
- [X] T004 [US1] Add `tunnelUrl?: string` field to `VsCodeTunnelEvent` interface (line 11-18) — per data-model.md
- [X] T005 [US1] Update `start()` re-emit path (line 82) to include `tunnelUrl` if available when re-emitting `connected` event for already-running tunnel

## Phase 2: Exit Handler Fix

- [X] T006 [US2] Modify `child.on('exit')` handler (line 102-119) to accept `code` parameter and detect `authorization_pending`/`starting` states
- [X] T007 [US2] Emit `error` event with exit code and last 20 stdout lines (`this.stdoutBuffer.slice(-20).join('\n')`) when process exits during pending states
- [X] T008 [US2] Set `this.status = 'error'` (not `'stopped'`) for unexpected exit during pending states

## Phase 3: Verification

- [X] T009 [US1] Manual test: verify `CONNECTED_PATTERN` matches against real `code` CLI 1.95.3 transcript from research.md (`"Open this link in your browser https://vscode.dev/tunnel/my-cluster/workspaces"`)
- [ ] T010 [US2] [manual] Manual test: verify `error` event is emitted when process exits during `authorization_pending` state (kill process mid-auth)
- [X] T011 Code review: confirm zero code paths rely solely on old `is connected|tunnel is ready` pattern without the new URL alternative

## Dependencies & Execution Order

- **T001-T005** (Phase 1) can be done together in a single edit pass — they all modify the same file but different sections
- **T004** should be done before T003/T005 (interface must exist before being used)
- **T006-T008** (Phase 2) are a single logical change in the exit handler; no dependency on Phase 1
- **Phase 1 and Phase 2 are independent** — both modify `vscode-tunnel-manager.ts` but in different sections. Can be done in parallel `[P]` but in practice will be a single edit session
- **T009-T011** (Phase 3) depend on both Phase 1 and Phase 2 being complete

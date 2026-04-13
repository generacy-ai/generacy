# Tasks: End-to-End Spawn Path Integration Test

**Input**: Design documents from `/specs/438-goal-add-end-end/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Mock Binary & Test Infrastructure

- [X] T001 Create mock claude shell script at `packages/orchestrator/src/launcher/__tests__/fixtures/mock-claude.sh` — writes argv to `$MOCK_CLAUDE_CAPTURE_FILE` under `=== ARGV ===` section and selected env vars under `=== ENV ===` section; cats `$MOCK_CLAUDE_RESPONSE_FILE` to stdout if set, otherwise emits `{"type":"result","subtype":"success"}`; exits 0
- [X] T002 Create capture file parser utility in `packages/orchestrator/src/launcher/__tests__/spawn-e2e.test.ts` — `parseCaptureFile(path): { argv: string[], env: Record<string, string> }` that splits on `=== ARGV ===` / `=== ENV ===` section markers
- [X] T003 Create test scaffolding in `spawn-e2e.test.ts` — `beforeAll` (create tmpdir, copy mock-claude.sh as `claude`, chmod +x, build modified PATH), `beforeEach` (reset capture file), `afterAll` (rm -rf tmpdir)

## Phase 2: Core Test Cases

- [X] T010 [P] `phase` intent test — launch with `{ kind: 'phase', phase: 'plan', prompt: 'https://github.com/org/repo/issues/1', sessionId: 'sess-123' }`, assert argv contains `-p --output-format stream-json --dangerously-skip-permissions --verbose --resume sess-123`, assert `defaultProcessFactory` used
- [X] T011 [P] `pr-feedback` intent test — launch with `{ kind: 'pr-feedback', prNumber: 42, prompt: 'Fix the bug in auth.ts' }`, assert argv contains `-p --output-format stream-json --dangerously-skip-permissions --verbose` and prompt text
- [X] T012 [P] `invoke` intent test — launch with `{ kind: 'invoke', command: '/speckit:specify https://github.com/org/repo/issues/5' }`, assert argv contains `--print --dangerously-skip-permissions` and command string
- [X] T013 `conversation-turn` intent test — launch with `{ kind: 'conversation-turn', message: 'Hello', skipPermissions: true, model: 'claude-opus-4-6' }`, assert PTY wrapper invocation, assert argv contains `--output-format stream-json --verbose --dangerously-skip-permissions --model claude-opus-4-6`, guard with `python3` availability check
- [X] T014 [P] `generic-subprocess` intent test — launch with `{ kind: 'generic-subprocess', command: 'echo', args: ['hello', 'world'] }`, assert process exits cleanly and stdout contains `hello world`
- [X] T015 [P] `shell` intent test — launch with `{ kind: 'shell', command: 'echo integration-test-marker' }`, assert wrapped in `sh -c`, stdout contains `integration-test-marker`

## Phase 3: Advanced Assertions

- [X] T020 Env inheritance 3-layer merge test — pass `request.env` with a custom test key (e.g., `TEST_CUSTOM_KEY=test-value`), assert capture file shows merged env with request env winning over process.env for duplicate keys
- [X] T021 [P] Response file configurable stdout test — set `MOCK_CLAUDE_RESPONSE_FILE` pointing to a fixture with stream-json lines, assert process stdout emits the fixture content

## Phase 4: Polish & CI Validation

- [X] T030 Add `python3` availability guard — skip `conversation-turn` test with clear message if `python3` not on PATH
- [X] T031 Verify test runs under `pnpm --filter @generacy-ai/orchestrator test` — confirm vitest config glob picks up `spawn-e2e.test.ts`
- [X] T032 Verify full suite completes in <30 seconds

## Dependencies & Execution Order

**Phase boundaries** (sequential):
- Phase 1 → Phase 2 → Phase 3 → Phase 4 (must complete in order)

**Phase 1** (sequential):
- T001 → T002 → T003 (T002 depends on capture format from T001; T003 depends on both)

**Phase 2** (partially parallel):
- T010, T011, T012, T014, T015 can all run in parallel (marked `[P]`, independent test cases)
- T013 depends on T003 completing with python3 guard consideration, but is otherwise independent of other test cases

**Phase 3** (partially parallel):
- T020 and T021 can run in parallel (marked `[P]`, different assertion concerns)

**Phase 4** (sequential):
- T030 → T031 → T032 (validation must be ordered)

**Key dependency notes**:
- All Phase 2+ tasks depend on Phase 1 infrastructure (mock binary, parser, scaffolding)
- `conversation-turn` test (T013) requires `python3` — T030 adds the skip guard
- No new npm dependencies required
- No CI config changes needed — existing vitest glob covers the new test file

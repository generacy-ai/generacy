# Tasks: Fix smee.io provisioner to match live `/new` behavior (#965)

**Input**: Design documents from `/specs/965-summary-freshly-deployed/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md, contracts/provision-response.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Implementation

- [X] T001 [US1] Edit `packages/orchestrator/src/services/smee-channel-resolver.ts` inside `provision()`:
  - L137: change `method: 'POST'` → `method: 'GET'` (FR-001, D2).
  - L141: change `if (response.status !== 302) {` → `if (response.status < 300 || response.status >= 400) {` (FR-002, D1).
  - L142: change ``lastError = `unexpected status ${response.status}`;`` → ``lastError = `expected 3xx with Location, got ${response.status}`;`` (FR-007, D4).
  - Do NOT touch: retry loop (`MAX_ATTEMPTS`, `RETRY_DELAY_MS`, `HTTP_TIMEOUT_MS`), the `SMEE_URL_PATTERN` check on `Location`, the missing-`Location` branch, the catch block, `sleep` between attempts, `warn` log at L163-166, the 4-tier `resolve()` precedence (presetUrl, persisted, provision, persist), or the `redirect: 'manual'` setting.
  - Optional: update the file-header docstring at L6-7 that references `POST` to say `GET` (cosmetic, keep the file self-consistent).

## Phase 2: Test coverage
<!-- Depends on T001 -->

- [X] T002 [US1] Edit `packages/orchestrator/src/services/__tests__/smee-channel-resolver.test.ts`:
  - Generalize `make302(location)` at L10-15 → `makeRedirect(status, location)` (or add `makeRedirect` alongside and keep `make302` as a thin wrapper around `makeRedirect(302, location)` — whichever preserves existing call-sites with the smallest diff).
  - Add test: `307` with valid `Location` (e.g. `https://smee.io/3dCinhK6djyd2yK`) → `resolve()` returns that URL, no retries (FR-005 case 1, SC-002 case 1).
  - Add test: `200` with empty body / no `Location` → provisioning fails, retries exhausted (2 attempts), and the surfaced `lastError` equals `expected 3xx with Location, got 200` (FR-005 case 2, SC-002 case 2, SC-003).
  - Add test: 3xx (e.g. `307`) with a `Location` that does NOT match `SMEE_URL_PATTERN` (e.g. `https://evil.com/x`) → provisioning fails via the existing pattern check (FR-005 case 3, SC-002 case 3).
  - Verify existing tests still pass unchanged: `302` is inside the new `>= 300 && < 400` range, and no existing test asserts on the request method — so both the guard broadening and the `POST`→`GET` flip are transparent to the pre-existing suite.

## Phase 3: Changeset & non-regression checks
<!-- T003 is independent of T001/T002 file-wise — can run in parallel with T002. T004 depends on T001+T002. -->

- [X] T003 [P] [US1] Add `.changeset/965-smee-provisioner-fix.md`:
  - Bump `@generacy-ai/orchestrator` at `patch` level (defect fix per CLAUDE.md `workflow:speckit-bugfix` rule).
  - One-line summary: `Fix SmeeChannelResolver.provision() to match smee.io's current GET/307 behavior; provisioning previously failed on POST/302 assumptions and every fresh cluster fell back to polling.`
  - Verify the file is a **newly added** file (the CI gate greps `--diff-filter=A` against the base) — editing an existing changeset does not satisfy the gate.

- [X] T004 [US1] Run the orchestrator test suite and confirm no regressions in sibling smee tests:
  - `pnpm --filter @generacy-ai/orchestrator test smee-channel-resolver` — the three new tests pass; existing tests still pass (SC-002).
  - `pnpm --filter @generacy-ai/orchestrator test server-smee-provisioning server-smee-fallback-warning server-smee-opt-out-info` — server-level integration tests still pass (they are agnostic to the `POST`→`GET` and `302`→3xx flips per plan.md §"Files NOT changing").
  - Confirm the FR-007 rejection message wording (`expected 3xx with Location, got 200`) is asserted in T002's `200`-empty test (satisfies SC-003).
  - Confirm `resolve()` still folds every failure into `return null` — no new throw points introduced (design invariant D4 from plan.md).

## Dependencies & Execution Order

- **T001** → **T002**: the test-file edits assert behavior established by the implementation change; land T001 first so the new tests are being pinned to real code.
- **T003** can run in parallel with **T002** (`[P]` marker) — it touches only `.changeset/`, no file overlap with the src or test files.
- **T004** must run last — it is the verification gate for T001+T002+T003.
- No parallel opportunity within Phase 1 (single file, single edit cluster). No parallel opportunity across `smee-channel-resolver.ts` ↔ `smee-channel-resolver.test.ts` because T002 asserts against T001's behavior.

## Total: 4 tasks (1 impl, 1 test, 1 changeset, 1 verification). Single package (`@generacy-ai/orchestrator`), single PR (plan.md §Phasing).

## Next step

Run `/speckit:implement` to execute the task list.

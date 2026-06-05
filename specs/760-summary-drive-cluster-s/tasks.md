# Tasks: Drive cluster GitHub identity from acting account

**Input**: Design documents from `/specs/760-summary-drive-cluster-s/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md, contracts/github-app-credential.schema.json
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Tests (TDD — extend before changing source)

- [ ] T001 [US1] Extend `packages/control-plane/__tests__/services/wizard-env-writer.test.ts` with a `gitIdentityLogin` happy-path case (credential JSON `{"token":"...","accountLogin":"Painworth","gitIdentityLogin":"pw-dev-bot"}`) asserting `GH_USERNAME=pw-dev-bot` and `GH_EMAIL=pw-dev-bot@users.noreply.github.com`. Covers FR-001, FR-002, SC-001.
- [ ] T002 [P] [US2] Extend `packages/control-plane/__tests__/services/wizard-env-writer.test.ts` with fallback cases: `gitIdentityLogin` empty string, whitespace-only (`"   "`), `null` (non-string), and absent (legacy credential). All four MUST fall back to `accountLogin`. Covers FR-003, SC-002.
- [ ] T003 [P] [US1] Extend `packages/control-plane/__tests__/services/wizard-env-writer.test.ts` with a leading/trailing whitespace case (`gitIdentityLogin: "  pw-dev-bot  "`) asserting the trimmed value `pw-dev-bot` is used for both `GH_USERNAME` and the `GH_EMAIL` local-part. Covers the trim-before-length-check invariant from research.md D3.

## Phase 2: Core Implementation

- [ ] T010 [US1] [US2] Modify `mapCredentialToEnvEntries` in `packages/control-plane/src/services/wizard-env-writer.ts` (`github-app` branch, ~lines 39-67): extract `parsed.gitIdentityLogin`, apply `typeof === 'string'` guard, `.trim()`, and `length > 0` check; prefer it over `accountLogin` when resolvable; otherwise fall through to the existing `accountLogin` branch unchanged. The `GH_TOKEN`-only path (missing/empty identity fields) and unparseable-JSON path (`return []`) must remain unchanged. Tests from T001-T003 should pass after this change. Covers FR-001, FR-002, FR-003.

## Phase 3: Documentation & Comment Fix

- [ ] T020 [P] [US1] Update the `GH_USERNAME` doc-comment in `packages/orchestrator/src/services/identity.ts` (~lines 48-55): replace the misleading "the human account the installation belongs to" wording with language describing `GH_USERNAME` as the operator-selected acting account threaded through the github-app credential's `gitIdentityLogin` field (with `accountLogin` fallback for pre-#812 credentials). Logic, signatures, and resolution order MUST NOT change. Covers FR-004.

## Phase 4: Regression Spot-Check & Manual Verification

- [ ] T030 [P] [US2] Run `pnpm --filter @generacy-ai/orchestrator test identity` and confirm the existing precedence test (`configUsername` wins over `GH_USERNAME`) still passes. No new assertions required — this verifies SC-003 and FR-005 are not regressed by the comment-only change in T020.
- [ ] T031 [US1] Manual end-to-end verification per `quickstart.md` "End-to-end verification (org cluster)" section: on a freshly-activated org cluster (after this PR and generacy-cloud#812 ship), confirm `wizard-credentials.env` contains `GH_USERNAME=<picked acting account>` (not the org name), orchestrator logs show `Cluster identity resolved: <acting account> (from GH_USERNAME)`, an issue assigned to that acting account is picked up by the label monitor, and a resulting commit attributes to the acting account on GitHub. Confirms SC-001 in production.
- [ ] T032 [P] [US2] Manual legacy-cluster verification per `quickstart.md` "Legacy-cluster verification" section: on a cluster activated before #812 (credential lacks `gitIdentityLogin`), trigger a credential refresh and confirm `wizard-credentials.env` still emits `GH_USERNAME=<accountLogin>` / `GH_EMAIL=<accountLogin>@users.noreply.github.com` with no startup warnings. Confirms SC-002 (no regression for pre-#812 credentials).

## Dependencies & Execution Order

**Strict ordering**:
- T001, T002, T003 (test extensions) → T010 (source change). Tests must be written first to make the TDD red→green visible.
- T010 (source change) → T031, T032 (manual verification — depend on the merged source change being deployable).
- T020 (comment fix) is independent of T010 and can land in parallel; T030 verifies T020 didn't break the existing identity suite.

**Parallel opportunities**:
- T002, T003 are `[P]` with T001 — same file, but the cases are independent and can be written concurrently. (If a single author writes them sequentially, that's fine.)
- T020 is `[P]` — different package, different file, no shared state with the test extensions or T010.
- T030, T032 are `[P]` — independent verification commands against independent surfaces (orchestrator suite vs. cluster runtime).

**Files touched** (3 total):
- `packages/control-plane/src/services/wizard-env-writer.ts` — T010
- `packages/control-plane/__tests__/services/wizard-env-writer.test.ts` — T001, T002, T003
- `packages/orchestrator/src/services/identity.ts` — T020 (comment only)

**Out of scope reminders** (per spec.md "Out of Scope"):
- Do NOT add an org-pattern warning in `identity.ts` (FR-006 deferred to #762).
- Do NOT touch the producer side — `gitIdentityLogin` sealing lives in generacy-cloud#812.
- Do NOT change `CLUSTER_GITHUB_USERNAME` precedence or add a deprecation warning.
- Do NOT modify the credential-refresh cache invalidation path (#614 handles it).

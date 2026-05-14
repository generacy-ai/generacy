# Tasks: Fix Stale Credential Surface After Cluster Re-Add

**Input**: Design documents from `/specs/614-symptom-user-flow-cloud/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to
- **[Fix]**: Which fix (A or B) this task belongs to

## Phase 1: Fix A — Credential Live-Refresh (control-plane)

- [X] T001 [Fix-A] Create `refreshGhAuth` helper at `packages/control-plane/src/services/gh-auth-refresh.ts` — uses `child_process.execFile('gh', ['auth', 'login', '--with-token', '--hostname', 'github.com'])` with token piped via stdin. Returns `{ ok: boolean; error?: string }`. Non-fatal: caller logs warning on failure.
- [X] T002 [Fix-A] Create `extractGhToken` helper in `packages/control-plane/src/services/gh-auth-refresh.ts` (or co-located) — extracts token from `github-app` (JSON parse → `.token`) or `github-pat` (raw string). Returns `string | null`.
- [X] T003 [Fix-A] Modify `handlePutCredential` in `packages/control-plane/src/routes/credentials.ts` — after `writeCredential()` succeeds, if type is `github-app` or `github-pat`: (1) call `writeWizardEnvFile({ agencyDir })` to regenerate env file, (2) call `refreshGhAuth(extractGhToken(type, value))` for live `gh` auth refresh. Both are best-effort (catch + log, don't fail the PUT).

## Phase 2: Fix A — Unit Tests

- [X] T004 [P] [Fix-A] Add unit tests for `refreshGhAuth` in `packages/control-plane/__tests__/services/gh-auth-refresh.test.ts` — mock `execFile`, verify token passed via stdin (not argv), verify returns `{ ok: true }` on success and `{ ok: false, error }` on failure.
- [X] T005 [P] [Fix-A] Add unit tests for `extractGhToken` — verify github-app JSON extraction, github-pat passthrough, non-github types return null, malformed JSON returns null.
- [X] T006 [P] [Fix-A] Add unit tests for the post-write hook in `handlePutCredential` — mock `writeCredential`, `writeWizardEnvFile`, `refreshGhAuth`. Test three scenarios: (1) `type: 'github-app'` → both refresh calls made, (2) `type: 'github-pat'` → both refresh calls made with raw token, (3) `type: 'api-key'` → neither refresh call made.

## Phase 3: Fix B — CLI Force-Reactivation

- [X] T007 [Fix-B] Create `clearStaleActivation` helper at `packages/generacy/src/cli/commands/launch/volume-cleanup.ts` — runs `docker run --rm -v <composeName>_generacy-data:/v alpine rm -f /v/cluster-api-key /v/cluster.json /v/wizard-credentials.env`. Takes `composeName: string` parameter. Uses `execSync` with a reasonable timeout.
- [X] T008 [Fix-B] Modify `launchAction` in `packages/generacy/src/cli/commands/launch/index.ts` — import `sanitizeComposeProjectName` from `../cluster/scaffolder.js` and `clearStaleActivation` from `./volume-cleanup.js`. After `scaffoldProject()` (step 6) and before `pullImage()` (step 7), when `--claim` is present, compute compose project name and call `clearStaleActivation(composeName)`. Non-fatal: log warning if docker run fails (compose up will also fail).

## Phase 4: Fix B — Unit Tests

- [X] T009 [Fix-B] Add unit tests for `clearStaleActivation` in `packages/generacy/src/cli/commands/launch/__tests__/volume-cleanup.test.ts` — mock `execSync`, verify correct docker command with volume name, verify files targeted (`cluster-api-key`, `cluster.json`, `wizard-credentials.env`).
- [X] T010 [P] [Fix-B] Add unit test for `launchAction` integration — verify `clearStaleActivation` is called when `--claim` is provided, and NOT called when claim is absent.

## Dependencies & Execution Order

**Phase 1** (T001–T003): Sequential — T001 and T002 can be done in parallel, but T003 depends on both.
- T001 and T002 create the helpers; T003 wires them into the credential handler.

**Phase 2** (T004–T006): All parallel — test files are independent.
- Depends on Phase 1 completion (tests import the implementation).

**Phase 3** (T007–T008): Sequential — T007 creates the helper, T008 wires it.
- Independent of Phases 1–2 (different packages).

**Phase 4** (T009–T010): Parallel tests.
- Depends on Phase 3 completion.

**Cross-phase parallelism**: Phase 1 and Phase 3 can run in parallel (Fix A touches `packages/control-plane`, Fix B touches `packages/generacy` — no shared files).

# Tasks: Adopt existing smee channel on cluster delete→relaunch

**Input**: Design documents from `/specs/1005-summary-when-cluster-deleted/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Type Surface

- [X] T001 [US1] Extend `ChannelSource` in `packages/orchestrator/src/services/smee-channel-resolver.ts`
  to include `'adopted'` between `'persisted'` and `'provisioned'`
  (order: `'env-or-yaml' | 'persisted' | 'adopted' | 'provisioned'`).
  Also extend `SmeeChannelResolverOptions` with two new optional fields per
  `data-model.md` §`SmeeChannelResolverOptions`:
    - `repos?: RepositoryConfig[]` (reuse the existing `RepositoryConfig` type
      exported from `webhook-setup-service.ts`; import via named import).
    - `discoverExistingChannel?: (repos: RepositoryConfig[]) => Promise<string | null>`.
  No runtime behavior change in this task — pure type surface. Required by FR-002, FR-008.

## Phase 2: Discovery Callback (WebhookSetupService)
<!-- Depends on Phase 1: SmeeChannelResolverOptions.discoverExistingChannel signature must exist -->

- [X] T002 [US1] Implement `findExistingSmeeChannel(repos)` as a public async method on
  `WebhookSetupService` in `packages/orchestrator/src/services/webhook-setup-service.ts`.
  Signature: `public async findExistingSmeeChannel(repos: RepositoryConfig[]): Promise<string | null>`.
  Algorithm per `contracts/find-existing-smee-channel.md` §Discovery algorithm:
    - Iterate `repos` in the passed order.
    - For each `{ owner, repo }`, call `this._listRepoWebhooks(owner, repo)` inside
      try/catch. On throw: log `warn`
      `'Failed to list webhooks during smee channel discovery — skipping repo'`
      with `{ owner, repo, error: String(err) }`, `continue`.
    - Find first hook where `(h.config?.url ?? '').toLowerCase().startsWith('https://smee.io/')`.
    - Validate the raw URL against `SMEE_URL_PATTERN`; on fail, log `warn`
      `'Repo webhook has smee-prefixed URL that does not match SMEE_URL_PATTERN — skipping'`
      with `{ owner, repo, url }`, `continue`.
    - Track `(chosenUrl, chosenRepo)` — first hit wins.
    - On subsequent repos whose URL differs from `chosenUrl`, log ONE `warn` per
      divergent repo: `'Repo Generacy smee channel disagrees with first-repo winner — deferring to take-over on next self-heal'`
      with `{ chosenRepo, chosenUrl, divergentRepo, divergentUrl }` (repo strings are `${owner}/${repo}`).
    - Return `chosenUrl` or `null`.
  MUST NEVER THROW. Reuse `_listRepoWebhooks` verbatim; do not add a parallel discovery client.
  Required by FR-003, FR-004.

## Phase 3: Resolver Adopt Tier
<!-- Depends on Phase 1 (types) and Phase 2 (callback exists on WebhookSetupService) -->

- [X] T003 [US1] Add `runAdoptTier()` private async method to `SmeeChannelResolver` in
  `packages/orchestrator/src/services/smee-channel-resolver.ts`.
  Behavior per `contracts/smee-channel-resolver-adopt-tier.md` §`runAdoptTier()`:
    - Guard: if `!this.options.discoverExistingChannel || !this.options.repos || this.options.repos.length === 0`
      return `null` immediately (no log — activation-predicate miss, not a failure).
    - Bounded retry using existing `MAX_ATTEMPTS = 2` and `RETRY_DELAY_MS = 1000` constants at `:32`.
    - Reuse `this.sleepImpl` for inter-attempt delay (test-injectable).
    - On throw: capture `lastError`, sleep between attempts, retry once.
    - On `null` return: no retry — return `null` (legitimate miss).
    - On non-null result: validate against `SMEE_URL_PATTERN`. On fail, log
      `warn` `'Adopt callback returned URL not matching SMEE_URL_PATTERN — falling through'`
      with `{ result, source: 'adopted' }`; return `null` (no retry — treated as legit miss).
    - On validated URL: return the string.
    - After MAX_ATTEMPTS exhausted with `lastError` set: log `warn`
      `'Adopt callback failed after N attempts — falling through to provision'`
      with `{ attempts: MAX_ATTEMPTS, lastError, source: 'adopted' }`, return `null`.
  MUST NEVER THROW. Required by FR-007.

- [X] T004 [US1] Insert tier-3 (adopt-existing) invocation into `SmeeChannelResolver.resolve()`
  in `packages/orchestrator/src/services/smee-channel-resolver.ts`. Placement per
  `contracts/smee-channel-resolver-adopt-tier.md` §Tier ordering: AFTER the persisted-file
  return short-circuit (`:85-93`) and BEFORE the `provision()` call. Logic:
    - Call `const adoptedUrl = await this.runAdoptTier();`.
    - If `adoptedUrl === null`: fall through to `provision()` unchanged.
    - If truthy:
        - `const persisted = await this.writePersistedFile(adoptedUrl);` (best-effort).
        - If `!persisted`: log `warn` `'Adopted smee channel URL but failed to persist — next boot will re-run adopt tier'`
          with `{ path: this.options.channelFilePath, url: adoptedUrl }` — **do NOT return null**,
          continue to log+return the adopted result (divergence from `provisioned` behavior per
          contract §Persist-on-adopt).
        - `await this.mirrorToWorkspace(adoptedUrl);` (unguarded, matching tier-4).
        - `this.logger.info({ channelUrl: adoptedUrl, source: 'adopted' }, 'Adopted existing smee channel URL from repo webhook');`
        - Return `{ channelUrl: adoptedUrl, source: 'adopted' }`.
  Required by FR-001, FR-002, FR-008. Do NOT change the persisted-tier short-circuit —
  the FR-010/SC-003 zero-list-hooks-on-healthy-restart invariant depends on it.

## Phase 4: Take-Over Branch (WebhookSetupService)
<!-- Independent of Phases 2-3; can run in parallel with Phase 2 (T002) but touches same file -->

- [X] T005 [US1] Refactor `_selectExistingHookForUpdate` in
  `packages/orchestrator/src/services/webhook-setup-service.ts` to insert the take-over
  branch per `contracts/webhook-setup-takeover.md` §Ordering. Insert the new branch
  BETWEEN the existing `persisted-match update-url` branch and the existing `foreign` branch:
    - Compute `staleGeneracySmee` as
      `hooks.filter(h => { const url = (h.config?.url ?? '').toLowerCase();
      return url.startsWith('https://smee.io/') && url !== currentNormalized &&
      (persistedNormalized === null || url !== persistedNormalized); })`.
    - **NEW branch (Q5-C)**: if `staleGeneracySmee.length === 1` return
      `{ kind: 'update-url', hook: staleGeneracySmee[0] }`.
    - **Preserve existing behavior for ≥2 case**: if `staleGeneracySmee.length >= 2`,
      fall through to the existing `foreign` branch (which returns `{ kind: 'foreign', hook: <first> }`).
    - `staleGeneracySmee.length === 0` → fall through to the existing `create` path.
  Do NOT introduce a new `WebhookSetupResult.action` value — reuse `'reactivated'` for
  the resulting `update-url` handler outcome (see contract §Post-`update-url` result).
  Required by FR-005, FR-006, FR-009. Ordering rationale: branches 1 (current-match) and 2
  (persisted-match) still short-circuit first; the new branch (3) only sees hooks stale relative
  to both.

## Phase 5: Wiring (server.ts)
<!-- Phase boundary: Phases 1-4 must be complete before wiring can compile -->

- [X] T006 [US1] Hoist `WebhookSetupService` construction ABOVE `SmeeChannelResolver` construction
  in `packages/orchestrator/src/server.ts` (`onReady` closure at `:641-679`, and
  `startSmeePipeline` at `:597-617`). Per plan.md §Line-of-effect Wiring row:
    - Construct one `WebhookSetupService` instance inside the `onReady` closure using the same
      DI shape currently in `startSmeePipeline` (repo access, JIT token resolver, `sendRelayEvent`,
      `statusReporter`, logger — all still fine to pass; only `findExistingSmeeChannel` runs before
      a channel URL is known, and that method does not touch `sendRelayEvent`/`statusReporter`).
    - Pass `webhookSetupService.findExistingSmeeChannel.bind(webhookSetupService)` as
      `discoverExistingChannel` and `config.repositories` as `repos` into `new SmeeChannelResolver(..., { …, discoverExistingChannel, repos })`.
    - **Reuse the same instance downstream** — pass the hoisted `webhookSetupService` into
      `startSmeePipeline` (either as a parameter or by closing over the outer scope) so
      `ensureWebhooks()` runs on the same instance, not a fresh one.
    - Update `startSmeePipeline` signature to accept the pre-constructed `WebhookSetupService`
      and stop instantiating one internally.
  Preserve all existing behavior on the healthy-restart path (persisted tier hits → adopt tier
  short-circuits → zero extra GitHub calls, FR-010/SC-003). Required by plan.md §Wiring.

## Phase 6: Tests
<!-- Phase boundary: Phases 1-5 must be implemented so tests reflect real signatures -->

- [X] T007 [P] [US1, US2] Add resolver tests to
  `packages/orchestrator/src/services/__tests__/smee-channel-resolver.test.ts`
  per plan.md §Line-of-effect (`smee-channel-resolver.test.ts` row):
    - **T-adopt-1**: callback returns a valid smee URL → result is `{ source: 'adopted', channelUrl }`;
      `writePersistedFile` was called with the URL; `mirrorToWorkspace` was called; NO `fetch`
      / `provision()` invocation.
    - **T-adopt-2**: callback returns `null` → resolver falls through to `provision()` (mock
      provision call happens exactly once); no persist-adopt write.
    - **T-adopt-3**: callback throws on first call, returns valid URL on second → resolver
      calls `sleepImpl(RETRY_DELAY_MS)` exactly once, callback invoked twice, result is
      `{ source: 'adopted' }`.
    - **T-adopt-4**: callback throws twice → resolver falls through to `provision()`;
      `sleepImpl` called once (between attempts), callback invoked twice, no persist-adopt write.
    - **T-adopt-5**: callback returns valid URL, `writePersistedFile` returns false → result is
      still `{ source: 'adopted' }` (assert on the `warn` log with `path`/`url` fields).
    - **T-adopt-6**: callback returns `"not-a-smee-url"` → treated as `null` (assert warn log
      `'Adopt callback returned URL not matching SMEE_URL_PATTERN — falling through'`), falls
      through to `provision()`, no retry.
    - **T-adopt-7 (SC-003)**: persisted file present and valid → resolver returns `{ source: 'persisted' }`
      and the injected `discoverExistingChannel` mock was NEVER called
      (`expect(discoverExistingChannel).not.toHaveBeenCalled()`).
  Required by FR-002, FR-007, FR-008, FR-010, SC-003.

- [X] T008 [P] [US1, US3] Add webhook-setup tests to
  `packages/orchestrator/src/services/__tests__/webhook-setup-service.test.ts`
  per plan.md §Line-of-effect (`webhook-setup-service.test.ts` row):
    - **T-find-1**: single repo, `_listRepoWebhooks` returns one smee.io hook → returns that URL.
    - **T-find-2**: single repo, `_listRepoWebhooks` returns no smee.io hooks → returns `null`.
    - **T-find-3**: two repos, both return the same smee URL → returns that URL, ZERO
      divergence-warn logs.
    - **T-find-4 (FR-004)**: two repos with different smee URLs → returns the first repo's URL;
      exactly ONE warn log `'Repo Generacy smee channel disagrees with first-repo winner — deferring to take-over on next self-heal'`
      with structured fields including `chosenRepo`, `divergentRepo`, `chosenUrl`,
      `divergentUrl`.
    - **T-find-5**: two repos, first repo's `_listRepoWebhooks` throws, second returns a smee
      hook → returns second repo's URL; ONE warn log for the failing repo
      `'Failed to list webhooks during smee channel discovery — skipping repo'`.
    - **T-takeover-1 (FR-005)**: hook list contains exactly one Generacy smee hook whose URL
      is neither current nor persisted → `_selectExistingHookForUpdate` returns
      `{ kind: 'update-url', hook: <the stale hook> }`; downstream `_ensureWebhookForRepo` fires
      the existing `update-url` handler and returns `action: 'reactivated'`.
    - **T-takeover-2 (SC-004, FR-006)**: hook list contains TWO stale Generacy smee hooks →
      `_selectExistingHookForUpdate` does NOT return `'update-url'`; existing `foreign` branch
      fires with `{ kind: 'foreign', hook: <first stale> }` (no `_updateRepoWebhookConfig`
      invocation).
    - **T-takeover-3**: hook list contains zero Generacy smee hooks → `_selectExistingHookForUpdate`
      returns `{ kind: 'create' }`, existing behavior preserved.
    - **T-takeover-4 (regression guard)**: after adopt fires and the surviving hook's URL now
      equals `current`, `_selectExistingHookForUpdate` returns `{ kind: 'skip-active', hook: <it> }`
      via the existing branch-1 short-circuit; take-over branch does NOT re-fire; no
      `_updateRepoWebhookConfig` invocation.
    - **T-us3-guard (FR-009)**: hook list contains a non-`smee.io` foreign hook → classified as
      `foreign` and untouched (no `_updateRepoWebhookConfig`, no `_deleteRepoWebhook`).
  Required by FR-003, FR-004, FR-005, FR-006, FR-009.

## Phase 7: Changeset
<!-- Independent of implementation phases; can run in parallel once file paths are known -->

- [X] T009 [P] [US1] Create `.changeset/1005-adopt-existing-smee-channel.md` with:
    - Frontmatter: `'@generacy-ai/orchestrator': patch`.
    - Body: one-line summary of the adopt tier + single-hook take-over branch, referencing
      issue #1005. Internal observability + wiring behavior; no public API surface change.
  Required by CLAUDE.md §Changesets (CI gate).

## Phase 8: Verification
<!-- Phase boundary: Phases 1-7 complete before verification -->

- [X] T010 [US1, US2, US3] Manual verification per `quickstart.md`:
    - Follow §Repro / validation steps 1-4 on a real relaunched cluster (or a
      staging equivalent), verifying `source=adopted` in the orchestrator log
      and near-instant webhook-mode label delivery (SC-001: < 30 s).
    - Follow §Regression: healthy `docker restart` (US2) — verify `source=persisted`
      and confirm NO `_listRepoWebhooks` invocation in the log (SC-003).
    - Follow §Regression: operator smee.io hook untouched (US3) using a non-`smee.io`
      foreign webhook as the guard case.
  If manual verification against a real cluster is not possible in the implementation
  session, mark this task complete with an explicit "verify manually before shipping"
  note in the PR description and rely on the T007/T008 test coverage as the shipped guard.

## Dependencies & Execution Order

**Sequential dependencies**:
- T001 (types) → T002 + T003 (both need `discoverExistingChannel` / `RepositoryConfig` in scope).
- T003 (`runAdoptTier`) → T004 (`resolve()` calls `runAdoptTier`).
- T002 + T005 both touch `webhook-setup-service.ts` — sequential to avoid conflicting edits
  in a single-file merge (T002 adds a new method, T005 refactors `_selectExistingHookForUpdate`;
  no logical overlap, but keep serial to reduce diff churn).
- T004 (adopt tier live in `resolve()`) + T005 (take-over branch live in
  `_selectExistingHookForUpdate`) → T006 (wiring can now pass the callback and take-over is
  active on `ensureWebhooks`).
- T006 (wiring) → T007 + T008 (tests need real signatures + real wiring shape for T007's
  adopt-tier hit path).
- T007 + T008 + T009 → T010 (verification runs last).

**Parallel opportunities**:
- T007 (resolver tests) and T008 (webhook-setup tests) can run in parallel (`[P]`) —
  distinct files.
- T009 (changeset) can be written any time once the package name is known — `[P]` with
  any other task.
- T002 (find method) and T005 (take-over refactor) could run in parallel if the implementer
  coordinates diffs, but recommended sequential per above.

**Phase-boundary summary**:
- Phase 1 (types) → Phase 2/3/4 (implementation, some parallelism inside) → Phase 5 (wiring)
  → Phase 6 (tests) + Phase 7 (changeset, parallel) → Phase 8 (verification).

## Notes

- No `packages/claude-plugin-cockpit/commands/*.md` edits — no `playbook-verification.test.ts`
  re-pin task required.
- All changes stay inside `packages/orchestrator/`; single changeset covers the package
  (CLAUDE.md §Changesets: patch bump, non-test `src/` change, single package listed).
- Fail-open discipline preserved throughout: every new failure mode folds into `null` and
  falls through to the next tier.

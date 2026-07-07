# Tasks: Cockpit CLI identity resolution for App-credentialed clusters

**Input**: Design documents from `/specs/830-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1/US2/US3)

## Phase 1: Schema Foundation

- [X] T001 [US1] Add `assignee: z.string().min(1).optional()` field to `CockpitConfigSchema` in `packages/cockpit/src/config/schema.ts`. Position after existing `owner` field to keep the config surface alphabetized-by-add-order matches. Verify `z.infer<>` picks it up (no manual re-export edits needed).
- [X] T002 [US1] Extend loader round-trip test in `packages/cockpit/src/__tests__/config/loader.test.ts` — add a case with `.generacy/config.yaml` containing `cockpit.assignee: someone` and assert `loadCockpitConfig().config.assignee === 'someone'`. Add a negative case: empty-string `assignee` fails Zod parse.

## Phase 2: Helper (isolation)

- [X] T003 [US3] Create new file `packages/generacy/src/cli/commands/cockpit/shared/identity.ts` containing: `LoudIdentityError` class (code `'IDENTITY_UNRESOLVED'`, `verb` field), `ResolveCockpitIdentityInput` interface, `ResolveCockpitIdentityResult` type, `IdentitySource` type, and `resolveCockpitIdentity()` async function. Implement precedence: flag → configAssignee → env.CLUSTER_GITHUB_USERNAME → env.GH_USERNAME → gh.getCurrentUser(). Default `env` param to `process.env`. On all-miss: `mode: 'required'` throws `LoudIdentityError` with the 4-knob message from `contracts/resolve-cockpit-identity.md`; `mode: 'optional'` calls `logger.warn(...)` with `warning: ` prefix and returns `{ login: undefined, source: 'none' }`. Tier 3 catches `gh` errors and falls through (never surfaces the underlying error string in the loud message).
- [X] T004 [US3] Create new file `packages/generacy/src/cli/commands/cockpit/__tests__/shared/identity.test.ts` with table-driven tests covering all 7 precedence rows from `contracts/resolve-cockpit-identity.md` (flag beats all, config beats env, CLUSTER_GITHUB_USERNAME beats GH_USERNAME, GH_USERNAME beats gh-api, gh-api resolves, all-miss required throws, all-miss optional returns `source: 'none'`). Inject a fake `gh` (`{ getCurrentUser: vi.fn() }`), fake `logger` (`{ warn: vi.fn(), info: vi.fn() }`), and explicit `env` object per case — no `process.env` mutation. Assert the required-mode error message contains all four substrings: `--assignee`, `cockpit.assignee`, `CLUSTER_GITHUB_USERNAME`, `GH_USERNAME`. Assert optional-mode `logger.warn` receives a message containing the same four substrings. Assert returned `source` matches the resolving tier (SC-006).

## Phase 3: Wire `queue.ts` (US1)

- [X] T005 [US1] Modify `packages/generacy/src/cli/commands/cockpit/queue.ts`: import `loadCockpitConfig` from `@generacy-ai/cockpit` and `resolveCockpitIdentity` from `./shared/identity.js`. Add a `loadCockpitConfig(...)` call near the existing `resolveIssueContext` call at the command entry (queue does not currently load config). Delete the direct `cockpitGh.getCurrentUser()` block at lines ~297–309. Replace with `const { login } = await resolveCockpitIdentity({ flag: opts.assignee, configAssignee: config.assignee, gh: cockpitGh, logger: getLogger(), verb: 'cockpit queue', mode: 'required' })` and use `login` where the previous block set the assignee. Wrap the `LoudIdentityError` at the top-level catch (or let it propagate to the existing `CockpitExit(1, err.message)` wrapper — verify current error boundary).
- [X] T006 [US1] Extend `packages/generacy/src/cli/commands/cockpit/__tests__/queue.test.ts` with two new scenarios: (a) App-credentialed happy path — set `env.CLUSTER_GITHUB_USERNAME` (with `gh.getCurrentUser` stubbed to throw), assert queue exits 0 and the assignee resolves from the env var, assert `gh.getCurrentUser` was NOT called; (b) all-miss failure — no flag, no config, empty env, `gh.getCurrentUser` throws, assert `CockpitExit(1, ...)` with the 4-knob message (SC-004).

## Phase 4: Wire `advance.ts` + marker (US2)

- [X] T007 [P] [US2] Modify `packages/generacy/src/cli/commands/cockpit/manual-advance-marker.ts`: change `ManualAdvanceMarker.actor: string` to `actor?: string`. Update `formatManualAdvanceComment()` so when `actor` is `undefined` or empty: omit the `actor=<...>` attribute from the HTML comment prelude entirely, and drop the ` by **@<actor>**` clause from the sentence (preserve the trailing period). Update `validate()` (or equivalent) to skip `ACTOR_REGEX` when `actor` is `undefined`/`''`, but still enforce the regex when `actor` is a non-empty string. Keep `gate` and `ts` validation unchanged.
- [X] T008 [P] [US2] Create (or extend if it exists) `packages/generacy/src/cli/commands/cockpit/__tests__/manual-advance-marker.test.ts` with the 5 test cases from `contracts/manual-advance-marker.md`: `actor: 'alice'` → identical to today's output; `actor: undefined` → HTML comment has no `actor=`, sentence has no `by …`; `actor: ''` → same as `undefined`; `actor: 'invalid space'` → throws; `gate` and `ts` violations still throw as before.
- [X] T009 [US2] Modify `packages/generacy/src/cli/commands/cockpit/advance.ts`: import `resolveCockpitIdentity` from `./shared/identity.js`. Delete the direct `gh.getCurrentUser()` block at lines ~135–141. Replace with `const { login } = await resolveCockpitIdentity({ flag: undefined, configAssignee: config.assignee, gh, logger: getLogger(), verb: 'cockpit advance', mode: 'optional' })`. Pass `actor: login` (may be `undefined`) into `formatManualAdvanceComment({ gate, actor: login, ts })`. Confirm the label add/remove (`gh.addLabel`, `gh.removeLabel`) and the `gh.postIssueComment` call run unconditionally — no code path is gated on `login` being defined (FR-003).
- [X] T010 [US2] Extend `packages/generacy/src/cli/commands/cockpit/__tests__/advance.test.ts` with two scenarios: (a) App-credentialed happy path — set `env.CLUSTER_GITHUB_USERNAME`, assert `advance` exits 0, the marked comment includes the env-provided actor, `gh.addLabel('advanced:<gate>')` was called, `gh.getCurrentUser` was NOT called; (b) missing-all degrade — no flag/config/env and `gh.getCurrentUser` throws, assert `advance` exits 0, `logger.warn` was called with a message containing all four knobs, the posted comment omits the `actor=` HTML attribute AND the `by @<...>` sentence fragment, the `advanced:<gate>` label was still applied (FR-003 / SC-002).

## Phase 5: Guard + investigation

- [X] T011 [US3] Verify SC-003 by running `rg 'getCurrentUser|gh api user' packages/generacy/src/cli/commands/cockpit/` — the count must be exactly 1 (the tier-3 call inside `shared/identity.ts`). If any other match remains (e.g., stale import, leftover comment), remove it before opening the PR.
- [X] T012 [US1] Runtime deliverable for FR-006: grep `packages/orchestrator/src/services/webhooks.ts` for its no-assignee guard (the `CLUSTER_GITHUB_USERNAME`-unset branch that disables assignee filtering) and compare against the `smee-receiver`'s skip path (in `packages/smee-receiver/` or the tetrad-development repo). Post a comment on issue #830 tagged `"FR-006 investigation"` recording the finding — both the "no divergence" and "divergence found" branches result in a comment. If divergence is found, file a follow-up issue and link it from the comment.

## Dependencies & Execution Order

**Sequential dependencies**:
- T001 → T002 (schema field must exist before loader test can assert on it)
- T001 → T003 (helper reads `configAssignee` which is populated from the schema field)
- T003 → T004 (test imports the helper)
- T003 → T005 → T006 (queue wiring depends on helper existence; queue tests depend on wiring)
- T003, T007 → T009 → T010 (advance wiring depends on both the helper and the optional-actor marker; advance tests depend on wiring)
- T005 + T009 → T011 (grep guard runs after both wirings)
- All code + tests → T012 (investigation is post-implementation; may be done in parallel with test authoring but is reported after code lands)

**Parallel opportunities**:
- T001 and T003 can start simultaneously (different packages, `configAssignee` is a plain string param — helper doesn't import from `@generacy-ai/cockpit`)
- T007 and T004 can run in parallel with T005 (marker change is self-contained; helper test is self-contained)
- T007 and T009 depend on each other's shape but the marker change (T007) has no runtime dep on advance — mark T007 `[P]` to run alongside the queue wiring (T005/T006)
- T008 (marker test) can run in parallel with T007 authoring since they touch different files
- T006 and T010 are independent test files — parallelize once their respective wirings land

**Critical path**: T001 → T003 → T005 → T009 → T011 → T012

## Suggested Next Step

Run `/speckit:implement` to begin execution against this task list.

---

*Generated by speckit*

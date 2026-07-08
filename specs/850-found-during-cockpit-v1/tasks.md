# Tasks: `cockpit advance` accepts bare issue numbers and no longer references removed `cockpit.repos` config

**Input**: Design documents from `/workspaces/generacy/specs/850-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md, clarifications.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)

## Phase 1: Setup / Baseline

- [ ] T001 Confirm baseline greps before edits: `grep -rn "repos are not configured" packages/generacy/src/` returns two hits (`resolver.ts` + `resolver.test.ts`), and `grep -rn "cockpit.repos" packages/generacy/src/` returns zero. Record for the PR body; if a fresh occurrence appears outside the two expected sites, expand scope before editing.
- [ ] T002 [P] Reproduce the bug on `develop` per quickstart §1: run `node packages/generacy/bin/generacy.js cockpit advance 2 --gate implementation-review` from inside this repo and capture the `Error: cockpit advance: parse issue: bare issue number "2" is not accepted — repos are not configured…` output. Attach to the PR as the "before" evidence for SC-001.

## Phase 2: Core Refactor — `resolver.ts`

- [ ] T010 [US1][US2] In `packages/generacy/src/cli/commands/cockpit/resolver.ts`, narrow `parseIssueRef` to a strict qualified-forms-only parser: delete the `BARE_NUMBER.test(trimmed)` branch and its "repos are not configured" throw (~lines 99-104). Trailing throw becomes the sole failure exit: `` `unrecognized issue ref "${input}". Use <n>, <owner>/<repo>#<n>, or https://github.com/<owner>/<repo>/issues/<n>.` ``. Keep `owner/repo#N` and URL branches byte-identical.
- [ ] T011 [US1][US2] In the same file, mark `parseIssueRef` `@internal` in its JSDoc, explaining that cockpit callers must use `resolveIssueContext` and that this function is exported only for its own unit tests (FR-006, Q1→C). Reference #850 and the ESLint rule.
- [ ] T012 [US1][US2] In `resolver.ts`, refactor `resolveIssueContext` to gate bare numbers *before* delegating to `parseIssueRef` (Q2→C):
  - Trim `input.issue`; if `BARE_NUMBER.test(trimmed)`, parse the integer, resolve `repoNwo` from `input.repo ?? inferRepoFromGitOrigin(runner, input.cwd)`, split on `/`, and return `makeRef(owner, repo, number)` inside a `ResolvedIssueContext`.
  - Rewrap any error thrown by `inferRepoFromGitOrigin` into the FR-002 sentence: `` `parse issue: bare issue number "${trimmed}" is not accepted here. Accepted: <owner>/<repo>#${trimmed}, a full issue URL, or a bare number inside a checkout with a resolvable GitHub origin. (cwd-origin inference failed: ${innerReason})` ``, where `innerReason` is the inner Error message with any leading `parse issue: ` prefix stripped.
  - Delete the `try { parseIssueRef } catch { if (!/bare issue number/.test(message)) throw }` sentinel and the redundant `Number.parseInt` + `Number.isInteger` re-check (`> 0` is guaranteed by `/^\d+$/` + `makeRef`).
  - For qualified inputs, fall through to `parseIssueRef(input.issue)` and return the bundle unchanged.
- [ ] T013 [US1][US2] Verify (grep) after T010–T012: `grep -n "repos are not configured" packages/generacy/src/cli/commands/cockpit/resolver.ts` returns nothing; `grep -n "bare issue number" packages/generacy/src/cli/commands/cockpit/resolver.ts` shows *only* the new FR-002 sentence inside `resolveIssueContext`; `grep -n "cockpit.repos" packages/generacy/src/cli/commands/cockpit/resolver.ts` returns nothing.

## Phase 3: Call-site Migrations

<!-- Sequential relative to Phase 2 (both edit files that import from resolver.ts, whose surface just changed). T020 and T021 are parallel with each other. -->

- [ ] T020 [P] [US1] In `packages/generacy/src/cli/commands/cockpit/advance.ts`, replace `parseIssueRef(issue)` at `~line 108` with `await resolveIssueContext({ issue, runner: deps.runner })`. Source `ref` and `gh` from the returned ctx (keep `deps.gh` override winning). Drop the runtime `parseIssueRef` import from the top of the file; import `resolveIssueContext` in its place. `IssueRef` continues as a type-only import. Downstream `gh.fetchIssueLabels(ref.nwo, ref.number)` and the `CockpitExit(2, `Error: cockpit advance: ${err.message}`)` wrap stay unchanged.
- [ ] T021 [P] [US3] In `packages/generacy/src/cli/commands/cockpit/context.ts`, apply the same swap at `~line 156` (the second offender identified by FR-005 audit). Same import edits, same ctx-sourced `gh`. Preserve the `CockpitExit(2, `Error: cockpit context: ${err.message}`)` wrap.
- [ ] T022 [US3] After T020 + T021, run `grep -rn "parseIssueRef" packages/generacy/src/cli/commands/cockpit/ | grep -v resolver.ts | grep -v __tests__` and confirm zero output (SC-004 audit).

## Phase 4: ESLint Rule (FR-006 invariant)

- [ ] T030 [US3] In the root `.eslintrc.json`, add a new `overrides` entry after the existing per-file allow-list block (adjacent to the current `child_process` restriction). Target `packages/generacy/src/cli/commands/cockpit/**/*.ts`, exclude `resolver.ts` and `__tests__/**`. Under `no-restricted-imports.paths[]`, carry forward the existing `child_process` and `node:child_process` entries (overrides *replace* the parent rule — merging is not automatic) and add:
  ```json
  {
    "name": "./resolver.js",
    "importNames": ["parseIssueRef"],
    "message": "Import `resolveIssueContext` from './resolver.js' instead. `parseIssueRef` is a strict qualified-forms parser — cockpit verbs must go through `resolveIssueContext` so bare-number cwd-origin inference works uniformly. See #850."
  }
  ```
  Rule message MUST name `resolveIssueContext` (FR-006 explicit).
- [ ] T031 [US3] Run `pnpm --filter @generacy-ai/generacy lint`. Expected: clean. If ESLint rejects `importNames` on `no-restricted-imports.paths[]` (CI-version schema variance), fall back to the `patterns[]` shape documented in `contracts/eslint-rule.md` (`group: ["**/resolver.js"]`) — behaviorally identical for the current call sites.
- [ ] T032 [US3] Intentional-violation smoke test (revert immediately): temporarily add `import { parseIssueRef } from './resolver.js';` to `advance.ts`'s import block, run `pnpm --filter @generacy-ai/generacy lint`, confirm ESLint fails with the FR-006 rule message naming `resolveIssueContext`. `git checkout -- packages/generacy/src/cli/commands/cockpit/advance.ts`.

## Phase 5: Test Rewrite (FR-007)

- [ ] T040 [US2] In `packages/generacy/src/cli/commands/cockpit/__tests__/resolver.test.ts`, delete the line-6 test (`refuses a bare number (repos are not configured)`) — post-T010 `parseIssueRef('123')` no longer has a bare-number branch and its throw is already covered by the `rejects garbage` case (~line 48). Keep every other `parseIssueRef` test unchanged.
- [ ] T041 [US1][US2] In the same file's `resolveIssueContext` block, add: `bare number with unresolvable origin fails with the FR-002 copy`. Runner stub returns non-zero exit for `git remote get-url origin`. Assert the thrown message:
  - matches `/parse issue: bare issue number "123" is not accepted here\./`,
  - matches `/Accepted: <owner>\/<repo>#123, a full issue URL, or a bare number inside a checkout/`,
  - does NOT contain `repos are not configured`,
  - does NOT contain `cockpit.repos`.
- [ ] T042 [US1] Tighten the existing `fails loudly when bare number is passed and git origin lookup fails` case (~line 110-119): retain the inner `could not infer owner/repo` assertion but wrap it inside the new FR-002 outer sentence (assert both, in order).
- [ ] T043 [US1] Extend the `input.repo` override case (~lines 94-108) to additionally assert the runner is *never* called for the origin lookup on this path — the programmatic override MUST short-circuit inference.
- [ ] T044 [P] [US1][US2] In `packages/generacy/src/cli/commands/cockpit/__tests__/advance.test.ts` (create if absent, mirroring the shape of `status.test.ts`), add three cases:
  1. Bare-number happy path: runner stub returns `https://github.com/owner/repo.git`; assert the code path calls `gh.fetchIssueLabels('owner/repo', 2)` (or the closest existing `gh` seam), i.e. resolves the ref without a parse error.
  2. Bare-number failure: runner stub exits non-zero; assert `CockpitExit(2, msg)` with `msg` matching the FR-002 copy.
  3. Regression: `owner/repo#2` still routes with no runner call for origin.
- [ ] T045 [P] [US3] In `packages/generacy/src/cli/commands/cockpit/__tests__/context.test.ts` (create if absent), add the same three-case matrix for `context`.
- [ ] T046 [US2] Grep the test tree post-edits: `grep -rn "repos are not configured" packages/generacy/src/cli/commands/cockpit/__tests__/` returns nothing (SC-002 net). `grep -rn "cockpit.repos" packages/generacy/src/cli/commands/cockpit/__tests__/` returns nothing.

## Phase 6: Acceptance & Verification

<!-- Sequential, gated on Phases 2-5 being complete. -->

- [ ] T050 [US1] Build the package: `pnpm --filter @generacy-ai/generacy build`.
- [ ] T051 [US1] SC-001: from inside `/workspaces/generacy`, run `node packages/generacy/bin/generacy.js cockpit advance 2 --gate implementation-review`. Assert exit code is either `0` or a non-zero *downstream* code (gh IO, gate refusal). It MUST NOT be `2` with `parse issue: bare issue number`. Capture output for the PR body as the "after" evidence.
- [ ] T052 [US2] SC-001 fail-closed cross-check: `mkdir -p /tmp/no-origin && cd /tmp/no-origin && git init >/dev/null && node /workspaces/generacy/packages/generacy/bin/generacy.js cockpit advance 2 --gate implementation-review`. Assert the emitted message matches the FR-002 template (accepted-forms enumeration, no `repos are not configured` or `cockpit.repos` substring, trailing `(cwd-origin inference failed: …)` clause).
- [ ] T053 [P] [US2] SC-002 grep: `grep -r "repos are not configured" /workspaces/generacy/packages/generacy/src/` returns nothing (exit 1).
- [ ] T054 [P] [US2] SC-003 grep: `grep -r "cockpit.repos" /workspaces/generacy/packages/generacy/src/` returns nothing (exit 1). Historical `specs/` docs are out of scope.
- [ ] T055 [P] [US3] SC-004 grep: `grep -rn "parseIssueRef" /workspaces/generacy/packages/generacy/src/cli/commands/cockpit/ | grep -v resolver.ts | grep -v __tests__` returns nothing.
- [ ] T056 [US1][US2] SC-005: `pnpm --filter @generacy-ai/generacy test -- resolver.test.ts` — green. Then `pnpm --filter @generacy-ai/generacy test` — green.
- [ ] T057 [US3] US3 sibling-verb parity smoke (quickstart §4): iterate `for verb in status watch queue advance context merge; do node packages/generacy/bin/generacy.js cockpit $verb 2 --gate implementation-review 2>&1 | head -1; done`. Confirm no line contains `parse issue: bare issue number "2" is not accepted`. (Downstream errors unrelated to the ref grammar are acceptable and expected for some verb/flag combinations — the metric is grammar acceptance.)
- [ ] T058 [US3] Final `pnpm --filter @generacy-ai/generacy lint` — clean.

## Dependencies & Execution Order

**Sequential spine**: Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6.

- Phase 2 (T010–T013) is the load-bearing edit: `resolver.ts` must be at its new shape before any call-site swap (Phase 3) or test rewrite (Phase 5) can be validated.
- Phase 3 (T020, T021) can run in parallel with each other — different files, no shared symbols — but both must finish before T022's audit grep.
- Phase 4 (T030–T032) is independent of Phase 3 for the file edit itself (T030), but T031/T032 lint the migrated code, so they should run after Phase 3 lands.
- Phase 5 tests: T040–T043 all touch `resolver.test.ts` and must run sequentially. T044 and T045 are `[P]` — different test files.
- Phase 6 verification is a strict sequential gate on all prior phases (build → run → grep → test → lint).

**Parallel opportunities**:
- T002 alongside T001 (both are read-only baseline captures).
- T020 ‖ T021 (advance.ts vs context.ts — no shared writes).
- T044 ‖ T045 (advance.test.ts vs context.test.ts).
- T053 ‖ T054 ‖ T055 (three independent greps).

**Story coverage**:
- **US1** (bare-number advance succeeds): T010, T012, T020, T041, T042, T043, T044, T050, T051, T056.
- **US2** (error message points at a real remedy): T010, T011, T012, T040, T041, T044, T046, T052, T053, T054.
- **US3** (no other verb on the old parser): T021, T022, T030, T031, T032, T045, T055, T057, T058.

**Success-criterion mapping**:
- SC-001 → T050, T051 (positive), T052 (fail-closed).
- SC-002 → T013, T046, T053.
- SC-003 → T013, T046, T054.
- SC-004 → T022, T030–T032, T055, T058.
- SC-005 → T040–T043, T056.

# Tasks: `/cockpit:auto` doorbell webhook-config channel discovery

**Input**: Design documents from `/specs/988-summary-cockpit-auto-doorbell/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/channel-discovery.md, contracts/webhook-target-resolver.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Setup

- [X] T001 [P] Add `.changeset/988-doorbell-webhook-config-discovery.md`: `patch` bump for `@generacy-ai/generacy`, one-sentence body describing the webhook-config discovery stage that removes the `COCKPIT_DOORBELL_SMEE_URL` workaround for non-shared-FS operator sessions (satisfies FR-011 / CI gate).

## Phase 2: Core Implementation — Data model & pure function

- [X] T002 [US1] Extend `packages/generacy/src/cli/commands/cockpit/doorbell/channel-discovery.ts` to widen `ChannelDiscoveryInput` with the three new optional fields per `data-model.md` §"Extended: ChannelDiscoveryInput":
  - `targets?: Array<{ owner: string; repo: string }>`
  - `runner?: CommandRunner` (import `CommandRunner` type from `@generacy-ai/cockpit`)
  - `webhookConfigTimeoutMs?: number`
  Keep JSDoc mirroring the data-model contract (skip semantics: absent runner OR empty targets → silent no-op).

- [X] T003 [US1] Extend `ChannelSource` union in `packages/generacy/src/cli/commands/cockpit/doorbell/channel-discovery.ts` to add the `'webhook-config'` variant per `data-model.md` §"Extended: ChannelSource union". Do NOT introduce a new `SourceReason` — the FR-006 stderr line (`source=smee reason=startup-smee-selected`) is produced by `source-selector.ts:35`'s existing "every non-poll source → `smee`" mapping (research R5). Verify the selector still maps `'webhook-config'` → `smee` label after the union change.

- [X] T004 [US1] Add `SmeeHookSchema` (Zod, with `.passthrough()`) and exported `SmeeHook` type inside `packages/generacy/src/cli/commands/cockpit/doorbell/channel-discovery.ts` per `data-model.md` §"New: SmeeHook". Validate only `{ id: number.int, active: boolean, config: { url: string }, updated_at: string }`.

- [X] T005 [US1] [US2] Add exported pure function `pickSmeeHook(hooks: SmeeHook[]): SmeeHook | null` in `packages/generacy/src/cli/commands/cockpit/doorbell/channel-discovery.ts` per `contracts/channel-discovery.md` §"pickSmeeHook — tie-break (FR-005)":
  1. Filter `active === true`.
  2. Filter `SMEE_URL_PATTERN.test(config.url)` (reuse the existing regex constant already in the file).
  3. Sort by `Date.parse(updated_at)` desc; `NaN` → `-Infinity` (sorts last).
  4. Return `sorted[0] ?? null`.
  Deterministic, zero I/O, no side effects.

## Phase 3: Core Implementation — Webhook-config stage & target resolver

- [X] T006 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/doorbell/webhook-target-resolver.ts` per `contracts/webhook-target-resolver.md`:
  - Export `ResolveWebhookTargetsInput` and `resolveWebhookTargets` matching the contract.
  - Call `resolveEpic({ epicRef, gh, logger })` from `@generacy-ai/cockpit`.
  - Success: primary-first `[resolved.epic.repo, ...resolved.repos.filter(r => r !== resolved.epic.repo)]`, split each `"owner/repo"` on `/`, skip malformed with one warn line (`cockpit doorbell: webhook-target: skipping malformed repo "<value>"`).
  - Failure: catch every thrown error (including `LoudResolverError`), log one warn (`cockpit doorbell: webhook-target resolution failed: <message>`), return `[]`.
  - **Never throws.** No other imports beyond `@generacy-ai/cockpit`.

- [X] T007 [US1] [US2] Implement the `webhook-config` stage inside `discoverChannelUrl` in `packages/generacy/src/cli/commands/cockpit/doorbell/channel-discovery.ts` per `contracts/channel-discovery.md` §"Lookup order (FR-004)". Slot it between the existing env stage and the walk-up scan. Requirements:
  - Skip silently (no warn) when `input.runner == null` OR `input.targets == null || input.targets.length === 0`.
  - Per-target loop, primary-first (FR-008): call `runner('gh', ['api', ` `/repos/${owner}/${repo}/hooks` `], { timeoutMs: input.webhookConfigTimeoutMs ?? 5_000 })`.
  - Non-zero `exitCode` (including `124` timeout): one warn `cockpit doorbell: webhook-config stage failed for <owner>/<repo>: exit=<code>` → advance to next target.
  - `JSON.parse` failure: one warn `cockpit doorbell: webhook-config stage: malformed JSON for <owner>/<repo>` → advance.
  - `z.array(SmeeHookSchema).safeParse` failure: one warn `cockpit doorbell: webhook-config stage: unexpected /hooks shape for <owner>/<repo>` → advance.
  - `pickSmeeHook(parsed) == null`: **silent** (no warn — routine outcome per FR-006), advance.
  - `pickSmeeHook(parsed) != null`: return `{ url: hook.config.url, source: 'webhook-config' }` immediately (early-stop).
  - After exhausting all targets: fall through to walk-up (existing behavior preserved).
  - **Never throw.** Guarantees: no `cwd` mutation, backwards-compatible when callers omit `targets`/`runner`.

- [X] T008 [US1] Wire the new stage in `packages/generacy/src/cli/commands/cockpit/doorbell.ts` per plan §"Phase 3.3 — doorbell.ts wiring":
  - Inside the existing `discoverChannel` branch (guarded by `deps.gh != null || deps.discoverChannel != null` at `doorbell.ts:375-393`), when `deps.gh != null`:
    1. Call `resolveWebhookTargets({ epicRef: form.ref, gh: deps.gh, logger })` **before** invoking `discover(...)`.
    2. Pass the resulting `targets` array and `deps.runner ?? nodeChildProcessRunner` (import is already available) into the `discoverChannelUrl` input alongside the existing fields.
  - The `discoverChannel` test seam stays unchanged; do not alter the `armed\n` timing or ordering (agency#431/#437 depend on it).

## Phase 4: Tests

- [X] T009 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/webhook-target-resolver.test.ts` with the four cases from `contracts/webhook-target-resolver.md` §"Test scaffolding":
  - **T1** single-repo epic → `[{ owner, repo }]`.
  - **T2** multi-repo epic `acme/coord#5` with siblings `acme/foo`, `acme/bar` → `[{acme,coord},{acme,foo},{acme,bar}]` (primary-first + dedup).
  - **T3** `resolveEpic` throws `INVALID_EPIC_REF` → `[]` + one warn.
  - **T4** `resolveEpic` throws `NO_REFS` → `[]` + one warn.
  Stub `GhWrapper` in-memory; assert warn spy call count.

- [X] T010 [US1] [US2] Extend `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/channel-discovery.test.ts` with the seven `webhook-config` cases from `contracts/channel-discovery.md` §"Test scaffolding":
  - **W1** primary-target hit → `{ url: 'https://smee.io/abc', source: 'webhook-config' }`.
  - **W2** stale+fresh tie-break (two active smee with distinct `updated_at`) → newer wins (SC-004 regression).
  - **W3** multi-repo primary-first → primary's URL, exactly **1** runner call.
  - **W4** multi-repo fallback to sibling → sibling's URL, exactly **2** runner calls.
  - **W5** 403 fall-through (`exitCode: 1`, stderr `HTTP 403`) → walk-up + 1 warn.
  - **W6** timeout fall-through (`exitCode: 124`) → walk-up + 1 warn.
  - **W7** no-runner no-op (targets provided, runner omitted) → silent skip, no warn.
  Use an in-memory `CommandRunner` stub; retain all 9 existing FS-stage cases unchanged.

- [X] T011 [US1] Add regression case **B1** to `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/doorbell-source-branch.test.ts` (or the file that currently exercises the `SourceSelector` stderr contract) per `contracts/channel-discovery.md` §"Additional case in doorbell-source-branch.test.ts":
  - Stub a `CommandRunner` that returns a smee-pattern `[/hooks]` payload; no `env[COCKPIT_DOORBELL_SMEE_URL]`; no FS setup.
  - Assert stderr contains `source=smee reason=startup-smee-selected` and stdout contains `armed`.
  - Regression coverage for SC-001. If the doorbell-source-branch test file does not exist, create it under `__tests__/` next to the other doorbell tests.

## Phase 5: Verification

- [X] T012 [P] [US1] Run `pnpm --filter @generacy-ai/generacy test` and confirm all 4 new resolver tests + 7 new discovery tests + 1 regression case pass alongside the existing suite (zero regressions in the 9 existing FS-stage cases).

- [X] T013 [P] [US1] Run `pnpm --filter @generacy-ai/generacy build` and `pnpm --filter @generacy-ai/generacy typecheck` (or the repo's `pnpm typecheck` equivalent). Ensure the `ChannelSource` union expansion did not break the `SourceSelector` mapping and no non-null-assertions were introduced by the new optional fields.

- [ ] T014 [US1] [US2] [manual] Manual quickstart verification per `specs/988-summary-cockpit-auto-doorbell/quickstart.md` §"Verification checklist" from an operator devcontainer that does NOT share the cluster's `/workspaces` or `/var/lib/generacy` mount:
  - SC-001: `unset COCKPIT_DOORBELL_SMEE_URL` + no shared FS → stderr contains `source=smee reason=startup-smee-selected`.
  - SC-002: `gh api …/hooks` called **once** at startup, zero calls during event stream (instrument or count via `NODE_DEBUG=1`).
  - SC-003: token without `admin:repo_hook` scope → exit code 0, fall-through to `source=poll-fallback reason=startup-no-channel`.
  - SC-004: register a stale+active smee hook pair → active newer URL wins.
  - SC-005: simulate a hung `gh api` (e.g., `PATH=/tmp/hang-gh:$PATH`) → warn line at ~5s + fall-through, `armed` reached via downstream stage.
  Record observed stderr/stdout lines for each check.

- [ ] T015 [US1] [manual] Confirm `.changeset/988-doorbell-webhook-config-discovery.md` from T001 is committed (not just staged) and that `pnpm changeset status` (working-tree read) lists a `patch` entry for `@generacy-ai/generacy`. The CI gate `.github/workflows/changeset-bot.yml` greps `--diff-filter=A` against `origin/develop` — an edit to an existing changeset does NOT satisfy it; a newly added file does.

## Dependencies & Execution Order

**Phase order** (sequential):
- Phase 1 (Setup: changeset) → can run anytime, standalone.
- Phase 2 (Data model & pure function) → Phase 3 (Stage & resolver) → Phase 4 (Tests) → Phase 5 (Verification).

**Within Phase 2** — all edits are in the same file (`channel-discovery.ts`), so T002 → T003 → T004 → T005 in that order (edits stack cleanly). No `[P]` markers.

**Within Phase 3**:
- T006 (`webhook-target-resolver.ts`, new file) is independent of T007 — mark `[P]`.
- T007 (webhook-config stage in `channel-discovery.ts`) depends on T002, T003, T004, T005.
- T008 (wiring in `doorbell.ts`) depends on T006 AND T007 — both must land first.

**Within Phase 4**:
- T009 (resolver tests, new file) is `[P]` — depends on T006 only.
- T010 (discovery tests, extends existing file) depends on T007.
- T011 (source-branch regression) depends on T007 AND T008.

**Within Phase 5**:
- T012 (test run) and T013 (build/typecheck) are `[P]` — both depend on Phase 4 completion.
- T014 (manual quickstart) depends on T013 (needs a working build).
- T015 (changeset committed) depends on T001 and pre-PR staging.

**Parallel opportunities**:
- T001 can start alongside Phase 2 (independent file).
- T006 in parallel with T007's file-local prep in `channel-discovery.ts` (different files).
- T009 in parallel with the discovery/source-branch test authoring once T006 lands.
- T012 and T013 in parallel once tests are written.

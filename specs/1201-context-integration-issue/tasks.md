# Tasks: P1 route plumbing end-to-end verification

**Input**: Design documents from `/specs/1201-context-integration-issue/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Overview

This is a **tests + one docs note only** integration issue closing P1 of the LLM gateway
model routing epic (generacy-ai/generacy#1197). No production mechanism ships here — the
tests assert contracts shipped by siblings #1198/#1199/#1200. All new files are test files,
fixtures, one docs page edit, and one changeset. No `packages/*/src/` production source
change is planned (a ≤ small surgical seam fix may land only if a genuine untestable seam is
discovered, per plan D-1 note).

---

## Phase 1: Dependency Gate & Setup
<!-- Phase boundary: Complete Phase 1 before starting Phase 2 -->

- [ ] T001 [Setup] **Dependency gate (clarification Q3=A — BLOCKING).** Verify all three
      siblings are merged to `develop` and this branch is rebased on them by running:
      `grep -rn "resolveRoute\|GatewayRouteUnavailableError\|agent.route.transition" packages/`
      — this MUST return production (non-test) hits for `resolveRoute` +
      `GatewayRouteUnavailableError` (#1198) and `agent.route.transition` (#1199), plus the
      `generacy validate`/`doctor` `llm-gateway` surfaces (#1200). If any are missing,
      **dependency-block: skip and requeue** until #1198/#1199/#1200 land on develop and this
      branch is rebased (matches #1127 precedent). Do NOT proceed to any test-writing task
      until this passes.

- [ ] T002 [Setup] Confirm the exact merged API bindings the deferred tests must target
      (plan D-6): inspect the merged `resolveRoute` export + `GatewayRouteUnavailableError`
      in `packages/generacy-plugin-claude-code/src/launch/`, the gateway env key
      (`CLAUDE_CONFIG_DIR`, default `/home/node/.claude-gateway`, override
      `GENERACY_CLAUDE_GATEWAY_CONFIG_DIR`), and #1199's session-drop hook + log call shape in
      `packages/orchestrator/src/worker/`. Record the concrete symbols/signatures so T010,
      T020, T030 bind to real code, not the pinned behavior placeholders.

- [ ] T003 [Setup] Confirm the launcher/interceptor seams still match plan §Technical Context
      (they may have shifted with sibling merges): `AgentLauncher.launch` +
      injectable `ProcessFactory` map + env merge in
      `packages/orchestrator/src/launcher/agent-launcher.ts`; `wrapCommand()`/`applyCredentials()`
      in `packages/orchestrator/src/launcher/credentials-interceptor.ts`; the six launch
      builders in
      `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts`
      (phase, pr-feedback, merge-conflict, review, remediate, conversation-turn).

## Phase 2: US1 — Gateway launches carry the config dir; subscription launches do not
<!-- Phase boundary: Complete Phase 1 before starting Phase 2 -->

- [ ] T010 [US1] Create `packages/orchestrator/src/launcher/__tests__/route-launch-env.test.ts`.
      Drive the **real** `AgentLauncher.launch` through the **real** credentials interceptor
      (not a mock of it — FR-001), using a spy `ProcessFactory` map (`default` + `interactive`
      profiles) and a stub `CredhelperClient` (`StubCredhelperClient` per data-model.md §Test
      doubles). Follow the `multi-provider.test.ts` construction precedent.

- [ ] T011 [US1] In `route-launch-env.test.ts`, assert (FR-002): a **gateway-route** intent
      (model containing `/`, e.g. `openai/gpt-4o`) produces a spawned env at `factory.spawn`
      containing `CLAUDE_CONFIG_DIR=<gatewayConfigDir>`; a **subscription-route** intent
      (`undefined`/`claude-*`/alias) produces a spawned env with **no** `CLAUDE_CONFIG_DIR`
      key (absent — not empty string, not default; see contracts/route-launch-env.md).

- [ ] T012 [US1] In `route-launch-env.test.ts`, add the negative case: a gateway-route intent
      with **no gateway config available** throws `GatewayRouteUnavailableError` from `launch`
      and **no spawn occurs** (assert `factory.spawn` not called).

- [ ] T013 [US1] In `route-launch-env.test.ts`, add the FR-003 **real-spawn wrapper proof**
      (plan D-4, spawn-e2e.test.ts precedent): spawn the actual
      `sh -c '. "$GENERACY_SESSION_DIR/env" && exec "$@"' _ /usr/bin/env` with a temp
      session-dir env file and `CLAUDE_CONFIG_DIR=<sentinel>` in the parent env; assert stdout
      contains `CLAUDE_CONFIG_DIR=<sentinel>` — proving the wrapper does not strip inherited env.

## Phase 3: US2 — Subscription-only clusters are byte-for-byte unchanged (load-bearing)
<!-- Phase boundary: Complete Phase 1 before starting Phase 3; independent of Phase 2 -->

- [ ] T020 [US2] Create `packages/orchestrator/src/launcher/__tests__/golden-subscription-spawns.test.ts`
      (plan D-1/D-2). Compose the real `ClaudeCodeLaunchPlugin` + real credentials interceptor
      + spy `ProcessFactory` (both stdio profiles) driving `AgentLauncher.launch` for all six
      spawn kinds: phase, pr-feedback, merge-conflict, review, remediate, conversation-turn
      (`invoke` excluded). Implement the determinism harness (D-2): `beforeEach` replaces
      `process.env` wholesale with `{ PATH: '/usr/bin', HOME: '/home/fixed' }` (restore in
      `afterEach`), stub `CredhelperClient` → fixed session (`sessionDir: '/fixed/session'`,
      fixed env), fixed `cwd: '/fixed/checkout'`, fixed intent literals per kind.

- [ ] T021 [US2] In `golden-subscription-spawns.test.ts`, add the `stableStringify` helper
      (recursive key sort; arrays keep order) and a `GOLDEN_UPDATE=1` capture branch that
      writes `fixtures/subscription-baseline.json` (shape per contracts/golden-fixture.md +
      data-model.md), plus the comparison branch: `stableStringify(actual) ===
      stableStringify(fixture.spawns[kind])` per kind, failing with a unified diff.
      `capturedAt`/`sourceSha` are metadata only, excluded from comparison.

- [ ] T022 [US2] **Capture the golden fixture from the pre-P1 merge-base** (Q1=C, plan D-3,
      quickstart §Capturing). Find `<PRE_P1_SHA>` (`develop` commit immediately before #1198's
      merge via `git log --first-parent --merges develop`); `git worktree add ../generacy-pre-p1
      <PRE_P1_SHA>`; `pnpm install && pnpm -r build` there; copy the T020/T021 harness + fixtures
      dir into the worktree; run `GOLDEN_UPDATE=1 pnpm --filter @generacy-ai/orchestrator vitest
      run golden`; copy the generated
      `packages/orchestrator/src/launcher/__tests__/fixtures/subscription-baseline.json` back to
      this branch; `git worktree remove ../generacy-pre-p1`. Fixture MUST contain no
      `CLAUDE_CONFIG_DIR` in any env map (contracts/golden-fixture.md invariant 2).

- [ ] T023 [US2] Create
      `packages/orchestrator/src/launcher/__tests__/fixtures/README.md` recording the fixture
      provenance: `<PRE_P1_SHA>`, capture date (2026-08-26+), and the regeneration protocol
      (`GOLDEN_UPDATE=1 ... vitest run golden` + PR-description justification; fixture-only diff
      is a review red flag).

- [ ] T024 [US2] Run `golden-subscription-spawns.test.ts` against the current (post-P1) branch
      with no gateway configured + fully Anthropic config; confirm all six spawn kinds are
      byte-identical to the captured baseline (FR-005 / SC-002 — zero byte differences).

## Phase 4: US3 — Cross-route phase transition drops the CLI session
<!-- Phase boundary: Complete Phase 1 before starting Phase 4; independent of Phases 2-3 -->

- [ ] T030 [US3] Create `packages/orchestrator/src/worker/__tests__/phase-loop.route-transition.test.ts`
      (plan D-6, contracts/route-launch-env.md §Route-aware session invalidation). Bind to
      #1199's merged session-drop hook + log call shape (from T002). Drive the phase loop
      through a three-phase sequence whose resolved per-phase agents alternate
      `subscription → gateway → subscription`, with a recording logger injected via phase-loop
      deps and `resumeSessionId` observed at the spawn boundary (mock cliSpawner / spy factory).

- [ ] T031 [US3] In `phase-loop.route-transition.test.ts`, assert (FR-006 / SC-003) **exactly
      2 session drops**: the CLI session id captured from phase N is NOT supplied as
      `resumeSessionId` to phase N+1 across either crossing. Assert same-route/same-provider
      transitions drop nothing (control case if convenient).

- [ ] T032 [US3] In `phase-loop.route-transition.test.ts`, assert (FR-007) **one
      `agent.route.transition` log line per crossing**, keyed on the `(provider, route)` tuple,
      matching #1199's log contract as bound in T002.

## Phase 5: US4 — Docs note
<!-- Phase boundary: Complete Phase 1 before starting Phase 5; independent of Phases 2-4 -->

- [ ] T040 [US4] Add a short "Model routing" note to
      `docs/docs/getting-started/configuration.md` (FR-008, plan D-7): explain gateway-shaped
      model names (`provider/model`), where the gateway comes from, and link to the epic
      (generacy-ai/generacy#1197) and P2 issue (generacy#1203) as external GitHub URLs (NOT
      docs-page links — `onBrokenLinks: 'throw'`). Mark the note explicitly "requires a
      gateway-enabled cluster."

- [ ] T041 [US4] Build the docs to confirm no broken links:
      `cd docs && pnpm install && pnpm build` (`onBrokenLinks: 'throw'` must pass).

## Phase 6: Guards, Changeset & Final Verification
<!-- Phase boundary: Complete Phases 2-5 before starting Phase 6 -->

- [ ] T050 [P] [Polish] Create `packages/orchestrator/src/launcher/__tests__/no-settings-flag.test.ts`
      (FR-009 / SC-004, plan D-5, source-grep.test.ts precedent). Recursive `readdirSync` walk
      of `packages/orchestrator/src/launcher/**` and
      `packages/generacy-plugin-claude-code/src/launch/**`, filtering to non-test `.ts` files
      (exclude any `__tests__` segment and `*.test.ts` — the guard file itself contains the
      literal), asserting `content.includes('--settings') === false` for every scanned file.

- [ ] T051 [P] [Polish] Add the changeset (FR-011 / SC-006): `pnpm changeset --empty` →
      `.changeset/1201-p1-route-verification.md` (tests/fixtures/docs-only diff). If any seam
      fix under `packages/*/src/` landed during implementation, replace the empty changeset with
      a **patch** bump for the touched package instead.

- [ ] T052 [Polish] Full green run (SC-001): `pnpm -r build` then
      `pnpm --filter @generacy-ai/orchestrator vitest run route-launch-env
      golden-subscription-spawns no-settings-flag phase-loop.route-transition`. Confirm all
      suites pass. Spot-check SC-005: `git diff` shows zero `AgentEntrySchema` changes.

## Dependencies & Execution Order

**Phase boundaries** (sequential):
- **Phase 1 → { Phase 2, Phase 3, Phase 4, Phase 5 } → Phase 6.**
- Phase 1 is a hard gate: T001 (dependency gate) must pass before ANY test-writing task
  begins. T002/T003 (API/seam binding confirmation) feed all downstream test tasks.

**Parallel opportunities**:
- Phases 2, 3, 4, and 5 are mutually independent (separate files, separate user stories) and
  may proceed in parallel once Phase 1 completes.
- Within Phase 6, T050 (guard test) and T051 (changeset) are independent `[P]`. T052 (final
  verification) must run last, after all other phases complete.
- Within Phase 3, the order is strict: T020 → T021 → T022 (capture requires the harness) →
  T023 → T024.

**Critical path**: T001 → T002 → T020 → T021 → T022 → T024 → T052.

**Note**: All test bindings for #1199's session-drop hook (Phase 4) resolve at implement
time against merged code (plan D-6); the pinned behavior in T030-T032 is the contract, the
exact API is bound in T002.

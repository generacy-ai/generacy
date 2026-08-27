# Tasks: Gateway-route validate warning + doctor llm-gateway check

**Input**: Design documents from `/specs/1200-context-gateway-shaped-model/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 0: Hard Dependency Gate (BLOCKING)

- [X] T001 Verify the `resolveRoute` export exists in `@generacy-ai/generacy-plugin-claude-code`
  before doing any implementation work. Run:
  `grep -rn "export.*resolveRoute" packages/generacy-plugin-claude-code/src/`
  (scoped to the plugin package — an unrelated `resolveRoute` lives in
  `packages/cluster-relay/src/dispatcher.ts`; do not match that).
  Confirm the signature is `resolveRoute(model?: string): 'subscription' | 'gateway'`
  (`'gateway'` iff model contains `/`). **If the export is absent, STOP and
  block/requeue this issue per Q1=A / FR-011 — do NOT define the helper or ship a
  local interim classifier.** See `contracts/resolve-route-dependency.md`.

## Phase 1: Setup

- [X] T002 Add `"@generacy-ai/generacy-plugin-claude-code": "workspace:*"` to
  `dependencies` in `packages/generacy/package.json` (currently absent — only
  `@generacy-ai/cockpit` and `@generacy-ai/config` are present). Run `pnpm install`
  to update the lockfile so the FR-011 import resolves. (Depends on T001.)

## Phase 2: Config schema (foundational — unblocks the cockpit walk)

- [X] T003 [US1] Add `cockpit: z.unknown().optional()` to `GeneracyConfigSchema` in
  `packages/generacy/src/config/schema.ts` (D-3). Today it is a plain `z.object` that
  strips unknown keys, so a `cockpit:` block never reaches the warning walk. This
  lenient passthrough keeps the bytes without asserting shape. No other schema change.

## Phase 3: Validate warning (US1)
<!-- Phase boundary: Complete Phase 2 (schema) before starting — the cockpit walk depends on the passthrough key. -->

- [X] T004 [US1] Implement `collectGatewayWarnings(config, env = process.env): string[]`
  in `packages/generacy/src/config/loader.ts`, mirroring the tier-walk of
  `collectEffortWarnings` (`loader.ts:346-411`). Import `resolveRoute` from
  `@generacy-ai/generacy-plugin-claude-code`. Warn only for entries that **explicitly
  set** `model` (early return `if (!entry?.model) return;`, D-2). Emit a warning iff
  `resolveRoute(entry.model) === 'gateway' && !env.GENERACY_LLM_GATEWAY_URL` (FR-003).
  Walk tiers: `orchestrator.agents.default`, `orchestrator.agents.workflows.<wf>.default`,
  `orchestrator.agents.workflows.<wf>.phases.<phase>` (FR-002). Warning text (D-7):
  `` `${path}.model — set to '<model>' which resolves to the gateway route, but GENERACY_LLM_GATEWAY_URL is not set in this environment. The model will not route anywhere at spawn time.` ``
  (FR-004). Never throws.

- [X] T005 [US1] Extend `collectGatewayWarnings` with the tolerant cockpit duck-walk
  (D-3) in `packages/generacy/src/config/loader.ts`: narrow into
  `cockpit.auto.agents.{default,clarifier,reviewer,validator,fixer,diagnoser}` with a
  `typeof x === 'object' && x !== null` guard at every level; read `model` only when
  `typeof entry.model === 'string'`. Emit paths `cockpit.auto.agents.default` and
  `cockpit.auto.agents.<role>` (data-model "Walked paths"). Absent/malformed cockpit
  block → no warnings, no crash. (Same file as T004 — sequential.)

- [X] T006 [US1] Wire gateway warnings into `loadConfigWithWarnings` in
  `packages/generacy/src/config/loader.ts` as
  `[...collectEffortWarnings(config), ...collectGatewayWarnings(config)]` (FR-001).
  Confirm the warnings channel keeps exit code 0 — no new error path (FR-005).
  (Same file as T004/T005 — sequential.)

## Phase 4: Doctor check (US2)
<!-- Phase boundary: independent of Phase 3; may start after Phase 1 (T002). Kept as its own phase for clarity. -->

- [X] T007 [US2] Create the `llm-gateway` check at
  `packages/generacy/src/cli/commands/doctor/checks/llm-gateway.ts`, mirroring the
  shape of `checks/anthropic-key.ts`. Identity (D-6): `id: 'llm-gateway'`,
  `label: 'LLM Gateway'`, `category: 'services'`, `priority: 'P1'`,
  `dependencies: ['config']` (NOT `['env-file']` — D-4). Read env as
  `context.envVars?.[K] ?? process.env[K]` for `GENERACY_LLM_GATEWAY_URL` and
  `GENERACY_LLM_GATEWAY_TOKEN` (Q2=C). Decision matrix (data-model): URL unset →
  `skip` (FR-007); URL set + token missing/empty → `fail` with token suggestion
  **without fetching** (FR-012, Q4=A); then the probe (T008).

- [X] T008 [US2] Implement the probe logic inside `llm-gateway.ts` (FR-008/FR-009/FR-010,
  D-5): primary `GET <url>/v1/models` with `Authorization: Bearer <token>` and
  `AbortSignal.timeout(2_000)`. 200 → `pass`, best-effort parse `data[].id` into detail
  (FR-009); 401 → `fail` (token suggestion); 404/405 → fall back to
  `POST <url>/v1/messages` `{ model, max_tokens: 1, messages: [{role:'user',content:'ping'}] }`
  using the first gateway-routed model found in config (walk order:
  `agents.default` → workflow defaults → phases → cockpit block); other non-200 →
  `fail` (`HTTP <status>` in detail). Fallback with no gateway-routed model in config →
  `warn` (reachable but unverifiable, D-5). Fallback response maps per FR-010 (200 →
  pass; 401 → fail token; other non-200 incl. 404/405 → fail HTTP). Network/timeout on
  either request → `fail` with reachability suggestion + `error.message` in detail.
  (Same file as T007 — sequential.)

- [X] T009 [US2] Register `llmGatewayCheck` in `createDefaultRegistry()` in
  `packages/generacy/src/cli/commands/doctor.ts`, placed after `agencyMcpCheck` to keep
  the Service-category grouping (FR-006, D-6).

## Phase 5: Tests

- [X] T010 [P] [US1] Add the warning-matrix tests at
  `packages/generacy/src/config/__tests__/gateway-warnings.test.ts` (SC-001/SC-004).
  `vi.mock` the `@generacy-ai/generacy-plugin-claude-code` package's `resolveRoute`;
  inject env via the second `collectGatewayWarnings` param (never mutate `process.env`).
  Cases: gateway model + no URL → 1 warning with the exact config path; gateway model +
  URL set → silent; subscription-route model → silent regardless of env; all four tiers
  covered incl. `cockpit.auto.agents.*`; malformed/absent cockpit block → no crash, no
  warning. Assert exact path fidelity (SC-004).

- [X] T011 [P] [US2] Add the doctor-check tests at
  `packages/generacy/src/cli/commands/doctor/checks/__tests__/llm-gateway.test.ts`
  (SC-002) using `vi.stubGlobal('fetch', ...)`. Cases: URL unset → `skip`; URL set +
  token missing → `fail` **and assert `fetch` was NOT called**; 200 → `pass` (+ model
  list in detail); 401 → `fail` (token); 404 on `/v1/models` → assert `POST /v1/messages`
  issued, map its response per FR-010; ECONNREFUSED → `fail` (reachability);
  `context.envVars`-vs-`process.env` precedence (Q2=C).

## Phase 6: Changeset & Verification

- [X] T012 Add the changeset `.changeset/1200-llm-gateway-doctor-validate.md` bumping
  `@generacy-ai/generacy` **minor** (new doctor check + new validate warning =
  user-visible capability; D-8, CLAUDE.md changeset gate). Must be a newly added file
  in the PR diff.

- [X] T013 Run `pnpm -r build` and the `@generacy-ai/generacy` package tests; confirm
  green (SC-003). Fix any type/lint fallout from the new workspace dependency and the
  `cockpit: z.unknown()` schema change.

## Dependencies & Execution Order

**Phase order (sequential gates)**:
- Phase 0 (T001) is a **hard block** — no implementation begins until `resolveRoute`
  is confirmed shipped by #1198. If absent, block/requeue.
- Phase 1 (T002) → adds the dependency the FR-011 import needs.
- Phase 2 (T003) → schema passthrough must land before the cockpit walk (T005) can see
  the block.

**Within-file sequencing (must be serial — same file)**:
- T004 → T005 → T006 all edit `loader.ts`.
- T007 → T008 edit `llm-gateway.ts`; T009 (separate file `doctor.ts`) follows T007/T008.

**Parallel opportunities**:
- After the implementation phases land, T010 and T011 are independent test files and
  can run in parallel `[P]`.
- The validate-warning track (Phase 3) and the doctor-check track (Phase 4) are
  independent once Phase 1+2 complete — they touch disjoint files and can be developed
  in parallel by two workers, converging at Phase 5/6.

**No playbook coupling**: this issue edits no `packages/claude-plugin-cockpit/commands/*.md`
files, so no `playbook-verification.test.ts` re-pin task is required.

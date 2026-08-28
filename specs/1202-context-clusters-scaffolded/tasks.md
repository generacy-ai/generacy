# Tasks: Optional llm-gateway (Bifrost) scaffolding

**Input**: Design documents from `/specs/1202-context-clusters-scaffolded/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1/US2/US3)

## Phase 0: Sequencing gate (blocking — do NOT skip)

- [ ] T001 Confirm generacy-ai/generacy#1203 (P2 dogfood) is **complete** before writing any
  implementation code. This is a hard blocks-on dependency (spec.md Dependencies, plan.md
  Sequencing step 1). If #1203 is open, stop and report — do not begin Phase 1.

## Phase 1: Foundations (types, schema, new module skeleton)

- [ ] T002 [US1] Add `llmGateway?: boolean` to `ScaffoldClusterYamlInput`, `ScaffoldComposeInput`,
  and `ScaffoldEnvInput` in `packages/generacy/src/cli/commands/cluster/scaffolder.ts`
  (data-model.md "Modified interfaces"). Types only — no emission logic yet.
- [ ] T003 [P] [US1] Add `llmGateway: z.boolean().default(false)` to `ClusterYamlSchema` in
  `packages/generacy/src/cli/commands/cluster/context.ts:32` (data-model.md "Modified schema").
- [ ] T004 [US1] Create `packages/generacy/src/cli/commands/cluster/llm-gateway.ts` with the four
  exported functions from data-model.md "New module": `resolveLlmGatewayToggle`,
  `generateGatewayToken` (`'sk-bf-' + randomBytes(24).toString('hex')`, `node:crypto`),
  `readExistingGatewayToken`, and `scaffoldLlmGatewayFiles(dir)`. Implement the resolver
  precedence (flag > `GENERACY_LLM_GATEWAY_ENABLED==='true'` > persisted > false) and token
  helpers here; `scaffoldLlmGatewayFiles` is fleshed out in Phase 3.

## Phase 2: Compose + env + cluster.yaml emission (core)

- [ ] T005 [US1] In `scaffoldDockerCompose` (`cluster/scaffolder.ts`), when `llmGateway` is true,
  append the `llm-gateway` service exactly per `contracts/llm-gateway-compose.yml`: image
  `maximhq/bifrost:v2.0.0`, `llm-gateway-data:/app/data` named volume,
  `./llm-gateway/config.json:/app/data/config.json:ro`, `env_file: [{ path: .env.local, required: false }]`,
  `environment: GENERACY_LLM_GATEWAY_TOKEN=${GENERACY_LLM_GATEWAY_TOKEN}`, `cluster-network` only
  (no host port), wget healthcheck (45s start_period), `restart: unless-stopped`. Add
  `llm-gateway-data: null` to the top-level `volumes` map. All emission strictly behind the boolean.
- [ ] T006 [US1] In the same function, append to **both** orchestrator and worker `environment`:
  `GENERACY_LLM_GATEWAY_URL=http://llm-gateway:8080/anthropic` and
  `GENERACY_LLM_GATEWAY_TOKEN=${GENERACY_LLM_GATEWAY_TOKEN}` (FR-003, plan §3). When false, zero
  changes to the compose object.
- [ ] T007 [US1] Update `scaffoldEnvFile` (`cluster/scaffolder.ts`) with token handling per plan §2:
  read existing `<dir>/.env`, extract an existing `GENERACY_LLM_GATEWAY_TOKEN=` via
  `readExistingGatewayToken`; if present always re-emit verbatim (even on disabled path); if
  enabled and absent, generate via `generateGatewayToken`; if disabled and absent, emit nothing.
- [ ] T008 [US1] Update `scaffoldClusterYaml` (`cluster/scaffolder.ts`) to write `llmGateway: true`
  **only when enabled** (omit key when false so existing cluster.yaml output/tests are unchanged;
  plan §1, research R7).

## Phase 3: Gateway files (config example, config.json, .gitignore, .env.local)

- [ ] T009 [US3] Implement `scaffoldLlmGatewayFiles(dir)` in `cluster/llm-gateway.ts`:
  - `llm-gateway/config.example.json` — content from `contracts/config.example.json`, overwritten
    every scaffold. Inbound virtual key value `env.GENERACY_LLM_GATEWAY_TOKEN`; provider key
    values `env.<PROVIDER>_API_KEY`; no literal secrets. Do NOT set
    `"source_of_truth": "config.json"` (research R4 — crash-loop).
  - `llm-gateway/config.json` — copied from example **only if absent**; never overwritten.
  - `llm-gateway/.gitignore` — contains `config.json`.
- [ ] T010 [US3] In `scaffoldLlmGatewayFiles` (or the enabled command path), scaffold `.env.local`
  create-if-absent, never overwrite, **only when enabled**: commented `OPENROUTER_API_KEY=`,
  `FEATHERLESS_API_KEY=`, `OPENAI_API_KEY=` placeholders with per-provider URL comments and the
  `count_tokens`/`allowed_requests` note (contracts/env-files.md, FR-007). No `.env.local.template`.
- [ ] T011 [US3] Wire `scaffoldLlmGatewayFiles` to be invoked when the gateway is enabled (from
  `scaffoldDockerCompose` or the command scaffolders, per plan §4). Verify the featherless entry
  is a custom OpenAI-compatible provider with base URL `https://api.featherless.ai` (no `/v1`) and
  the `allowed_requests` block. During implementation, confirm Bifrost v2.0.0 accepts a
  `description` on provider-key objects; if not, carry the count_tokens note only on the
  governance virtual key + `.env.local` (plan Risks, research R5).

## Phase 4: CLI flag wiring (launch + deploy)

- [ ] T012 [P] [US1] Add the `--llm-gateway` / `--no-llm-gateway` boolean-pair option to
  `packages/generacy/src/cli/commands/launch/index.ts` and add `llmGateway?: boolean` to
  `LaunchOptions` in `packages/generacy/src/cli/commands/launch/types.ts` (data-model.md CLI options).
- [ ] T013 [US1] Thread the toggle through `packages/generacy/src/cli/commands/launch/scaffolder.ts`:
  call `resolveLlmGatewayToggle({ flag, env, persisted })` (persisted from an existing cluster.yaml
  when discoverable) and pass the resolved boolean into `scaffoldProject`/compose/env/cluster.yaml.
- [ ] T014 [P] [US1] Add the same `--llm-gateway` / `--no-llm-gateway` option and `llmGateway?: boolean`
  to `packages/generacy/src/cli/commands/deploy/index.ts` and `deploy/types.ts`.
- [ ] T015 [US1] Thread the toggle through `packages/generacy/src/cli/commands/deploy/scaffolder.ts`
  via the same resolver into `scaffoldBundle`.

## Phase 5: Tests

- [ ] T016 [P] [US2] Golden disabled-path guard in
  `packages/generacy/src/cli/commands/cluster/__tests__/scaffolder.test.ts`: existing snapshots in
  `__snapshots__/scaffolder.test.ts.snap` must pass **unchanged**, plus an explicit test that
  `llmGateway: undefined` and `llmGateway: false` produce byte-identical compose + `.env` (SC-002).
- [ ] T017 [US1] Enabled-path compose test in the same file: new snapshot of the gateway-enabled
  compose; assert the `llm-gateway` service shape, orchestrator/worker gateway env additions, and
  the `llm-gateway-data` volume (SC-001).
- [ ] T018 [P] [US1] New `packages/generacy/src/cli/commands/cluster/__tests__/llm-gateway.test.ts`:
  resolver precedence table (flag/env/persisted/default); token format `^sk-bf-[0-9a-f]{48}$`;
  generate-once (re-scaffold reuses); disabled re-scaffold preserves an existing token.
- [ ] T019 [US3] In `llm-gateway.test.ts`: `config.json` created from example once and never
  overwritten (mirror `scaffoldClaudeSeed` tests); `.env.local` create-if-absent; nothing emitted
  when disabled (FR-006, FR-007, FR-008).
- [ ] T020 [US1] Toggle pass-through test in
  `packages/generacy/src/cli/commands/launch/__tests__/scaffolder.test.ts`: the resolved toggle
  reaches the compose/env scaffolds.

## Phase 6: Release hygiene + verification

- [ ] T021 [P] Add `.changeset/1202-llm-gateway-scaffolding.md` (repo root): `@generacy-ai/generacy`
  **minor** (new capability). Newly-added file (CI gate greps `--diff-filter=A`). Required — the PR
  lands red without it.
- [ ] T022 Run `pnpm -r build` then package tests (`pnpm --filter @generacy-ai/generacy test`) green
  (SC-005). Rebuild dependency packages before typechecking dependents (CLAUDE.md).
- [ ] T023 SC-003 compose validity: run `docker compose config` on the gateway-enabled emitted
  output and confirm it succeeds; record the result in the PR.
- [ ] T024 [US1] PR checklist: include the emitted-stanza-vs-tetrad-compose diff documenting the two
  recorded deltas (network `cluster-network`; token via `.env` interpolation) — plan Sequencing
  step 2, research R10.
- [ ] T025 SC-004 end-to-end (manual, needs a real provider key): `curl -H 'Authorization: Bearer $TOKEN'
  http://llm-gateway:8080/anthropic/v1/messages` returns a streamed completion from an OpenRouter
  model; record in the PR. Not automatable in CI.

## Dependencies & Execution Order

**Phase ordering (sequential):** Phase 0 (gate) → Phase 1 (types/schema/module) → Phase 2 (compose/env)
→ Phase 3 (gateway files) → Phase 4 (CLI wiring) → Phase 5 (tests) → Phase 6 (hygiene/verification).

- **T001 blocks everything** — the sequencing gate is a hard blocks-on (#1203).
- Phase 1 must land before Phase 2/3/4: emission and CLI wiring depend on the shared types (T002),
  schema (T003), and resolver/token helpers (T004).
- T005–T008 all edit `cluster/scaffolder.ts` → **sequential** (same file), not parallel.
- T009–T011 depend on T004 (module skeleton) and feed T011's wiring into Phase 2's enabled path.
- Phase 4: T012 and T014 are `[P]` (different command dirs); T013 depends on T012, T015 on T014.
- Phase 5 tests depend on the code they cover (Phases 1–4). T016 and T018 are `[P]` (different files);
  T017 shares the file with T016 → sequential after it.
- T021 (changeset) is `[P]` — independent repo-root file, can be written anytime after Phase 1.
- T022–T025 are final: build/tests, then compose validity, PR diff, and manual E2E.

**Parallel opportunities:** T003 ‖ (start of T004); T012 ‖ T014; T016 ‖ T018; T021 anytime.

## Notes

- No `packages/claude-plugin-cockpit/commands/*.md` playbook file is edited by this issue, so no
  playbook re-pin verification task applies.
- Grouping for `/speckit:taskstoissues`: default `per-story` (no `epic-grouping:*` label present).
</content>
</invoke>

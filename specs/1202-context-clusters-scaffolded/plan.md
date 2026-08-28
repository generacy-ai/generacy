# Implementation Plan: Optional llm-gateway (Bifrost) scaffolding

**Feature**: Optional LLM gateway sidecar in scaffolded clusters (CLI scaffolder emits a Bifrost service)
**Branch**: `1202-context-clusters-scaffolded`
**Status**: Complete
**Issue**: generacy-ai/generacy#1202 | **Epic**: generacy-ai/generacy#1197

## Summary

Add an opt-in `llm-gateway` (Bifrost `maximhq/bifrost:v2.0.0`) service to the compose output of
the shared cluster scaffolder (`packages/generacy/src/cli/commands/cluster/scaffolder.ts`), wired
from a `--llm-gateway` flag / `GENERACY_LLM_GATEWAY_ENABLED=true` env toggle on both `launch` and
`deploy`. The toggle persists as `llmGateway: true` in `.generacy/cluster.yaml`. When enabled the
scaffolder also emits: a cluster-local `sk-bf-` token into `.env` (generate-once), a
`llm-gateway/config.example.json` + create-if-absent gitignored `config.json`, and a commented
`.env.local` with provider-key placeholders. When disabled, output is byte-identical to today.

The compose stanza is a **port** of the stanza stabilized on the tetrad-development dev cluster
(`/workspaces/tetrad-development/.devcontainer/generacy/docker-compose.yml`, tetrad-dev#109) —
adapted only for this scaffolder's network name (`cluster-network`) and token source (`.env`
instead of `.env.local`, per clarify Q2). **Sequencing gate**: implementation must not begin until
the P2 dogfood (generacy-ai/generacy#1203) is complete, and the PR must include a diff of the
emitted stanza against the tetrad compose.

## Technical Context

- **Language/runtime**: TypeScript (ESM), Node >= 22
- **Package**: `packages/generacy` (`@generacy-ai/generacy`, main CLI)
- **CLI framework**: Commander (`--llm-gateway` / `--no-llm-gateway` boolean option pair)
- **YAML emission**: `yaml` package `stringify` (already used for compose/cluster.yaml)
- **Token generation**: `node:crypto` `randomBytes(24).toString('hex')` with `sk-bf-` prefix
- **Tests**: Vitest, existing snapshot-based golden tests in
  `src/cli/commands/cluster/__tests__/scaffolder.test.ts` (+ `__snapshots__/`)
- **No new dependencies.**

## Constitution Check

`.specify/memory/constitution.md` does not exist in this repo (`.specify/` contains only
`templates/`). No constitution gates apply. Repo-wide invariants from `CLAUDE.md` that bind this
feature:

- The scaffolder's compose must keep mirroring the cluster-base devcontainer compose for the
  *existing* services — this feature only appends an optional service and must not alter them.
- Changeset required: non-test `packages/generacy/src/` changes → new `.changeset/*.md`
  (`@generacy-ai/generacy`, **minor** — new capability).
- `GENERACY_LLM_GATEWAY_URL` / `GENERACY_LLM_GATEWAY_TOKEN` are the canonical names already
  consumed by `src/config/loader.ts` (gateway-route warning) and
  `src/cli/commands/doctor/checks/llm-gateway.ts` — do not introduce variants.

## Project Structure

Files touched (all under `packages/generacy/src/` unless noted):

```
cli/commands/cluster/scaffolder.ts        # core: input types + emission (M)
cli/commands/cluster/context.ts           # ClusterYamlSchema: llmGateway field (M)
cli/commands/cluster/llm-gateway.ts       # NEW: toggle resolver + gateway file scaffolds + token helper
cli/commands/launch/index.ts              # --llm-gateway/--no-llm-gateway flag (M)
cli/commands/launch/types.ts              # LaunchOptions.llmGateway (M)
cli/commands/launch/scaffolder.ts         # pass toggle through scaffoldProject (M)
cli/commands/deploy/index.ts              # same flag on deploy (M)
cli/commands/deploy/scaffolder.ts         # pass toggle through scaffoldBundle (M)
cli/commands/cluster/__tests__/scaffolder.test.ts        # enabled/disabled/golden tests (M)
cli/commands/cluster/__tests__/llm-gateway.test.ts       # NEW: resolver + file-scaffold tests
cli/commands/launch/__tests__/scaffolder.test.ts         # toggle pass-through (M)
.changeset/1202-llm-gateway-scaffolding.md               # NEW (repo root)
```

Emitted output layout (gateway enabled), all under the scaffold target dir (`.generacy/`):

```
docker-compose.yml        # + llm-gateway service, + llm-gateway-data volume, + service env vars
.env                      # + GENERACY_LLM_GATEWAY_TOKEN=sk-bf-<48 hex> (generate-once)
.env.local                # NEW, create-if-absent: commented provider-key placeholders
llm-gateway/
  config.example.json     # overwritten each scaffold (generated artifact)
  config.json             # created from example if absent; never overwritten
  .gitignore              # ignores config.json
```

## Design

### 1. Toggle resolution and persistence (FR-001, clarify Q1)

`resolveLlmGatewayToggle({ flag, env, persisted })` in the new `cluster/llm-gateway.ts`:

1. Explicit CLI flag (`--llm-gateway` → true, `--no-llm-gateway` → false) wins.
2. Else `GENERACY_LLM_GATEWAY_ENABLED === 'true'` → true.
3. Else the persisted `llmGateway` from an existing `.generacy/cluster.yaml` (when the caller can
   read one).
4. Else false.

Persistence: `ScaffoldClusterYamlInput` gains `llmGateway?: boolean`; `scaffoldClusterYaml` writes
`llmGateway: true` **only when enabled** (omitting the key when false keeps existing cluster.yaml
output unchanged). `ClusterYamlSchema` (context.ts:32) gains
`llmGateway: z.boolean().default(false)` so consumers parse it.

Note: `launch` currently refuses to scaffold over an existing `.generacy/`
(launch/scaffolder.ts:62) and `deploy` scaffolds a fresh temp bundle — the persisted value is read
wherever an existing cluster.yaml is discoverable at the scaffold target (future re-scaffold
paths, tooling). The write side is unconditional so the contract holds as re-scaffold paths
appear.

### 2. Cluster-local token (FR-004, clarify Q2)

`scaffoldEnvFile` gains `llmGateway?: boolean` and token handling:

- Before writing, read an existing `<dir>/.env` (if any) and extract an existing
  `GENERACY_LLM_GATEWAY_TOKEN=` line.
- If a token exists, **always** re-emit it (even on the disabled path — FR-008 says a disabled
  re-scaffold leaves the token untouched).
- If enabled and absent, generate `sk-bf-` + 48 hex chars (`randomBytes(24)`); the `sk-bf-`
  prefix is mandatory (Bifrost 401s unprefixed Bearer tokens).
- If disabled and absent, emit nothing — fresh disabled output stays byte-identical.

The token appears **only** in `.env`. The scaffolded config references it as
`env.GENERACY_LLM_GATEWAY_TOKEN`; compose interpolates `${GENERACY_LLM_GATEWAY_TOKEN}` from
`.generacy/.env` (the compose project dir) into the gateway/orchestrator/worker environments.

### 3. Compose stanza (FR-002, FR-003)

`ScaffoldComposeInput` gains `llmGateway?: boolean`. When true, `scaffoldDockerCompose`:

- Adds the `llm-gateway` service — exact shape in `contracts/llm-gateway-compose.yml`. Ported
  from tetrad with two recorded deltas: network `cluster-network` (tetrad: `generacy-network`)
  and `GENERACY_LLM_GATEWAY_TOKEN=${GENERACY_LLM_GATEWAY_TOKEN}` in the service `environment`
  (tetrad sources it from `.env.local`; clarify Q2 chose `.env` interpolation). Keeps
  `env_file: [{ path: .env.local, required: false }]` for provider keys, the
  `llm-gateway-data:/app/data` named volume (Bifrost needs a writable APP_DIR),
  `./llm-gateway/config.json:/app/data/config.json:ro`, the wget healthcheck
  (45s start_period), `restart: unless-stopped`, no ports.
- Appends to orchestrator **and** worker `environment`:
  `GENERACY_LLM_GATEWAY_URL=http://llm-gateway:8080/anthropic` and
  `GENERACY_LLM_GATEWAY_TOKEN=${GENERACY_LLM_GATEWAY_TOKEN}`.
- Adds `llm-gateway-data: null` to the top-level `volumes` map.

When false: zero changes to the compose object (byte-identical output, golden-tested).

### 4. Gateway files (FR-005–FR-007, clarify Q3)

`scaffoldLlmGatewayFiles(dir)` (new, called from `scaffoldDockerCompose` or the command
scaffolders when enabled):

- `llm-gateway/config.example.json` — content in `contracts/config.example.json`; ported from the
  tetrad config (OpenRouter, OpenAI, featherless as custom OpenAI-compatible with base URL
  `https://api.featherless.ai` — no `/v1` — and `allowed_requests`). Inbound virtual key value is
  `env.GENERACY_LLM_GATEWAY_TOKEN`; provider key values are `env.<PROVIDER>_API_KEY`. No literal
  secrets ever. The `count_tokens`/`allowed_requests` note lives in the virtual-key/provider
  `description` fields (JSON has no comments; see research.md) and in `.env.local` comments.
  Overwritten on each scaffold (it is a generated artifact).
- `llm-gateway/config.json` — copied from the example **only if absent**; never overwritten.
- `llm-gateway/.gitignore` — contains `config.json`.
- `.env.local` — create-if-absent, never overwritten, only when enabled: commented
  `OPENROUTER_API_KEY=` / `FEATHERLESS_API_KEY=` / `OPENAI_API_KEY=` placeholders with
  per-provider URL comments and the count_tokens note. No `.env.local.template`.

### 5. Disabled path on a previously-enabled cluster (FR-008, clarify Q5)

Disabled scaffold performs no deletion: `llm-gateway/`, `.env.local`, and the `.env` token line
are left as-is (token via the preserve-existing rule in §2; files simply aren't touched). Only
the compose stanza and service env vars disappear from the regenerated compose.

## Testing Strategy (SC-001, SC-002)

- **Golden disabled path**: existing snapshot tests in
  `cluster/__tests__/scaffolder.test.ts` + `__snapshots__/scaffolder.test.ts.snap` must pass
  **unchanged** — that is the byte-identical guard. Add an explicit test that
  `llmGateway: undefined` and `llmGateway: false` produce identical bytes.
- **Enabled path**: new snapshot of the gateway-enabled compose; assertions for the service
  shape, orchestrator/worker env additions, and `llm-gateway-data` volume.
- **Token**: format `^sk-bf-[0-9a-f]{48}$`; generate-once (re-scaffold reuses); disabled
  re-scaffold preserves an existing token.
- **Files**: config.json created from example once, never overwritten (mirror the
  `scaffoldClaudeSeed` tests); `.env.local` create-if-absent; nothing emitted when disabled.
- **Resolver**: flag/env/persisted precedence table.
- **Compose validity** (SC-003): `docker compose config` on gateway-enabled output — CI or
  recorded manually in the PR.
- **E2E** (SC-004): manual curl through the gateway recorded in the PR (needs a real provider
  key; not automatable in CI).

## Sequencing / PR checklist

1. **Do not start implementation until generacy-ai/generacy#1203 (P2 dogfood) is complete.**
2. PR body must include the emitted-stanza vs tetrad-compose diff (the two recorded deltas).
3. Changeset: `@generacy-ai/generacy` **minor**.
4. `pnpm -r build` + package tests green (SC-005).

## Risks

- **Snapshot drift**: any accidental reordering of compose keys breaks byte-identity — keep all
  gateway emission strictly behind the boolean.
- **Bifrost config schema movement**: v2.0.0 is pinned deliberately (schema moves between
  majors); the example config must match v2.0.0 exactly as verified in the P2. Do not set
  `source_of_truth: "config.json"` (crash-loops when the token env ref is unresolved).
- **`description` fields in provider key entries**: if Bifrost v2.0.0 rejects a `description`
  on provider key objects, fall back to carrying the count_tokens note only on the governance
  virtual key (schema-supported) and in `.env.local` — verify during implementation.

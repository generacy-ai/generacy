# Research: Optional llm-gateway (Bifrost) scaffolding

## R1: Gateway engine — Bifrost `maximhq/bifrost:v2.0.0` (decided upstream)

**Decision**: Port the Bifrost sidecar exactly as stabilized on the tetrad-development dev
cluster (tetrad-dev#109, `/workspaces/tetrad-development/.devcontainer/generacy/docker-compose.yml`
lines 180–218). This feature *ports*, it does not *design* — engine selection, ingress path, and
image pin were settled by the epic design doc
(`docs/llm-gateway-model-routing-plan.md` in tetrad-development) and verified in the P2 dogfood.

**Pin rationale** (clarify Q4): the tetrad compose already pins `v2.0.0` concretely
("Pinned deliberately; bump after re-checking the config schema, which moves between majors —
v2.0.0 added `source_of_truth` / `governance.auth_config`"). All P2 findings were verified
against v2.0.0. The moving-tag branch of clarify Q4 never triggers.

**Alternatives considered**: LiteLLM and hand-rolled proxies were weighed in the epic design doc,
not here. Out of scope for this port.

## R2: Token delivery — env-ref in config, interpolation from `.env` (clarify Q2)

**Decision**: `config.json` never contains the literal token. The governance virtual key uses
Bifrost's env-reference syntax (`"value": "env.GENERACY_LLM_GATEWAY_TOKEN"`), and the compose
service passes `GENERACY_LLM_GATEWAY_TOKEN=${GENERACY_LLM_GATEWAY_TOKEN}` — docker compose
interpolates `${VAR}` from the `.env` file next to the compose file (`.generacy/.env`), which is
exactly where `scaffoldEnvFile` writes the generated token.

**Why not literal substitution** (rejected option A): breaks token rotation — `config.json` is
create-once/never-overwrite, so a rotated token would strand a stale literal in a file the
scaffolder must not touch.

**Delta from tetrad**: tetrad sources the token from `.env.local` (operator-authored). Our
scaffolder *generates* the token, and generated values belong in the scaffolder-owned `.env`;
`.env.local` remains purely operator-owned secrets (provider keys). Recorded as a deliberate
stanza delta for the PR diff.

**Hard constraint**: the token **must** be `sk-bf-`-prefixed. Bifrost only accepts a virtual key
on the `Authorization: Bearer` header when it starts with `sk-bf-`; Claude Code never sends the
`x-bf-vk` header. An unprefixed token 401s every call. Generation:
`'sk-bf-' + randomBytes(24).toString('hex')` (48 hex chars, matching the P2 recipe
`sk-bf-$(openssl rand -hex 24)`).

## R3: APP_DIR must be a named volume, not a bind

From the tetrad stanza: Bifrost refuses to start without a writable `APP_DIR`
(`/app/data`: `config.db`, `logs.db`). A named volume inherits the image's `1000:0` ownership; a
host bind would not (the process runs as 1000:0). Hence `llm-gateway-data:/app/data` plus the
read-only bind of only `config.json` into `/app/data/config.json`.

## R4: Config reconciliation gotchas (v2.0.0)

- Bifrost merges `config.json` into `config.db` on every boot → edit-and-restart adds providers
  or rotates the token. **Removals do not propagate** (default "split" reconciliation);
  `docker compose rm -sfv llm-gateway` resets the volume.
- **Do not set `"source_of_truth": "config.json"`** to make removals stick: v2.0.0 fatals in a
  crash-loop ("failed to prune governance config … FOREIGN KEY constraint failed") whenever the
  virtual key's env ref is unresolved — i.e. on any cluster that has not set the token yet.
  These land as comments in the emitted stanza and quickstart, not as config.

## R5: `count_tokens` on non-Anthropic upstreams

`/v1/messages/count_tokens` is Anthropic-specific; Bifrost 500s (or 400s: "count_tokens is not
supported by <provider> provider") on non-Anthropic upstreams and Claude Code falls back to
client-side context counting. The featherless `custom_provider_config.allowed_requests` block
(`list_models: false, chat_completion: true, chat_completion_stream: true`) is the schema
mechanism that scopes what a custom provider accepts. FR-005 wants this *explained* in the
example config — but JSON has no comments, so the note is carried in `description` fields
(governance virtual key supports one in the tetrad-verified config; provider-key `description`
needs a v2.0.0 schema check at implementation time) and duplicated in the `.env.local` comment
block and quickstart.

## R6: `.env.local` scaffolded directly, no template (clarify Q3)

The current scaffolder never emits `.env.local` or a template (it appears only as an optional
`required: false` env_file). The P2 rejected the copy-a-template pattern. Since the gateway fails
closed with no keys (a provider with an absent key is skipped at boot; calls to it 400 with
"no valid keys found for provider"), a placeholder-only `.env.local` is harmless. Scaffold it
directly — create-if-absent, never overwrite, **only when the gateway is enabled** — preserving
US2's byte-identical disabled path. Content mirrors the gateway section of tetrad's
`.env.local.template` (provider-key URLs, per-provider model addressing notes, OpenAI
API-key-billing-only caveat).

## R7: Toggle persistence in cluster.yaml (clarify Q1)

`scaffoldDockerCompose` rewrites `docker-compose.yml` unconditionally, so a per-invocation-only
flag would silently drop a running gateway's stanza on the next `launch`/`deploy` re-run.
`.generacy/cluster.yaml` is already the durable per-project scaffold config (channel / workers /
variant, parsed by `ClusterYamlSchema` in `cluster/context.ts`). Persist `llmGateway: true` there;
later scaffolds default from it; disabling requires explicit `--no-llm-gateway` (Commander's
boolean-pair negation) or editing cluster.yaml. The key is *omitted* when false so existing
cluster.yaml files and their tests are untouched. (`generacy update` does not re-scaffold compose
— it only reconciles `WORKER_COUNT` — so launch/deploy re-runs are the affected paths.)

## R8: Disabled-path behavior on previously-enabled clusters (clarify Q5)

Leave everything untouched: leftover `llm-gateway/` files are inert without the compose stanza,
`.env.local` is already an optional `required: false` env_file on orchestrator/worker,
`config.json` may be hand-edited, and keeping the `.env` token means re-enabling reuses it
(FR-004 generate-once). The scaffolder never deletes user files or `.env` values.

## R9: Existing consumers of the canonical env vars

- `src/config/loader.ts:423-443` — warns when a model resolves to the gateway route while
  `GENERACY_LLM_GATEWAY_URL` is unset.
- `src/cli/commands/doctor/checks/llm-gateway.ts` — doctor check: skips when URL unset, degrades
  when URL set but token missing, probes reachability otherwise.
- `packages/generacy-plugin-claude-code/src/launch/route.ts` — spawn-time routing (other epic
  children).

These confirm `GENERACY_LLM_GATEWAY_URL=http://llm-gateway:8080/anthropic` and
`GENERACY_LLM_GATEWAY_TOKEN` as the canonical names/shape the compose must emit (FR-003), and
that a disabled cluster (URL unset) is a first-class state everywhere downstream.

## R10: Stanza deltas vs tetrad (for the PR diff)

| Aspect | tetrad-dev#109 | scaffolder port | Why |
|---|---|---|---|
| Network | `generacy-network` | `cluster-network` | Scaffolder's existing network name |
| Token source | `.env.local` (operator-authored) | `environment: GENERACY_LLM_GATEWAY_TOKEN=${…}` interpolated from `.env` | Scaffolder generates the token (R2) |
| `GENERACY_LLM_GATEWAY_URL` placement | committed `.env` (via env_file) | orchestrator/worker `environment` entries | FR-003; scaffolder's `.env` is regenerated, service env is the scaffolder's pattern for fixed wiring |
| Everything else (image pin, APP_DIR volume, config bind-mount, env_file `.env.local` required:false, healthcheck, restart, no ports) | — | identical | Port |

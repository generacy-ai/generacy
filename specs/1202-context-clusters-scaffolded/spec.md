# Feature Specification: Optional llm-gateway (Bifrost) scaffolding

**Branch**: `1202-context-clusters-scaffolded` | **Date**: 2026-08-28 | **Status**: Draft
**Issue**: generacy-ai/generacy#1202 | **Epic**: generacy-ai/generacy#1197 (LLM gateway model routing)

## Summary

Add an **optional** LLM gateway sidecar to scaffolded clusters. When enabled, the CLI
scaffolder (`packages/generacy/src/cli/commands/cluster/scaffolder.ts`) emits a Bifrost
(`maximhq/bifrost`, Apache-2.0) service alongside the existing orchestrator / worker / redis
stack. Bifrost exposes an Anthropic Messages ingress at `/anthropic` and translates Claude
Code's requests to OpenRouter / featherless.ai / OpenAI / custom OpenAI-compatible upstreams,
letting a cluster route agent traffic to non-Anthropic models.

MVP scope: the developer hand-authors the Bifrost config; provider API keys come from
`.env.local`. The scaffolder wires the service, a cluster-local auth token, example config,
and env plumbing — it does **not** author provider routing logic.

The compose stanza is a **port** of the one stabilized on the tetrad-development dev cluster
(generacy-ai/tetrad-development#109). Sequencing: do not begin implementation until the P2
dogfood (generacy-ai/generacy#1203) is complete; the PR must diff the emitted stanza against
the tetrad compose.

## User Stories

### US1: Enable the gateway when scaffolding a cluster

**As a** developer scaffolding a local or BYO-VM cluster,
**I want** to opt into an LLM gateway sidecar via a single CLI flag or env var,
**So that** my cluster's agents can route to OpenRouter / featherless / OpenAI models
without me hand-editing the generated `docker-compose.yml`.

**Acceptance Criteria**:
- [ ] `generacy launch`/`deploy` accepts `--llm-gateway`; `GENERACY_LLM_GATEWAY_ENABLED=true`
  is an equivalent toggle.
- [ ] With the toggle on, the emitted compose contains an `llm-gateway` service and the
  orchestrator + worker services receive `GENERACY_LLM_GATEWAY_URL` and
  `GENERACY_LLM_GATEWAY_TOKEN`.
- [ ] The gateway is reachable only on the cluster network (no host port by default).

### US2: No change when the gateway is off

**As a** developer who does not want the gateway,
**I want** the scaffolder's output to be exactly what it is today when the flag is absent,
**So that** existing clusters and golden-file expectations are unaffected.

**Acceptance Criteria**:
- [ ] With `llmGateway` false/unset, the emitted `docker-compose.yml` and `.env` are
  **byte-identical** to the current output (golden test).
- [ ] No `llm-gateway/` directory, `.env.local.template` provider keys, or gateway env vars
  are emitted.

### US3: Configure providers from a scaffolded example

**As a** developer bringing my own provider keys,
**I want** a ready-to-edit example Bifrost config and commented `.env.local` placeholders,
**So that** I can drop in an OpenRouter/featherless/OpenAI key and start routing quickly.

**Acceptance Criteria**:
- [ ] `llm-gateway/config.example.json` is scaffolded with OpenRouter, featherless (custom
  OpenAI-compatible provider, base URL without `/v1`), and OpenAI entries, plus a comment on
  `count_tokens` (`allowed_requests`) for non-Anthropic upstreams.
- [ ] `llm-gateway/config.json` is created from the example when absent and is gitignored;
  an existing `config.json` is never overwritten.
- [ ] `.env.local.template` gains commented `OPENROUTER_API_KEY`, `FEATHERLESS_API_KEY`, and
  `OPENAI_API_KEY` placeholders.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add `llmGateway?: boolean` to `ScaffoldComposeInput` (and the env-scaffolding input as needed); wire the `--llm-gateway` CLI flag and `GENERACY_LLM_GATEWAY_ENABLED=true` env toggle to it in both `launch` and `deploy`. | P1 | Shared scaffolder is used by both commands. |
| FR-002 | When enabled, emit an `llm-gateway` compose service: pinned `maximhq/bifrost:<tag>` image, `./llm-gateway/config.json` bind-mounted, `env_file: .env.local`, `cluster-network` only (no host port), healthcheck, `restart: unless-stopped`. | P1 | Port of tetrad-dev#109; diff in PR. Pin an explicit tag, not `latest`. |
| FR-003 | Orchestrator + worker services get `GENERACY_LLM_GATEWAY_URL=http://llm-gateway:8080/anthropic` and `GENERACY_LLM_GATEWAY_TOKEN=${GENERACY_LLM_GATEWAY_TOKEN}`. | P1 | Matches env vars already consumed by config loader (loader.ts) and doctor check (#1200). |
| FR-004 | `scaffoldEnvFile` generates a random cluster-local `GENERACY_LLM_GATEWAY_TOKEN` **once** and never overwrites an existing value; the same token is set as Bifrost's inbound auth key in the scaffolded config. | P1 | Mirror the never-overwrite discipline of `scaffoldClaudeSeed`. |
| FR-005 | Scaffold `llm-gateway/config.example.json` with OpenRouter, featherless (custom OpenAI-compatible, base URL without `/v1`), and OpenAI entries and the `count_tokens`/`allowed_requests` comment. | P1 | Provider keys referenced by name from the config; values live in `.env.local`. |
| FR-006 | Create `llm-gateway/config.json` from the example if absent; gitignore it; never overwrite an existing one. | P1 | |
| FR-007 | `.env.local.template` gains the three commented provider-key placeholders. | P1 | |
| FR-008 | When `llmGateway` is false/unset, emitted compose and `.env` are byte-identical to today. | P1 | Golden test guards this. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Scaffolder covers both branches | Tests for enabled and disabled paths pass | Vitest unit tests in the generacy package |
| SC-002 | Disabled-path stability | Byte-identical compose + `.env` | Golden-file assertion |
| SC-003 | Compose validity | `docker compose config` succeeds on gateway-enabled output | CI / manual |
| SC-004 | End-to-end routing | `curl -H 'Authorization: Bearer $TOKEN' http://llm-gateway:8080/anthropic/v1/messages` returns a streamed completion from an OpenRouter model | Manual verification recorded in PR |
| SC-005 | Build + release hygiene | `pnpm -r build` + tests green; changeset present | CI |

## Assumptions

- The Bifrost image tag and the exact compose stanza are inherited from the stabilized
  tetrad-development dev-cluster compose (tetrad-dev#109); this feature ports rather than
  designs them.
- `GENERACY_LLM_GATEWAY_URL` / `GENERACY_LLM_GATEWAY_TOKEN` are the canonical env var names,
  already consumed elsewhere in the epic (config loader warnings, doctor `llm-gateway` check).
- Bifrost listens on port 8080 inside the cluster network and serves the Anthropic ingress at
  `/anthropic` (Messages endpoint at `/anthropic/v1/messages`).
- `.env.local` is the developer-supplied, gitignored secrets file; `.env.local.template` is
  the committed placeholder scaffold.

## Out of Scope

- Authoring or auto-generating provider routing logic in the Bifrost config (developer
  hand-authors config for the MVP).
- Managing/pulling provider API keys through the cluster credentials subsystem — keys come
  from `.env.local`.
- Exposing the gateway on a host port or through the cluster-relay.
- Cloud-side/orchestrator changes to consume the gateway at spawn time (covered by other
  epic children).
- Changing the default so the gateway is on; it remains opt-in.

## Dependencies

- **Blocks-on**: generacy-ai/generacy#1203 (P2 dogfood) must be complete before implementation.
- **Source stanza**: generacy-ai/tetrad-development#109 (stabilized dev-cluster compose).
- **Design**: `docs/llm-gateway-model-routing-plan.md` (generacy-ai/tetrad-development); condensed
  summary in epic #1197 body.

---

*Generated by speckit*

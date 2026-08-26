# Feature Specification: Model-name route resolution + CLAUDE_CONFIG_DIR gateway env in every launch builder

**Feature Branch**: `1198-context-claude-code-validates`
**Created**: 2026-08-26
**Status**: Draft
**Input**: generacy-ai/generacy#1198 — [claude-code-plugin] Model-name route resolution + CLAUDE_CONFIG_DIR gateway env in every launch builder

## Context

Claude Code validates model ids when talking to `api.anthropic.com`, but passes any model string through when `ANTHROPIC_BASE_URL` points at a gateway. To run non-Anthropic models (OpenRouter, OpenAI, featherless, custom OpenAI-compatible), we launch the CLI with a **second Claude config directory** (`CLAUDE_CONFIG_DIR=/home/node/.claude-gateway`) whose `settings.json` sets `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`. The engine must select the config directory **per launch, driven by the model name**.

This is P1 of the LLM gateway model routing epic (generacy-ai/generacy#1197). It ships the route-resolution primitive and wires the gateway `CLAUDE_CONFIG_DIR` env into every model-bearing launch builder in `@generacy-ai/generacy-plugin-claude-code`. No gateway sidecar, no session invalidation (that is #1199), and **no change to the `.generacy/config.yaml` agents schema** — `AgentEntrySchema.model` is already free-form (`packages/config/src/template-schema.ts:22-28`).

Full design: `docs/llm-gateway-model-routing-plan.md` in generacy-ai/tetrad-development; condensed summary in the epic body.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Gateway model routes to the gateway config dir (Priority: P1)

A developer configures a workflow phase to use a gateway-shaped model (e.g. `openrouter/qwen/qwen3.5-coder`). When the engine launches Claude Code for that phase, the launch must carry `CLAUDE_CONFIG_DIR=/home/node/.claude-gateway` so the CLI talks to the gateway base URL instead of `api.anthropic.com`.

**Why this priority**: This is the core capability — without it, gateway models cannot be run at all. It is the primitive every later epic phase builds on.

**Independent Test**: Call any model-bearing builder with a `/`-containing model; assert the returned `LaunchSpec.env` contains `CLAUDE_CONFIG_DIR` set to the gateway dir and `route === 'gateway'`.

**Acceptance Scenarios**:

1. **Given** a model string containing `/` (`openrouter/x/y`, `openai/gpt-5.5`), **When** `resolveRoute(model)` is called, **Then** it returns `'gateway'`.
2. **Given** a gateway-routed intent and a gateway config dir containing `settings.json`, **When** the builder produces a `LaunchSpec`, **Then** `env.CLAUDE_CONFIG_DIR` equals the configured gateway dir and `route === 'gateway'`.
3. **Given** a gateway route env, **When** `AgentLauncher` merges `launchSpec.env`, **Then** the spawned CLI process sees `CLAUDE_CONFIG_DIR` (existing merge at `agent-launcher.ts:106-114`).

---

### User Story 2 - Subscription models stay byte-identical (Priority: P1)

A cluster running only Anthropic subscription models (`claude-*`, aliases, `undefined`) must be completely unaffected. Launches for these models must produce exactly the same `LaunchSpec` as before this change — no `env`, no behavior difference.

**Why this priority**: Rollout is flag-free by construction. Any regression to the subscription path breaks every existing cluster, so byte-for-byte fidelity is a hard requirement.

**Independent Test**: Call each builder with an Anthropic model and with `undefined`; deep-equal the produced `LaunchSpec` against the pre-change output (no `env`, no `route: 'gateway'`).

**Acceptance Scenarios**:

1. **Given** a model that is an Anthropic id/alias (never contains `/`) or `undefined`, **When** `resolveRoute(model)` is called, **Then** it returns `'subscription'`.
2. **Given** a subscription-routed intent, **When** the builder produces a `LaunchSpec`, **Then** the result is deep-equal to the pre-change output (no `CLAUDE_CONFIG_DIR` env).

---

### User Story 3 - Fail fast when the gateway dir is not provisioned (Priority: P2)

An operator sets a gateway-shaped model on a cluster where the gateway config dir has not been provisioned (no `settings.json`). Instead of the CLI silently 400ing against `api.anthropic.com`, the launch must fail immediately with a typed, actionable error.

**Why this priority**: Turns a confusing downstream 400 into a clear, diagnosable failure at launch construction. Important for operability but not required for the happy path.

**Independent Test**: Call a builder with a gateway model while `<gatewayConfigDir>/settings.json` is absent; assert a `GatewayRouteUnavailableError` is thrown naming the model, the dir, and `GENERACY_LLM_GATEWAY_URL`.

**Acceptance Scenarios**:

1. **Given** a gateway route and a missing `<gatewayConfigDir>/settings.json`, **When** a builder runs, **Then** it throws `GatewayRouteUnavailableError` whose message names the model, the gateway dir, and `GENERACY_LLM_GATEWAY_URL`.
2. **Given** the check has run once for a process, **When** it runs again, **Then** the result is served from a per-process cache.
3. **Given** the check previously found the dir missing (ENOENT) and the file later appears, **When** the check runs again, **Then** the cache is invalidated and the now-present `settings.json` is honored.

### Edge Cases

- Model with a `[1m]` context-window suffix (e.g. `claude-sonnet-4-5[1m]`) — has no `/`, routes `subscription`.
- Model with multiple `/` segments (`openrouter/qwen/qwen3.5-coder`) — routes `gateway`.
- `undefined` model — routes `subscription` (CLI default).
- Gateway dir configured via `GENERACY_CLAUDE_GATEWAY_CONFIG_DIR` env overriding the default `/home/node/.claude-gateway`.
- `buildInvokeLaunch` carries no model and is out of scope for env injection (not a model-bearing builder).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `@generacy-ai/generacy-plugin-claude-code` MUST export `resolveRoute(model?: string): 'subscription' | 'gateway'`, returning `'gateway'` iff `model` contains `/`, and `'subscription'` for everything else including `undefined`.
- **FR-002**: `ClaudeCodeLaunchPlugin` MUST accept a `gatewayConfigDir` option, defaulting to `/home/node/.claude-gateway`, overridable via the `GENERACY_CLAUDE_GATEWAY_CONFIG_DIR` environment variable.
- **FR-003**: Every model-bearing builder — `buildPhaseLaunch`, `buildPrFeedbackLaunch`, `buildMergeConflictLaunch`, `buildReviewLaunch`, `buildRemediateLaunch`, `buildConversationTurnLaunch` — MUST return `env: { CLAUDE_CONFIG_DIR: <gatewayConfigDir> }` when the resolved route is `gateway`.
- **FR-004**: Subscription-routed builders MUST return no `env` for the gateway config dir; their `LaunchSpec` MUST be byte-identical to the pre-change output.
- **FR-005**: When the route is `gateway` and `<gatewayConfigDir>/settings.json` does not exist, the builder MUST throw a typed `GatewayRouteUnavailableError` whose message names the model, the gateway dir, and `GENERACY_LLM_GATEWAY_URL`.
- **FR-006**: The `settings.json` existence check MUST be cached per process, with cache invalidation on the ENOENT→exists transition.
- **FR-007**: `LaunchSpec` MUST gain an informational `route` field for logging and tests.
- **FR-008**: The `.generacy/config.yaml` agents schema MUST NOT change; `AgentEntrySchema.model` stays free-form.

### Key Entities

- **Route**: `'subscription' | 'gateway'` — derived purely from the model string; determines whether the gateway config dir env is injected.
- **LaunchSpec**: the structural launch descriptor (`command`, `args`, `env?`, `stdioProfile?`) gaining an informational `route` field.
- **GatewayRouteUnavailableError**: typed error surfaced when a gateway route is requested but the gateway config dir is not provisioned.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `resolveRoute` returns the correct route for the full table: aliases, `claude-*`, `[1m]` suffix, `openrouter/x/y`, `openai/gpt-5.5`, and `undefined`.
- **SC-002**: For every model-bearing builder, a gateway model yields `env.CLAUDE_CONFIG_DIR === <gatewayConfigDir>` and `route === 'gateway'`; a subscription model yields no such env and a `LaunchSpec` deep-equal to the pre-change output.
- **SC-003**: A gateway model with no `settings.json` present throws `GatewayRouteUnavailableError` naming the model, dir, and `GENERACY_LLM_GATEWAY_URL`.
- **SC-004**: With no gateway configured and an Anthropic model, the produced `LaunchSpec` is deep-equal to the pre-change output.
- **SC-005**: `pnpm -r build` and the test suite pass green.

## Assumptions

- Bifrost/LiteLLM `provider/model` naming (containing `/`) is the sole, sufficient discriminator for gateway routing; Anthropic ids and aliases never contain `/`.
- The gateway config dir's `settings.json` is provisioned out-of-band (manual in MVP; wizard/credhelper in later epic phases). This feature only checks for its presence.
- `AgentLauncher`'s existing env merge (`agent-launcher.ts:106-114`) is the delivery mechanism for `launchSpec.env`; no launcher change is required.

## Out of Scope

- The gateway sidecar (Bifrost/LiteLLM) compose service and its provisioning (epic phases P2/P3).
- Route-aware session invalidation and transition logging (generacy-ai/generacy#1199).
- `generacy validate` / `generacy doctor` gateway checks (generacy-ai/generacy#1200).
- `buildInvokeLaunch` (carries no model) and the local workflow-engine path.
- Cockpit subagent cross-route handling and wizard-configured providers (P4).

---
Part of epic generacy-ai/generacy#1197 (LLM gateway model routing).

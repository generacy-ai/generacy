# Research: Model-name route resolution + gateway CLAUDE_CONFIG_DIR env

**Feature**: #1198 · **Branch**: `1198-context-claude-code-validates`

## Decision 1 — Route discriminator: `/` in the model string

**Decision**: `resolveRoute(model?)` returns `'gateway'` iff `model` contains `/`; everything else (including `undefined`) is `'subscription'`.

**Rationale**: Bifrost/LiteLLM use `provider/model` naming (`openrouter/qwen/qwen3.5-coder`, `openai/gpt-5.5`). Anthropic model ids and aliases never contain `/` — `claude-opus-4-7`, `opus`, `claude-sonnet-4-5[1m]` are all slash-free by construction, so the discriminator needs no allowlist or regex table. Spec Assumption §103 makes this the load-bearing invariant.

**Alternatives considered**:
- *Explicit provider allowlist* (`openrouter/`, `openai/`, ...): rejected — every new gateway provider would need a code change; the epic explicitly supports "custom OpenAI-compatible" endpoints whose prefixes are unknowable.
- *Config-schema route field* on `AgentEntrySchema`: rejected by FR-008 — `model` stays free-form; routing must be derivable, not declared.

## Decision 2 — Delivery mechanism: existing `AgentLauncher` env merge

**Decision**: The plugin returns `env: { CLAUDE_CONFIG_DIR: <dir> }` on the `LaunchSpec`; no orchestrator change.

**Rationale**: `agent-launcher.ts:106-114` already merges `{ ...process.env, ...launchSpec.env, ...request.env }` into the spawned process. Verified during planning: the merge exists and `launchSpec.env` is a first-class layer. The plugin-local `LaunchSpec` interface (`claude-code-launch-plugin.ts:18-23`) already declares `env?: Record<string, string>` — the field is dormant, not new.

**Alternatives considered**:
- *Launcher-side route resolution*: rejected — the orchestrator would need to import route logic from the plugin (or duplicate it), inverting the plugin boundary. The plugin owns everything Claude-Code-specific.
- *Wrapper script that exports the env*: rejected — more moving parts, harder to test, and the env merge already does exactly this.

## Decision 3 — `route` field: gateway-only, plugin-local (Clarification Q1=A)

**Decision**: Local `LaunchSpec` gains `route?: 'gateway'`. Subscription and invoke launches omit the field entirely; the subscription branch of `applyRoute` returns the builder's base object **as-is** (no spread).

**Rationale**: FR-004/SC-002/SC-004 require strict deep-equal to pre-change output for subscription launches. Stamping `route: 'subscription'` would break `toEqual`. Typing the field as `'gateway'` (not the full `Route` union) makes stamping it on subscription launches a compile error. Width subtyping keeps the plugin structurally assignable to the orchestrator's `AgentLaunchPlugin` at the registration seam — the orchestrator's own `LaunchSpec` is untouched, and consumers needing route comparison (#1199) call `resolveRoute(model)` directly.

**Alternatives considered**:
- *Always-present `route` field* (Q1 option B): rejected in clarification — would redefine byte-identity as "identical except route", weakening the strongest rollout guarantee.
- *Modify orchestrator `LaunchSpec`*: rejected — unnecessary (structural typing) and expands blast radius outside the plugin package.

## Decision 4 — Provision check: positive-only process cache (Clarification Q3=A)

**Decision**: `assertGatewayProvisioned` keeps a module-level `Set<string>` of dir paths whose `settings.json` has been seen. Hit → return. Miss → `existsSync(join(dir, 'settings.json'))`; present → cache + return; absent → throw `GatewayRouteUnavailableError`.

**Rationale**: US3 scenarios 2 and 3 conflict unless the negative result is never cached: a cached "missing" would persist the error forever after the operator provisions the file. Positive-only caching satisfies both with zero invalidation machinery; the cold path costs one `stat` per gateway launch on a cluster that is already broken. This mirrors the existing `effortMechanismCache` pattern (`claude-code-launch-plugin.ts:38`) including its test escape hatch (`_setHasEffortMechanismForTests` → `_resetGatewayProvisionCacheForTests`).

**Alternatives considered**:
- *TTL or `fs.watch` invalidation* (Q3 option B): rejected in clarification — machinery for a case (repeated gateway launches on an unprovisioned cluster) that is already an operator error.
- *No cache at all*: viable but wasteful — one `stat` per launch forever on healthy clusters; the precedent cache pattern is already established in this file.

## Decision 5 — Error class: standalone `Error` subclass, not `PluginError`

**Decision**: `GatewayRouteUnavailableError extends Error` with fields `model`, `gatewayConfigDir` and `name = 'GatewayRouteUnavailableError'`. Message names the model, the dir, and `GENERACY_LLM_GATEWAY_URL`.

**Rationale**: `PluginError` (`src/errors.ts`) requires an `ErrorCode` from a session/container-oriented enum (`SESSION_NOT_FOUND`, `CONTAINER_START_FAILED`, ...). This is a launch-construction error surfaced synchronously through `buildLaunch` — none of the codes fit, and adding a code would widen a stable enum for one consumer. A typed standalone error with structured fields gives callers (`instanceof` / `err.name`) everything they need.

**Alternatives considered**:
- *Extend `PluginError` with a new `ErrorCode`*: rejected — enum churn, and the error never flows through the session/invocation machinery that consumes those codes.
- *Plain `throw new Error(...)`*: rejected — US3 requires a **typed** error; #1200 (doctor checks) will want to catch it specifically.

## Decision 6 — Constructor options object (compat with ~15 no-arg call sites)

**Decision**: `constructor(options?: ClaudeCodeLaunchPluginOptions)` with `gatewayConfigDir?: string`; resolved once in the constructor via `resolveGatewayConfigDir` (explicit > env > default, Q2=A).

**Rationale**: `grep 'new ClaudeCodeLaunchPlugin'` finds ~15 call sites (production: `launcher-setup.ts:25`; the rest orchestrator tests), all no-arg. An optional options object keeps every one compiling and behaving unchanged, and leaves room for future options without another signature change. Resolving precedence once in the constructor (not per-launch) makes the dir stable for the plugin's lifetime and trivially testable.

**Alternatives considered**:
- *Positional optional string param*: works today but dead-ends the signature; options object is the established pattern (`ClaudeCodePluginOptions` exists for the sibling class).
- *Per-launch env read*: rejected — precedence resolution per launch invites test flakiness (env mutation mid-suite) and buys nothing; Q2=A fixes the order deterministically.

## Implementation patterns followed

- **Module-level cache + test reset**: `effortMechanismCache` / `_setHasEffortMechanismForTests` in `claude-code-launch-plugin.ts`.
- **Plugin-local structural mirrors**: `LaunchSpec` / `OutputParser` interfaces defined locally to avoid the orchestrator↔plugin build cycle; `route?` extends this pattern additively.
- **Zero new dependencies**: `node:fs` (`existsSync`) + `node:path` (`join`) only.
- **Changeset gate**: new public capability → `minor` bump on `@generacy-ai/generacy-plugin-claude-code`, newly-added file `.changeset/1198-gateway-route-resolution.md` (per CLAUDE.md rules).

## Sources

- `specs/1198-context-claude-code-validates/spec.md` + `clarifications.md` (Q1–Q4, all option A)
- `docs/llm-gateway-model-routing-plan.md` (generacy-ai/tetrad-development) — epic design, condensed in generacy-ai/generacy#1197
- `packages/orchestrator/src/launcher/agent-launcher.ts:106-114` — env merge verification
- `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts` — builder shapes, cache precedent

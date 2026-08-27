# Implementation Plan: Model-name route resolution + CLAUDE_CONFIG_DIR gateway env in every launch builder

**Feature**: Route resolution primitive (`resolveRoute`) + gateway `CLAUDE_CONFIG_DIR` env injection in every model-bearing launch builder of `@generacy-ai/generacy-plugin-claude-code`
**Branch**: `1198-context-claude-code-validates`
**Status**: Complete
**Issue**: generacy-ai/generacy#1198 (P1 of epic generacy-ai/generacy#1197)

## Summary

Claude Code validates model ids against `api.anthropic.com` but passes any model string through when `ANTHROPIC_BASE_URL` points at a gateway. To run non-Anthropic models, the engine launches the CLI with a second config directory (`CLAUDE_CONFIG_DIR=/home/node/.claude-gateway`) whose `settings.json` carries the gateway base URL / auth token. This feature ships the pure route-resolution primitive and wires the gateway env into all six model-bearing builders. Rollout is flag-free by construction: subscription-model launches are byte-identical to pre-change output.

All changes are confined to `packages/generacy-plugin-claude-code/`. No orchestrator, config-schema, or launcher change — `AgentLauncher`'s existing env merge (`packages/orchestrator/src/launcher/agent-launcher.ts:106-114`, `...launchSpec.env`) is the delivery mechanism.

## Technical Context

- **Language/runtime**: TypeScript (ESM), Node >= 20; `node:fs` (`existsSync`) + `node:path` only — zero new dependencies.
- **Package**: `@generacy-ai/generacy-plugin-claude-code`. Builders live in `src/launch/claude-code-launch-plugin.ts`; intents in `src/launch/types.ts`; public surface in `src/index.ts`.
- **Constructor constraint (load-bearing)**: `ClaudeCodeLaunchPlugin` today has an implicit no-arg constructor and ~15 call sites do `new ClaudeCodeLaunchPlugin()` (production: `packages/orchestrator/src/launcher/launcher-setup.ts:25`; plus many orchestrator tests). The new `gatewayConfigDir` option MUST be an optional options-object parameter so every existing call site compiles and behaves unchanged.
- **`LaunchSpec` is plugin-local** (`claude-code-launch-plugin.ts:18-23`), structurally mirrored from the orchestrator to avoid the workspace build cycle. Adding optional `route?: 'gateway'` to the local interface is safe: width subtyping keeps the plugin assignable to the orchestrator's `AgentLaunchPlugin` at the registration seam. The orchestrator's own `LaunchSpec` is NOT modified (FR-007 marks `route` informational; #1199 must call `resolveRoute(model)` directly — Clarification Q1).
- **Model-bearing builders (6)**: `buildPhaseLaunch`, `buildPrFeedbackLaunch`, `buildMergeConflictLaunch`, `buildReviewLaunch`, `buildRemediateLaunch`, `buildConversationTurnLaunch`. `buildInvokeLaunch` carries no model — untouched, no `route` field ever (Q1).
- **Existing process-lifetime-cache precedent**: `effortMechanismCache` (`claude-code-launch-plugin.ts:38`) with `_setHasEffortMechanismForTests` — the settings.json positive-only cache follows the same module-level pattern with a `_resetGatewayProvisionCacheForTests` escape hatch.

## Clarifications applied (all load-bearing)

- **Q1=A**: `route: 'gateway'` only on gateway launches; subscription and invoke `LaunchSpec`s omit the field entirely → strict deep-equal to pre-change output holds (FR-004/SC-002/SC-004). Implementation: subscription path returns the builder's base object **as-is** (no spread, no key added).
- **Q2=A**: `gatewayConfigDir` precedence explicit option > `GENERACY_CLAUDE_GATEWAY_CONFIG_DIR` env > `/home/node/.claude-gateway`. Resolved once in the constructor.
- **Q3=A**: settings.json check caches **only the positive** result per process, keyed per gateway dir path; while missing, re-stat on every gateway launch (no invalidation machinery; cold path = one `stat` per gateway launch on an already-broken cluster).
- **Q4=A**: CLI args identical across routes — `--model <provider/model>` verbatim, `--effort` still appended when set. Env injection is the only route difference.

## Design

### New module: `src/launch/route.ts`

- `type Route = 'subscription' | 'gateway'`
- `resolveRoute(model?: string): Route` — pure: `'gateway'` iff `model` contains `/`; `'subscription'` otherwise, including `undefined` (FR-001). `[1m]` suffix, aliases, `claude-*` have no `/` → subscription by construction.
- `DEFAULT_GATEWAY_CONFIG_DIR = '/home/node/.claude-gateway'`
- `resolveGatewayConfigDir(explicit?: string): string` — `explicit ?? process.env.GENERACY_CLAUDE_GATEWAY_CONFIG_DIR ?? DEFAULT_GATEWAY_CONFIG_DIR` (FR-002, Q2). `??` (nullish) so an empty-string explicit is still treated as "not passed"? No — use `??`: only `undefined`/`null` fall through, matching conventional precedence; nothing in the engine passes the option today.
- `assertGatewayProvisioned(model: string, gatewayConfigDir: string): void` — positive-only cache (`Set<string>` of dir paths). Cache hit → return. Miss → `existsSync(join(dir, 'settings.json'))`; present → add to cache + return; absent → throw `GatewayRouteUnavailableError` (FR-005/FR-006, Q3).
- `GatewayRouteUnavailableError extends Error` — fields `model`, `gatewayConfigDir`; `name = 'GatewayRouteUnavailableError'`; message names the model, the dir, and `GENERACY_LLM_GATEWAY_URL` (the operator's provisioning pointer). Standalone `Error` subclass, NOT `PluginError` (whose `ErrorCode` enum is session/container-oriented; this is a launch-construction error surfaced through `buildLaunch`).
- `_resetGatewayProvisionCacheForTests(): void` — test-only, mirrors `_setHasEffortMechanismForTests`.

### Plugin changes: `src/launch/claude-code-launch-plugin.ts`

- Local `LaunchSpec` gains `route?: 'gateway'` (FR-007; type deliberately excludes `'subscription'` so the field cannot be stamped on subscription launches).
- New exported `ClaudeCodeLaunchPluginOptions { gatewayConfigDir?: string }`; `constructor(options?: ClaudeCodeLaunchPluginOptions)` stores `this.gatewayConfigDir = resolveGatewayConfigDir(options?.gatewayConfigDir)`.
- New private helper applied as the last step of each of the six model-bearing builders:

  ```ts
  private applyRoute(spec: LaunchSpec, model?: string): LaunchSpec {
    if (resolveRoute(model) !== 'gateway') return spec; // subscription: object returned as-is → deep-equal holds
    assertGatewayProvisioned(model as string, this.gatewayConfigDir);
    return { ...spec, env: { CLAUDE_CONFIG_DIR: this.gatewayConfigDir }, route: 'gateway' };
  }
  ```

  (`model` is necessarily defined on the gateway branch — `undefined` resolves `'subscription'`.)
- Each builder's `return { command, args, stdioProfile }` becomes `return this.applyRoute({ command, args, stdioProfile }, intent.model)`. `buildInvokeLaunch` untouched. Arg construction untouched (FR-009, Q4).

### Public exports: `src/index.ts`

- `resolveRoute`, `GatewayRouteUnavailableError`, `DEFAULT_GATEWAY_CONFIG_DIR`, `_resetGatewayProvisionCacheForTests` (test seam), `type Route`, `type ClaudeCodeLaunchPluginOptions`.

### Non-changes (explicit)

- `AgentEntrySchema` / `.generacy/config.yaml` schema (FR-008) — `model` stays free-form.
- Orchestrator: launcher, `launcher-setup.ts`, worker spawn sites — zero edits; env flows through the existing merge.
- `buildInvokeLaunch`, workflow-engine local path, gateway sidecar/provisioning, session invalidation (#1199), validate/doctor checks (#1200).

## Project Structure

```
packages/generacy-plugin-claude-code/
├── src/
│   ├── launch/
│   │   ├── route.ts                          # NEW — resolveRoute, dir resolution, provision check, error
│   │   ├── claude-code-launch-plugin.ts      # MOD — LaunchSpec.route?, options ctor, applyRoute in 6 builders
│   │   └── types.ts                          # unchanged (intents already carry model?)
│   ├── index.ts                              # MOD — new exports
│   └── errors.ts                             # unchanged
└── tests/unit/
    ├── route.test.ts                         # NEW — SC-001 table, dir precedence, cache semantics, error shape
    └── claude-code-launch-plugin.test.ts     # MOD — SC-002/SC-004 per-builder gateway + byte-identity matrix
.changeset/1198-gateway-route-resolution.md   # NEW — minor bump (see below)
```

## Testing Strategy

- **`route.test.ts`**: SC-001 full table (`claude-opus-4-7`, `opus`, `claude-sonnet-4-5[1m]`, `openrouter/qwen/qwen3.5-coder`, `openai/gpt-5.5`, `undefined`); precedence matrix for `resolveGatewayConfigDir` (option/env/default, env stubbed via `vi.stubEnv`); Q3 cache semantics against a real temp dir (`mkdtemp`): missing → throws; create `settings.json` → next call passes (negative never cached); delete after positive → still passes (positive cached); per-dir keying; `GatewayRouteUnavailableError` message names model + dir + `GENERACY_LLM_GATEWAY_URL` (SC-003).
- **`claude-code-launch-plugin.test.ts`**: for each of the six builders — gateway model (dir provisioned via temp dir passed as explicit option) → `env.CLAUDE_CONFIG_DIR === dir` and `route === 'gateway'`, args identical to subscription args modulo the model string (FR-009); subscription model and `undefined` → `toEqual` against the literal pre-change spec and `expect(spec).not.toHaveProperty('env')` / `not.toHaveProperty('route')` (US2); gateway model + unprovisioned dir → throws `GatewayRouteUnavailableError` (US3). `buildInvokeLaunch` never gains `route`. Reset the provision cache in `beforeEach`.
- **SC-005**: `pnpm -r build` + full suite green; existing orchestrator tests that construct `new ClaudeCodeLaunchPlugin()` compile and pass unchanged (optional ctor arg).

## Constitution Check

No `.specify/memory/constitution.md` in the repo → skipped.

## Changeset (CI gate)

`.changeset/1198-gateway-route-resolution.md` — `@generacy-ai/generacy-plugin-claude-code` **minor** (new public capability: `resolveRoute`, `GatewayRouteUnavailableError`, `ClaudeCodeLaunchPluginOptions`, gateway env injection). Single package, single file. Must be a newly added file in the PR diff.

## Risks & Mitigations

- **Byte-identity regression on subscription path** → `applyRoute` returns the base object unmodified (no spread) on the subscription branch; per-builder `toEqual` + `not.toHaveProperty` tests pin it.
- **Structural-typing drift at the registration seam** → `route?` is optional and additive; orchestrator's `LaunchSpec` unchanged; existing `claude-code-launch-plugin-integration.test.ts` exercises the seam.
- **Cache leaking across tests** → `_resetGatewayProvisionCacheForTests` called in `beforeEach`, same pattern as the effort probe cache.

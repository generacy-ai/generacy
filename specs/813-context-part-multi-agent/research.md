# Research: Launcher Multi-Provider Registry

Each section links a design question to the clarification that resolved it (see `clarifications.md`).

## D-1: Registry key shape

**Decision**: Single `Map<string, AgentLaunchPlugin>` keyed on the composed string `${provider}:${kind}`.

**Rationale**:
- Preserves `Map`-based O(1) lookup — no perf regression vs. today's `kindToPlugin` map.
- Colon is illegal in both TypeScript identifier chars and JSON-schema plugin/kind names we control, so no collision risk.
- A tuple-keyed `Map<[string, string], plugin>` would require a custom equality wrapper — pointless complexity.
- Nested `Map<provider, Map<kind, plugin>>` would double lookups and complicate the "unknown provider" vs. "unknown kind" error branches.

**Alternatives considered**:
- Nested map (rejected: two lookups per launch, two error branches).
- Structured key object with custom `Map` subclass (rejected: overkill for two-string composite).

**Reference**: Q2 answer A (clarifications.md).

## D-2: Where the six intent types physically live

**Decision**: Definitions move to `packages/orchestrator/src/launcher/types.ts`. The Claude plugin `import`s them from `@generacy-ai/generacy-plugin-claude-code`'s **peer dep** — actually from the orchestrator package where they now live. To avoid a circular runtime dependency, only *types* are imported (`import type { ... }`).

**Rationale**:
- FR-008 / SC-004 demand orchestrator core owns the whole agent-intent surface. Leaving the two newer intents in the plugin re-introduces exactly the leak this issue closes.
- `import type` is erased at compile time — no runtime cycle, no bundler churn.
- The Claude plugin's `src/launch/types.ts` becomes a **thin re-export** (`export type { PhaseIntent, ... } from '@generacy-ai/orchestrator/launcher/types'`) or is deleted entirely and `index.ts` re-exports from orchestrator. Both options are structurally identical to downstream consumers — pick delete-and-re-export in `index.ts` to reduce file count.

**Alternatives considered**:
- Keep intents in the plugin, orchestrator imports them — rejected: this is exactly today's leak.
- Structural typing (orchestrator declares a shape, plugin matches by structure with no import) — rejected: works but sacrifices type-navigation ergonomics for zero payoff; every follow-up field addition would silently drift.
- Move only the four intents FR-001 named — rejected: Q1 answer A explicitly rules this out.

**Reference**: Q1 answer A (clarifications.md), spec Scope §1.

## D-3: Plugin provider discovery

**Decision**: `AgentLaunchPlugin` interface gains `readonly provider: string`. Plugins self-declare. Registration signature stays `registerPlugin(plugin)`.

**Rationale**:
- Zero call-site edits in prod code and tests (spec SC-005).
- `ClaudeCodeLaunchPlugin` already has `pluginId = 'claude-code'` — the new `provider` field is one added line (or an alias thereof).
- `GenericSubprocessPlugin` gains `readonly provider = SYSTEM_PROVIDER` (from `constants.ts`).

**Alternatives considered**:
- `registerPlugin(plugin, provider)` — every registration site edits, no gain.
- Default-with-optional-arg fallback (`plugin.provider ?? providerArg ?? 'claude-code'`) — three-way logic, harder to reason about, no simpler at call sites than option A.

**Reference**: Q3 answer A (clarifications.md).

## D-4: `LaunchRequest.provider` static type

**Decision**: Bare `string`, optional.

**Rationale**:
- Core cannot enumerate concrete providers — the registry is the source of truth. A literal union would need a core edit per new provider, contradicting the ethos this issue establishes.
- Real provider values come from `.generacy/config.yaml` at runtime; TS unions offer no runtime guarantee anyway.
- `UnknownProviderError` (D-5) is the designed guard. `#814` layers config-schema validation with a phase-start failure on top.
- Optional (`provider?: string`), defaulted to `'claude-code'` inside `AgentLauncher.launch()` — preserves SC-005 (call sites unchanged).

**Reference**: Q4 answer A (clarifications.md).

## D-5: Typed error classes

**Decision**: Two named error classes in `packages/orchestrator/src/launcher/errors.ts`, both exported from `index.ts`:

```ts
export class UnknownProviderError extends Error {
  readonly name = 'UnknownProviderError';
  constructor(readonly provider: string, readonly kind: string, readonly availableProviders: readonly string[]) { ... }
}

export class DuplicatePluginRegistrationError extends Error {
  readonly name = 'DuplicatePluginRegistrationError';
  constructor(readonly provider: string, readonly kind: string, readonly existingPluginId: string) { ... }
}
```

**Rationale**:
- FR-007 requires typed unknown-provider error. Symmetric typed duplicate-registration error costs a few lines and makes bootstrap double-registration distinguishable in logs (Q5 answer A).
- `readonly` fields on both errors expose the offending values without callers parsing message strings.
- Keep `name` explicit (not inherited) so JSON-serialized errors are unambiguous even across `structuredClone` / worker boundaries.
- Message text includes available providers/kinds — same operator-facing hint as today's `Available kinds: ...`.

**Alternatives considered**:
- Single `LauncherRegistrationError` with a `code` discriminator — rejected: `instanceof` on two classes is cheaper for callers than `err.code === 'DUPLICATE'`.
- Retain plain `Error` for duplicate (option B in Q5) — rejected explicitly by Q5 answer A.

**Reference**: Q5 answer A (clarifications.md).

## D-6: Registry lookup — unknown-provider vs. unknown-kind

**Decision**: Single lookup on the composed key `${provider}:${kind}`. On miss, the launcher performs a second scan to classify:
- If any registered key starts with `${provider}:` → unknown **kind** for that provider → throw a plain `Error` (retains today's semantics for unknown kinds).
- Otherwise → unknown **provider** → throw `UnknownProviderError`.

**Rationale**:
- One code path per FR-005/FR-007 intent; the second scan is O(N) where N = plugin count (single-digit).
- Preserves today's operator experience for unknown-kind errors (call sites can already handle plain `Error` for that path).
- Makes the "resource-not-found" and "namespace-not-found" branches distinguishable without conflating them.

## D-7: Where the `system` / `claude-code` constants live

**Decision**: `packages/orchestrator/src/launcher/constants.ts`:

```ts
export const SYSTEM_PROVIDER = 'system' as const;
export const DEFAULT_PROVIDER = 'claude-code' as const;
```

Neither constant is re-exported from `packages/orchestrator/src/launcher/index.ts`. Both remain internal to the launcher.

**Rationale**:
- Q2 answer A: `system` must stay internal — "not exported, never valid in workflow config".
- `DEFAULT_PROVIDER` also stays internal: config-schema validation lives in #814 and reads its own allowlist; leaking core defaults would tempt call sites to hardcode against them.

## D-8: `orchestrator-types` package

**Decision**: `packages/orchestrator-types/src/launcher-types.ts` receives the same additions (`AgentLaunchPlugin.provider`, `LaunchRequest.provider?`). Intent unions are **not** widened in `orchestrator-types` — that package intentionally exposes only the `LaunchIntent = GenericSubprocessIntent | ShellIntent` subset (per the existing comment at line 51-53). External consumers of `orchestrator-types` do not need agent-intent shapes to consume the interface.

**Rationale**:
- The comment already documents the subset-by-design. Widening would drag agent-intent semantics into an interface package that has no reason to know about them.
- Adding `provider` to plugin/request is a structural widening consumers can safely absorb (all fields remain optional at the boundary).

## D-9: `provider` defaulting site

**Decision**: `AgentLauncher.launch()` reads `request.provider ?? DEFAULT_PROVIDER` **once**, at the top. All downstream code uses the resolved value. Plugins never see `undefined`.

**Rationale**:
- Single defaulting site, easy to grep, easy to change.
- Keeps `LaunchRequest.provider` optional at the type layer (SC-005: call sites unchanged) while making the internal contract non-optional.

## Key References

- `packages/orchestrator/src/launcher/agent-launcher.ts:20, 34-44` — current `kindToPlugin` map + duplicate error
- `packages/orchestrator/src/launcher/types.ts:2, 33` — the `ClaudeCodeIntent` import that leaks
- `packages/generacy-plugin-claude-code/src/launch/types.ts` — the six intents' current home
- `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts:36-37` — `pluginId` + `supportedKinds` — where `provider` gets added
- `packages/orchestrator-types/src/launcher-types.ts:51-53, 81-86` — external contract mirror
- Multi-agent provider plan (Codex + OpenCode): Phase 1, issue 1 of 3.

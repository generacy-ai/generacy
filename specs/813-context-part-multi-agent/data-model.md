# Data Model: Launcher Registry + Intent Types

All types live in `packages/orchestrator/src/launcher/` unless annotated.

## 1. Provider constants (`constants.ts`, NEW)

```ts
/** Reserved provider for non-agent plugins (subprocess, shell). Internal — never exported from `index.ts`, never valid in workflow config. */
export const SYSTEM_PROVIDER = 'system' as const;

/** Default provider when `LaunchRequest.provider` is omitted. Internal — call sites must not depend on it. */
export const DEFAULT_PROVIDER = 'claude-code' as const;
```

**Validation rules**: Neither constant is re-exported from `packages/orchestrator/src/launcher/index.ts`. Grep-fence enforced by test (see contracts/registry-contract.md §Constants).

## 2. Agent intent types (`types.ts`, MOVED FROM plugin)

All six intents relocate from `packages/generacy-plugin-claude-code/src/launch/types.ts`. Field shape carries over verbatim, plus two additions.

### 2.1 `PhaseIntent`

```ts
export interface PhaseIntent {
  kind: 'phase';
  phase: 'specify' | 'clarify' | 'plan' | 'tasks' | 'implement';
  prompt: string;
  sessionId?: string;
  /** NEW — optional model override, provider-interpreted. */
  model?: string;
}
```

### 2.2 `PrFeedbackIntent`

```ts
export interface PrFeedbackIntent {
  kind: 'pr-feedback';
  prNumber: number;
  prompt: string;
  /** NEW — optional model override, provider-interpreted. */
  model?: string;
}
```

### 2.3 `ValidateFixIntent`

```ts
export interface ValidateFixIntent {
  kind: 'validate-fix';
  prNumber: number;
  prompt: string;
  /** 64-hex SHA-256 identity of the failing evidence — surfaces in logs. */
  evidenceHash: string;
}
```

### 2.4 `MergeConflictIntent`

```ts
export interface MergeConflictIntent {
  kind: 'merge-conflict';
  issueNumber: number;
  prompt: string;
}
```

### 2.5 `ConversationTurnIntent`

```ts
export interface ConversationTurnIntent {
  kind: 'conversation-turn';
  message: string;
  sessionId?: string;
  model?: string;
  skipPermissions: boolean;
}
```

### 2.6 `InvokeIntent`

```ts
export interface InvokeIntent {
  kind: 'invoke';
  command: string;
  streaming?: boolean;
}
```

### 2.7 Widened union

```ts
export type LaunchIntent =
  | GenericSubprocessIntent
  | ShellIntent
  | PhaseIntent
  | PrFeedbackIntent
  | ValidateFixIntent
  | MergeConflictIntent
  | ConversationTurnIntent
  | InvokeIntent;
```

The historical `ClaudeCodeIntent` type name is **deleted** from orchestrator core. If Wave 3 needs a provider-scoped alias, that lives in the Claude plugin.

## 3. `LaunchRequest` (`types.ts`, MODIFIED)

```ts
export interface LaunchRequest {
  intent: LaunchIntent;
  cwd: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  detached?: boolean;
  credentials?: LaunchRequestCredentials;
  /** NEW — optional provider selector. Default: 'claude-code'. Runtime-validated (UnknownProviderError). */
  provider?: string;
}
```

**Validation**: `provider` is bare `string`. Zero compile-time validation by design (Q4 answer A). Runtime validation happens inside `AgentLauncher.launch()`:
- If `provider` is present but no plugin registered for `(provider, intent.kind)` and no plugin registered for that `provider` at all → `UnknownProviderError`.
- If `provider` is present, plugin exists for `provider`, but not for that `kind` → plain `Error` (unknown-kind path).

## 4. `AgentLaunchPlugin` (`types.ts`, MODIFIED)

```ts
export interface AgentLaunchPlugin {
  readonly pluginId: string;
  /** NEW — the provider namespace this plugin claims. Registry key becomes (provider, kind). */
  readonly provider: string;
  readonly supportedKinds: readonly string[];
  buildLaunch(intent: LaunchIntent): LaunchSpec;
  createOutputParser(intent: LaunchIntent): OutputParser;
}
```

**Invariants**:
- `provider` must be a non-empty string. Enforced at registration (plain `Error` — this is a plugin-authoring bug, not a runtime dispatch failure).
- `SYSTEM_PROVIDER` is legal but reserved for launcher-internal plugins (subprocess/shell). No test that this is enforced at type layer — enforcement is by convention + the `system` constant staying internal.

## 5. Typed errors (`errors.ts`, NEW)

```ts
export class UnknownProviderError extends Error {
  readonly name = 'UnknownProviderError';
  readonly provider: string;
  readonly kind: string;
  readonly availableProviders: readonly string[];
  constructor(provider: string, kind: string, availableProviders: readonly string[]) {
    super(`Unknown provider "${provider}" for intent kind "${kind}". Available providers: ${availableProviders.join(', ') || '(none)'}`);
    this.provider = provider;
    this.kind = kind;
    this.availableProviders = availableProviders;
  }
}

export class DuplicatePluginRegistrationError extends Error {
  readonly name = 'DuplicatePluginRegistrationError';
  readonly provider: string;
  readonly kind: string;
  readonly existingPluginId: string;
  constructor(provider: string, kind: string, existingPluginId: string) {
    super(`Intent (provider: "${provider}", kind: "${kind}") already registered by plugin "${existingPluginId}"`);
    this.provider = provider;
    this.kind = kind;
    this.existingPluginId = existingPluginId;
  }
}
```

**Invariants**:
- Both classes set `name` explicitly (survives structuredClone / worker boundaries).
- Fields are `readonly` — no mutation after construction.
- Both re-exported from `packages/orchestrator/src/launcher/index.ts`.

## 6. Registry structure (`agent-launcher.ts`, MODIFIED)

Internally: `private readonly registry = new Map<string, AgentLaunchPlugin>()` where the key is `${provider}:${kind}`.

Two derived views used only in error paths:
- `getProvidersForKind(kind)` — filter map keys by suffix.
- `getKindsForProvider(provider)` — filter map keys by prefix.

Both O(N) over plugin count (single-digit), only invoked on the error branch.

## 7. `orchestrator-types` mirror (`packages/orchestrator-types/src/launcher-types.ts`, MODIFIED)

Two structural additions only:

```ts
export interface AgentLaunchPlugin {
  readonly pluginId: string;
  readonly provider: string;  // NEW
  readonly supportedKinds: readonly string[];
  buildLaunch(intent: LaunchIntent): LaunchSpec;
  createOutputParser(intent: LaunchIntent): OutputParser;
}

export interface LaunchRequest {
  intent: LaunchIntent;
  cwd: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  detached?: boolean;
  credentials?: unknown;
  provider?: string;  // NEW
}
```

The agent-intent union stays subset per the existing comment (see research.md D-8).

## 8. Relationships

```
LaunchRequest ──has──▶ LaunchIntent (discriminated by `kind`)
LaunchRequest ──has──▶ provider?: string (defaults to DEFAULT_PROVIDER)

AgentLauncher.registry ──keyed by──▶ `${provider}:${kind}`
                       ──values──▶ AgentLaunchPlugin (must have matching provider + kind in supportedKinds)

AgentLaunchPlugin ──declares──▶ provider (self-declared, self-consistent with registration)
AgentLaunchPlugin ──declares──▶ supportedKinds (each becomes one registry entry under `${plugin.provider}:${kind}`)

registerPlugin ──throws──▶ DuplicatePluginRegistrationError (typed)
launch          ──throws──▶ UnknownProviderError (typed) | Error (unknown kind for known provider)
```

## 9. Not modeled here (out of scope)

- Workflow YAML `provider:` field — #814.
- Provider allowlist for config schema — #814.
- Any second concrete provider — Phase 3.

# Clarifications

## Batch 1 — 2026-07-13T16:45:00Z

### Q1: Scope of intent moves
**Context**: FR-001 names four intents to move from the Claude plugin into orchestrator core (`phase`, `pr-feedback`, `conversation-turn`, `invoke`). But `packages/generacy-plugin-claude-code/src/launch/types.ts` currently exports **six** kinds under `ClaudeCodeIntent`: the four named, plus `validate-fix` (#892) and `merge-conflict` (#898). Both are described in-code as "routing through the same launcher plumbing as `pr-feedback` — no new plugin needed", i.e. they are provider-agnostic in spirit. Leaving them in the plugin package means orchestrator core still can't own the full agent-intent surface, and future providers (Codex/OpenCode) would need Claude-plugin imports to satisfy those kinds — reintroducing the leak this issue is trying to seal.
**Question**: Do `ValidateFixIntent` and `MergeConflictIntent` also move to `packages/orchestrator/src/launcher/types.ts` alongside the four intents FR-001 names?
**Options**:
- A: Move all six agent intents (`phase`, `pr-feedback`, `conversation-turn`, `invoke`, `validate-fix`, `merge-conflict`) to orchestrator core; the Claude plugin re-imports (or structurally matches).
- B: Move only the four intents in FR-001; `validate-fix` and `merge-conflict` stay in the Claude plugin for now (deferred to a follow-up).
- C: Move only the four intents in FR-001; `validate-fix` and `merge-conflict` stay in the Claude plugin permanently (they are Claude-only by design).

**Answer**: *Pending*

### Q2: Non-agent intent registry keying
**Context**: The current registry keys on `kind` alone for **all** plugins, including the non-agent `GenericSubprocessPlugin` (`supportedKinds: ['generic-subprocess', 'shell']`). FR-004 says re-key on `(provider, kind)`, but doesn't say whether that widening applies to subprocess/shell too or only to the four (or six — see Q1) agent kinds. If everything is tuple-keyed, `GenericSubprocessPlugin` needs a provider identifier (e.g. `'system'`) — an arbitrary invention that leaks the tuple concept to plumbing that has no notion of a provider. If only agent kinds are tuple-keyed, the registry gains a bifurcated shape and lookup path.
**Question**: Does the `(provider, kind)` registry key apply to all plugins, or only agent-intent plugins?
**Options**:
- A: All plugins tuple-keyed. `GenericSubprocessPlugin` registers with a fixed provider (e.g. `'system'` or a shared `'core'` constant).
- B: Only the agent-kind plugins are tuple-keyed. `generic-subprocess` and `shell` remain in a `kind`-only lookup; agent kinds go through a separate `(provider, kind)` lookup.
- C: All plugins tuple-keyed, but `GenericSubprocessPlugin` reuses `'claude-code'` as its provider (avoids inventing a new identifier).

**Answer**: *Pending*

### Q3: How the launcher learns a plugin's provider
**Context**: With `(provider, kind)` keying, the launcher needs a provider identifier at registration time. Two shapes are possible: (a) `AgentLaunchPlugin` gains a `readonly provider: string` field the launcher reads off the plugin object (plugin self-declares); (b) the caller passes provider as a second arg: `registerPlugin(plugin, provider)`. Option (a) keeps registration sites unchanged (`launcher.registerPlugin(new ClaudeCodeLaunchPlugin())`) but forces every plugin implementation to add the field. Option (b) requires updating every registration site (a widespread change across tests + prod code) but leaves the interface smaller.
**Question**: How does the launcher discover the provider a plugin claims?
**Options**:
- A: Add `readonly provider: string` to the `AgentLaunchPlugin` interface. Registration signature stays `registerPlugin(plugin)`; the plugin declares its own identity.
- B: `registerPlugin(plugin, provider: string)` — caller supplies the provider at registration time. `AgentLaunchPlugin` interface unchanged.
- C: Support both — if `plugin.provider` is set, use it; otherwise fall back to a `registerPlugin(plugin, provider?)` argument; otherwise default to `'claude-code'` (backwards compatible for existing sites).

**Answer**: *Pending*

### Q4: `provider` field type
**Context**: FR-003 says "add optional `provider?: string`". Choosing bare `string` maximizes extensibility (third-party providers register without a core edit) but loses compile-time typo protection — `launch({ provider: 'clade-code' })` compiles. A string literal union (`'claude-code' | 'codex' | 'opencode'`) catches typos but requires editing orchestrator core to add each new provider — cutting across the "orchestrator doesn't know about concrete providers" ethos this issue is establishing.
**Question**: What TypeScript type should `LaunchRequest.provider` have?
**Options**:
- A: `string` — open-ended; no compile-time provider validation.
- B: A string literal union of known providers (e.g. `type ProviderId = 'claude-code' | 'codex' | 'opencode'`), extended as providers land.
- C: A branded/opaque type (`type ProviderId = string & { readonly __brand: 'ProviderId' }`) — nominally distinct from `string` but allows any value at runtime.

**Answer**: *Pending*

### Q5: Duplicate-registration error class
**Context**: FR-007 requires the unknown-provider error to be a *typed* error class distinguishable from generic `Error` (measured by SC-003). FR-005 says duplicate `(provider, kind)` registration "retains today's error semantics" — today that's a plain `throw new Error(...)` (`agent-launcher.ts:38`). Leaving duplicate registration as plain `Error` while unknown-provider is typed creates asymmetric error handling — callers can `instanceof UnknownProviderError` but not `instanceof DuplicatePluginRegistrationError`. Symptom: bootstrap failures (a real cause of duplicate registration) become harder to distinguish in logs.
**Question**: Should duplicate-registration also throw a typed error class, matching the unknown-provider treatment?
**Options**:
- A: Yes — introduce `DuplicatePluginRegistrationError` alongside the unknown-provider typed error; both live in `packages/orchestrator/src/launcher/`.
- B: No — retain today's plain `Error` for duplicate registration; only unknown-provider is typed (as FR-007 dictates).

**Answer**: *Pending*

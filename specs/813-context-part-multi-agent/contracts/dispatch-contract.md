# Contract: Launch Dispatch

`AgentLauncher.launch(request: LaunchRequest): Promise<LaunchHandle>`

## Preconditions

- `request.intent.kind` is a legal `LaunchIntent.kind` (discriminated union enforcement).
- `request.provider` is either omitted or a bare non-empty string. No compile-time provider validation.

## Resolution Algorithm

1. Let `provider = request.provider ?? DEFAULT_PROVIDER`.
2. Let `kind = request.intent.kind`.
3. Let `key = ${provider}:${kind}`.
4. If `registry.has(key)` → `plugin = registry.get(key)`. Proceed to step 7.
5. Else: scan registry keys.
   - If any key has prefix `${provider}:` → throw `Error` (unknown kind for known provider) with the message pattern:
     `Unknown intent kind "${kind}" for provider "${provider}". Known kinds for this provider: ${knownKindsCsv}`
   - Else → throw `UnknownProviderError(provider, kind, availableProviders)` where `availableProviders` is the distinct provider prefixes seen in the registry, sorted lexicographically.
6. *(Never reached — steps 4/5 are exhaustive.)*
7. Delegate `plugin.buildLaunch(intent)` → env merge → credentials interceptor → factory spawn → return `LaunchHandle`.

## Error class shape

```ts
class UnknownProviderError extends Error {
  readonly name: 'UnknownProviderError';
  readonly provider: string;                        // as supplied (or DEFAULT_PROVIDER)
  readonly kind: string;                            // intent.kind
  readonly availableProviders: readonly string[];   // sorted, deduplicated
}
```

Instances satisfy `instanceof UnknownProviderError`.

## Postconditions

- On success, `LaunchHandle.metadata.pluginId === plugin.pluginId` and `LaunchHandle.metadata.intentKind === kind`.
- On success, no side effects observable via env or process state beyond what the plugin's `buildLaunch()` and the credentials interceptor produce today.

## No-op parity (call-site compatibility)

- Every existing production call site omits `provider`, resolving to `DEFAULT_PROVIDER = 'claude-code'`.
- Every existing kind (`phase`, `pr-feedback`, `validate-fix`, `merge-conflict`, `conversation-turn`, `invoke`) resolves to `ClaudeCodeLaunchPlugin` (which declares `provider = 'claude-code'`).
- Kinds `generic-subprocess` and `shell` resolve under `provider = SYSTEM_PROVIDER = 'system'`, but every existing internal call site for those kinds also omits `provider`.

**Problem**: A `generic-subprocess` intent with no explicit `provider` will resolve to `${DEFAULT_PROVIDER}:generic-subprocess = 'claude-code:generic-subprocess'`, which does not exist.

**Resolution**: The dispatch algorithm is refined for kinds that only `SYSTEM_PROVIDER` claims. Concretely, step 4 becomes:

4a. If `registry.has(${provider}:${kind})` → use that plugin.
4b. Else if `provider === DEFAULT_PROVIDER` (i.e. caller did not supply one) AND `registry.has(${SYSTEM_PROVIDER}:${kind})` → fall back to the system plugin.
4c. Else → step 5.

This preserves call-site parity (SC-005) without exporting `SYSTEM_PROVIDER`. Callers who explicitly pass `provider: 'claude-code'` alongside a `generic-subprocess` intent still error — that combination is genuinely wrong.

## Intent-provider compatibility

Not statically enforced. A `phase` intent under `provider = 'test-agent'` is legal iff a plugin registered `('test-agent', 'phase')`. The registry is the source of truth.

## Snapshot parity

Argv snapshot tests (`packages/orchestrator/src/__tests__/worker/cli-spawner-snapshot.test.ts` and neighbors) must produce byte-identical output. The default-provider fallback in step 4b is the mechanism that ensures this — the resolved plugin is the same instance for every existing call site.

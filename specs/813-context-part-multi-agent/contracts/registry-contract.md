# Contract: Plugin Registry

`AgentLauncher.registerPlugin(plugin: AgentLaunchPlugin): void`

## Preconditions

- `plugin.provider` is a non-empty string. Empty/missing → plain `Error` at registration.
- `plugin.supportedKinds` is a non-empty readonly array of non-empty strings.

## Behavior

For each `kind` in `plugin.supportedKinds`:

1. Compose registry key `${plugin.provider}:${kind}`.
2. If the map already has that key, throw `DuplicatePluginRegistrationError(plugin.provider, kind, existingPluginId)`.
3. Otherwise, insert `(key → plugin)` in the registry.

## Postconditions

- Every `(plugin.provider, kind)` pair is a distinct key in the registry.
- Two plugins may share a `kind` **only** if their `provider` differs.
- Two plugins may share a `provider` **only** if their `supportedKinds` sets are disjoint.

## Constants

- `SYSTEM_PROVIDER = 'system'` — used by `GenericSubprocessPlugin`.
- `DEFAULT_PROVIDER = 'claude-code'` — resolved default for `LaunchRequest.provider === undefined`.

Both constants live in `packages/orchestrator/src/launcher/constants.ts`. **Not** re-exported from `packages/orchestrator/src/launcher/index.ts`. Enforcement: one test greps the index.ts export list and fails if either identifier appears.

## Error class shape

```ts
class DuplicatePluginRegistrationError extends Error {
  readonly name: 'DuplicatePluginRegistrationError';
  readonly provider: string;         // e.g. 'claude-code'
  readonly kind: string;             // e.g. 'phase'
  readonly existingPluginId: string; // pluginId of the already-registered plugin
}
```

Instances satisfy `instanceof DuplicatePluginRegistrationError`.

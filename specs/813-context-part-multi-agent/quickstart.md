# Quickstart: Multi-Provider Launcher (Issue #813)

This change is invisible to callers — no config surface, no CLI flag, no `.generacy/config.yaml` field. It widens the launcher's registry so a second agent plugin can register alongside `ClaudeCodeLaunchPlugin`. Landing #814 exposes the config surface; landing Phase 3 lands the first second provider (Codex).

## Verify no-op parity locally

```bash
# From repo root
pnpm install
pnpm --filter @generacy-ai/orchestrator test -- cli-spawner-snapshot
pnpm --filter @generacy-ai/orchestrator test -- agent-launcher
pnpm --filter @generacy-ai/generacy-plugin-claude-code test
```

Snapshot tests must pass byte-identical. If any snapshot diffs, the default-provider fallback in `AgentLauncher.launch()` is likely wrong — see `contracts/dispatch-contract.md` §4b.

## Registering a second provider (post-change reference)

```ts
import { AgentLauncher, DEFAULT_PROVIDER } from '@generacy-ai/orchestrator';
import type { AgentLaunchPlugin, LaunchIntent, LaunchSpec } from '@generacy-ai/orchestrator';

class FakeCodexPlugin implements AgentLaunchPlugin {
  readonly pluginId = 'fake-codex';
  readonly provider = 'codex';           // NEW required field
  readonly supportedKinds = ['phase'] as const;

  buildLaunch(intent: LaunchIntent): LaunchSpec {
    // ...
  }
  createOutputParser() { /* ... */ }
}

launcher.registerPlugin(new FakeCodexPlugin());

// Dispatch by provider:
await launcher.launch({
  intent: { kind: 'phase', phase: 'implement', prompt: '...' },
  cwd: '/workspace',
  provider: 'codex',   // NEW optional field, defaults to 'claude-code'
});
```

## Handling errors

```ts
import { UnknownProviderError, DuplicatePluginRegistrationError } from '@generacy-ai/orchestrator';

try {
  await launcher.launch({ intent: { kind: 'phase', ... }, cwd, provider: 'clade-code' });
} catch (err) {
  if (err instanceof UnknownProviderError) {
    console.error(`No provider "${err.provider}" registered. Available: ${err.availableProviders.join(', ')}`);
  } else {
    throw err;
  }
}

try {
  launcher.registerPlugin(new SomeSecondPluginForClaudeCodePhase());
} catch (err) {
  if (err instanceof DuplicatePluginRegistrationError) {
    console.error(`(${err.provider}, ${err.kind}) already owned by ${err.existingPluginId}`);
  } else {
    throw err;
  }
}
```

## What did NOT change

- Existing prod call sites (`ClaudeCliWorker`, `PrFeedbackHandler`, `ConversationSpawner`, `ClaudeCodeInvoker`) — none supply `provider`. All resolve to `'claude-code'`.
- Existing kinds — `phase`, `pr-feedback`, `validate-fix`, `merge-conflict`, `conversation-turn`, `invoke`, `generic-subprocess`, `shell` — all preserved verbatim.
- Argv assembly for every existing intent — byte-identical.
- Credential interceptor semantics — unchanged.
- Stdio profile selection — unchanged.
- `launcher-setup.ts` — no diff (plugins self-declare their provider).
- `.generacy/config.yaml` schema — unchanged (#814 owns that).

## Troubleshooting

**Argv snapshot diff**: The default-provider fallback path in `AgentLauncher.launch()` is not resolving `generic-subprocess` / `shell` to the `SYSTEM_PROVIDER`-registered plugin. Check `contracts/dispatch-contract.md` step 4b.

**`UnknownProviderError` on a call that used to work**: A call site is now supplying an explicit `provider` (e.g. via `LaunchRequest` spread) that doesn't match any registered plugin. Either omit `provider` (SC-005 preserves the default) or register a plugin under that provider.

**`DuplicatePluginRegistrationError` on startup**: Two plugins declare the same `(provider, kind)`. If both should coexist, one must move to a different `provider`. If one is stale, delete the registration.

**Type error: `Property 'provider' is missing on AgentLaunchPlugin`**: Add `readonly provider: string` to the plugin class. For internal launcher plugins, use `readonly provider = SYSTEM_PROVIDER` from `packages/orchestrator/src/launcher/constants.ts`.

## Related issues

- **#814** — Phase 1 issue 2: config surface for provider selection.
- **#892** — introduced `ValidateFixIntent`.
- **#898** — introduced `MergeConflictIntent`.
- Multi-agent provider plan (Codex + OpenCode) — Phase 1 issue 1 of 3.

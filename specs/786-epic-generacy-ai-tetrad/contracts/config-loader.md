# Contract: `loadCockpitConfig(options?)`

## Signature

```ts
interface LoadCockpitConfigOptions {
  cwd?: string;                                       // default: process.cwd()
  env?: NodeJS.ProcessEnv;                            // default: process.env
  whoami?: () => Promise<string | null>;              // default: parse `gh auth status`
  logger?: { warn: (msg: string) => void };           // default: console
}

function loadCockpitConfig(
  options?: LoadCockpitConfigOptions,
): Promise<LoadedCockpitConfig>;
```

## Output

```ts
interface LoadedCockpitConfig {
  config: CockpitConfig;                          // fully resolved (defaults applied)
  source: 'cockpit-block' | 'monitored-repos-env' | 'defaults';
  warnings: string[];                             // human-readable warnings emitted via logger.warn
}
```

## Behavior

1. Locate `.generacy/config.yaml` by walking upward from `cwd` (uses `findWorkspaceConfigPath` from `@generacy-ai/config`). If not found, treat as empty config (no `cockpit:` block).
2. Read + parse the YAML. If parsing fails, **throw** with the underlying `YAMLParseError` wrapped in a descriptive message.
3. Extract the `cockpit:` sub-key. If absent, treat as `{}`.
4. Validate with `CockpitConfigSchema`. If the block exists but is malformed (bad types, bad `owner/repo` regex), **throw** the Zod error.
5. Resolve `repos`:
   - If `cockpit.repos` is non-empty: use as-is. `source = 'cockpit-block'`.
   - Else, parse `env.MONITORED_REPOS` (comma-separated, trimmed, each must match `owner/repo`). If non-empty: use. `source = 'monitored-repos-env'`.
   - Else: `repos = []`. `source = 'defaults'`. Log warn: `"cockpit: no repos configured (set cockpit.repos in .generacy/config.yaml or MONITORED_REPOS env)"`. Push the same message into `warnings`.
6. Resolve `owner`:
   - If `cockpit.owner` is set: use as-is.
   - Else call `whoami()`. If non-null: use that.
   - Else leave `owner = undefined`. (Commands that need it must fail at use-time with a clear message — not the loader's responsibility.)
7. Resolve `orchestrator`:
   - `token`: `cockpit.orchestrator.token` ?? `env.ORCHESTRATOR_API_TOKEN` ?? `undefined`.
   - `baseUrl`: `cockpit.orchestrator.baseUrl` ?? `env.ORCHESTRATOR_URL` ?? `'http://127.0.0.1:3100'`.
8. Return `{ config, source, warnings }`.

## Error modes

| Failure                                                       | Behavior                                                                |
|---------------------------------------------------------------|-------------------------------------------------------------------------|
| `.generacy/config.yaml` does not exist                        | Treat as empty config; do not throw.                                    |
| YAML cannot be parsed (syntax error)                          | **Throw** wrapped `YAMLParseError`.                                     |
| `cockpit:` block fails Zod validation                         | **Throw** Zod issue (clear, includes path + reason).                    |
| `MONITORED_REPOS` contains an entry that fails `owner/repo`   | **Throw** with the offending entry.                                     |
| `gh auth status` fails (provider returns `null`)              | Continue; `owner` stays `undefined`. No throw.                          |
| Both `cockpit.repos` and `MONITORED_REPOS` unset/empty        | Warn + return `repos: []`. No throw.                                    |

## Test scenarios (SC-003)

1. **Full config** — explicit `cockpit:` block with `owner`, `repos`, `orchestrator.{baseUrl,token}` → all fields honored, `source: 'cockpit-block'`.
2. **Partial config** — `cockpit:` block sets only `owner`; `MONITORED_REPOS` provides repos → `source: 'monitored-repos-env'`.
3. **Missing config** — no `.generacy/config.yaml`, no `MONITORED_REPOS` → warns, returns `repos: []`, `source: 'defaults'`.
4. **Invalid config** — `cockpit.repos: ['no-slash']` → throws Zod error mentioning the regex.

## Invariants

- Loader never spawns `gh` when an explicit `owner` is provided in config (lazy resolution).
- Loader is async-safe — it can be called concurrently; each call is independent (no module-level state).

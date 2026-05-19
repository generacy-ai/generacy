# Contract: SubprocessAgency ↔ AgentLauncher

## LaunchRequest produced by SubprocessAgency

When `agentLauncher` is provided, `SubprocessAgency.connect()` calls:

```typescript
agentLauncher.launch({
  intent: {
    kind: 'generic-subprocess',
    command: this.command,        // from SubprocessAgencyOptions.command
    args: this.args,             // from SubprocessAgencyOptions.args ?? []
    stdioProfile: 'interactive', // selects ['pipe', 'pipe', 'pipe']
    // env: undefined            // omitted — no intent-level env
  },
  cwd: this.cwd ?? process.cwd(),
  env: this.env,                 // from SubprocessAgencyOptions.env
  // signal: undefined           // not used currently
})
```

## GenericSubprocessPlugin.buildLaunch() contract

### Input: GenericSubprocessIntent
```typescript
{
  kind: 'generic-subprocess',
  command: string,
  args: string[],
  env?: Record<string, string>,       // undefined from SubprocessAgency
  stdioProfile?: 'default' | 'interactive'  // 'interactive' from SubprocessAgency
}
```

### Output: LaunchSpec
```typescript
{
  command: intent.command,     // pass-through
  args: intent.args,          // pass-through
  env: intent.env,            // pass-through (undefined)
  stdioProfile: intent.stdioProfile ?? 'default'  // 'interactive'
}
```

## Env Merge Contract

AgentLauncher performs:
```typescript
mergedEnv = { ...process.env, ...launchSpec.env, ...request.env }
// With intent.env = undefined, launchSpec.env = undefined:
// mergedEnv = { ...process.env, ...request.env }
// = { ...process.env, ...this.env }
// Byte-identical to current SubprocessAgency behavior.
```

## ChildProcessHandle contract (from LaunchHandle.process)

SubprocessAgency uses these fields from the returned handle:

| Field | Type | Usage |
|-------|------|-------|
| `stdin` | `NodeJS.WritableStream \| null` | Write JSON-RPC messages |
| `stdout` | `NodeJS.ReadableStream \| null` | Read JSON-RPC responses |
| `stderr` | `NodeJS.ReadableStream \| null` | Log warnings |
| `kill()` | `(signal?) => boolean` | Disconnect / cleanup |
| `exitPromise` | `Promise<number \| null>` | Exit logging + spawn error propagation |

**Not used**: `pid`, `outputParser`, `metadata`

## Fallback Contract

| Condition | Behavior |
|-----------|----------|
| `agentLauncher === undefined` | Direct `child_process.spawn()` — current behavior |
| `agentLauncher` provided, `launch()` succeeds | Use ChildProcessHandle from LaunchHandle |
| `agentLauncher` provided, `launch()` throws | Error propagates to caller — NO silent fallback |

# Data Model: End-to-End Spawn Path Integration Test

## Core Types (existing — referenced by tests)

### LaunchRequest
```typescript
interface LaunchRequest {
  intent: LaunchIntent;              // discriminated union
  cwd: string;                       // working directory
  env?: Record<string, string>;      // caller env overrides (highest priority)
  signal?: AbortSignal;              // cancellation
  detached?: boolean;                // process group
}
```

### LaunchSpec (plugin output)
```typescript
interface LaunchSpec {
  command: string;                    // executable name
  args: string[];                     // command arguments
  env?: Record<string, string>;       // plugin env (middle priority)
  stdioProfile?: string;             // factory selector ('default' | 'interactive')
  detached?: boolean;
}
```

### Intent Types
```typescript
type LaunchIntent = GenericSubprocessIntent | ShellIntent | ClaudeCodeIntent;
type ClaudeCodeIntent = PhaseIntent | PrFeedbackIntent | ConversationTurnIntent | InvokeIntent;
```

### LaunchHandle (launcher output)
```typescript
interface LaunchHandle {
  process: ChildProcessHandle;
  outputParser: OutputParser;
  metadata: { pluginId: string; intentKind: string };
}
```

## Test-Specific Types (new)

### CaptureFile
The parsed content of the mock binary's capture file.

```typescript
// Not a formal interface — parsed from text file
interface CaptureFile {
  argv: string[];                     // arguments received by mock binary
  env: Record<string, string>;        // environment variables received
}
```

### Capture File Format
```
=== ARGV ===
<arg0>
<arg1>
...
=== ENV ===
<KEY1>=<value1>
<KEY2>=<value2>
...
```

## Relationships

```
Test Setup
  ├── creates mock `claude` binary in tmpdir
  ├── builds modified PATH (tmpdir prepended)
  └── creates capture/response file paths

Test Execution
  ├── LaunchRequest { intent, cwd, env: { PATH, MOCK_CLAUDE_CAPTURE_FILE, ... } }
  │     ↓
  ├── AgentLauncher.launch()
  │     ├── plugin.buildLaunch(intent) → LaunchSpec
  │     ├── 3-layer env merge
  │     └── factory.spawn() → ChildProcessHandle
  │           ↓
  └── Mock binary executes
        ├── writes argv/env → capture file
        └── writes response → stdout

Test Assertion
  ├── reads capture file
  ├── asserts argv matches expected command composition
  └── asserts env contains expected keys/values
```

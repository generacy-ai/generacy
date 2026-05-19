# Quickstart: End-to-End Spawn Path Integration Test

## Prerequisites

- Node.js 22+
- `python3` (for conversation-turn PTY wrapper test)
- `pnpm install` completed

## Running the Tests

```bash
# Run all orchestrator tests (includes the new e2e suite)
pnpm --filter @generacy-ai/orchestrator test

# Run only the spawn e2e test
pnpm --filter @generacy-ai/orchestrator exec vitest run src/launcher/__tests__/spawn-e2e.test.ts

# Run in watch mode during development
pnpm --filter @generacy-ai/orchestrator exec vitest src/launcher/__tests__/spawn-e2e.test.ts
```

## What It Tests

The suite exercises all spawn intent kinds through real `AgentLauncher` with real `child_process.spawn`:

| Intent Kind | Command | Factory | Key Verification |
|-------------|---------|---------|------------------|
| `phase` | `claude -p --output-format stream-json ...` | default | Phase command mapping, sessionId |
| `pr-feedback` | `claude -p --output-format stream-json ...` | default | Prompt passthrough |
| `conversation-turn` | `python3 -u -c <PTY_WRAPPER> claude ...` | interactive | PTY wrapper, model/permissions flags |
| `invoke` | `claude --print --dangerously-skip-permissions ...` | default | Raw command passthrough |
| `generic-subprocess` | `echo hello world` | default | Direct command execution |
| `shell` | `sh -c "echo marker"` | default | Shell wrapping |

## How the Mock Works

A shell script (`mock-claude.sh`) is placed in a temp directory as `claude`. The test prepends this directory to `PATH` so all `claude` invocations hit the mock instead of the real CLI.

The mock writes its argv and env to a capture file, which the test reads for assertions.

## Troubleshooting

**Test hangs**: The mock binary may not be executable. Check that `chmod +x` succeeded in `beforeAll`.

**conversation-turn skipped**: `python3` is not on PATH. Install Python 3.

**Capture file empty**: The process may have failed before the mock ran. Check `exitPromise` result and stderr output.

**Env assertion failures**: The 3-layer merge includes all of `process.env`. Assert only specific keys, not the full env object.

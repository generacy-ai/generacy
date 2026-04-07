# Quickstart: Orchestrator Job Lifecycle Events

## Prerequisites

- Node.js 20+
- pnpm
- Redis running (required for worker mode)
- `GENERACY_API_KEY` environment variable set (for relay connection)

## Installation

```bash
pnpm install
```

## Development

```bash
# Start in worker mode with relay enabled
GENERACY_API_KEY=your-api-key \
GENERACY_MODE=worker \
pnpm --filter @generacy-ai/orchestrator dev
```

## Testing

```bash
# Run orchestrator tests
pnpm --filter @generacy-ai/orchestrator test

# Run specific test files
pnpm --filter @generacy-ai/orchestrator test -- claude-cli-worker
pnpm --filter @generacy-ai/orchestrator test -- phase-loop
pnpm --filter @generacy-ai/orchestrator test -- relay-bridge
```

## Verifying Events

### Local Verification

1. Start the development stack:
   ```bash
   /workspaces/tetrad-development/scripts/stack start
   source /workspaces/tetrad-development/scripts/stack-env.sh
   ```

2. Start the orchestrator in worker mode with relay configured

3. Queue a test issue for processing

4. Check worker logs for event emission:
   ```
   INFO: Emitted job event {"event":"job:created","jobId":"..."}
   INFO: Emitted job event {"event":"job:phase_changed","jobId":"...","currentStep":"specify"}
   ```

### Dashboard Verification

Once events flow through the relay to the cloud API:
- Active workflows appear on the dashboard in real-time
- Workflow History tab shows completed/failed workflows
- Activity feed updates with lifecycle events
- Paused workflows show correctly when waiting at gates

## Troubleshooting

### Events not appearing on dashboard

1. Check worker logs for relay connection:
   ```
   INFO: Relay connected to cloud
   ```
   If missing, verify `GENERACY_API_KEY` is set.

2. Check for event emission logs:
   ```
   INFO: Emitted job event {"event":"job:created",...}
   ```
   If missing, the `jobEventEmitter` callback isn't wired.

3. If events are emitted but not on dashboard, check cloud API logs for `handleEvent()` processing.

### Relay connection fails in worker mode

- Events degrade gracefully — the `jobEventEmitter` is a no-op when relay is disconnected
- Worker continues processing jobs normally
- Events are lost (not queued) during disconnection

# Quickstart: Conversation Metadata JSONL Logging

## Prerequisites

- Node.js and pnpm installed
- Orchestrator package buildable: `pnpm build` in `packages/orchestrator`

## What Gets Built

A `ConversationLogger` class in the orchestrator that writes metadata JSONL files during workflow execution. After implementation, every speckit workflow phase will produce entries in `specs/{issue-number}/conversation-log.jsonl`.

## Key Files

| File | Role |
|------|------|
| `packages/orchestrator/src/worker/conversation-logger.ts` | New — ConversationLogger class |
| `packages/orchestrator/src/worker/conversation-logger.test.ts` | New — Unit tests |
| `packages/orchestrator/src/worker/output-capture.ts` | Modified — delegates events to logger |
| `packages/orchestrator/src/worker/phase-loop.ts` | Modified — creates logger, manages lifecycle |
| `packages/orchestrator/src/worker/types.ts` | Modified — JournalEntry type |
| `packages/orchestrator/src/worker/cli-spawner.ts` | Modified — threads logger through |

## Development

```bash
# Install dependencies
pnpm install

# Build the orchestrator
cd packages/orchestrator
pnpm build

# Run tests
pnpm test
```

## Verification

After implementation, trigger a speckit workflow on any issue. Check:

1. **File created**: `specs/{issue-number}/conversation-log.jsonl` exists after first phase
2. **Valid JSONL**: Each line parses as valid JSON
3. **Event types**: Look for `phase_start`, `tool_use`, `tool_result`, `phase_complete` entries
4. **Committed**: File is in the git commit alongside spec artifacts

```bash
# Parse and inspect the JSONL file
cat specs/378-phase-1-7-cloud/conversation-log.jsonl | jq .

# Count events by type
cat specs/378-phase-1-7-cloud/conversation-log.jsonl | jq -r .event_type | sort | uniq -c

# Check tool durations
cat specs/378-phase-1-7-cloud/conversation-log.jsonl | jq 'select(.duration_ms != null) | {tool_name, duration_ms}'
```

## Troubleshooting

| Issue | Check |
|-------|-------|
| No JSONL file created | Verify ConversationLogger receives specDir path from PhaseLoop |
| Empty file | Verify `flush()` is called at phase completion |
| Missing duration_ms | Verify tool_use events contain a tool call ID for pairing |
| Missing file_paths on tool_use | Only extracted for known tools (Read, Write, Edit, Glob, Grep) |
| Missing token counts | Best-effort — may not be available in Claude CLI output |

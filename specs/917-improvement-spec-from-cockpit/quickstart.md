# Quickstart: `generacy cockpit mcp`

## What it is

A stdio MCP server exposing the cockpit verb set as typed tools for Claude Code (or any MCP client). Registered user-scope inside the orchestrator container only. The CLI `generacy cockpit <verb>` stays canonical — this is an additional transport for interactive agent sessions.

## For agent sessions running inside the orchestrator

Nothing to do — the cluster-base entrypoint registers the server in `~/.claude.json` on container boot. Verify with:

```bash
claude mcp list
# ...
# cockpit    generacy cockpit mcp    user
# ...
```

Tools appear in the session under the `mcp__cockpit__*` namespace:

- `mcp__cockpit__cockpit_status`
- `mcp__cockpit__cockpit_context`
- `mcp__cockpit__cockpit_advance`
- `mcp__cockpit__cockpit_resume`
- `mcp__cockpit__cockpit_queue`
- `mcp__cockpit__cockpit_merge`
- `mcp__cockpit__cockpit_await_events`

## Usage examples

### Poll for events with batching

```jsonc
// Tool: cockpit_await_events
{
  "epic": { "owner": "generacy-ai", "repo": "generacy", "number": 917 }
}
// → { status: "ok", data: { events: [ /* batch */ ], cursor: "..." } }
```

Re-arm with the returned cursor:

```jsonc
{
  "epic": { "owner": "generacy-ai", "repo": "generacy", "number": 917 },
  "cursor": "<returned cursor>"
}
```

Detect `resetFrom: "expired"` and run your startup-sweep recovery if present:

```jsonc
// → { status: "ok", data: { events: [...], cursor: "...", resetFrom: "expired" } }
// Handle: some events may have been missed. Re-inspect epic state fully.
```

### Get status

```jsonc
{ "epic": "generacy-ai/generacy#917" }
// → { status: "ok", data: { owner, repo, issue, rows: [...] } }
```

### Advance a gate

```jsonc
// Tool: cockpit_advance
{
  "issue": { "owner": "generacy-ai", "repo": "generacy", "number": 917 },
  "gate": "clarification"
}
// → { status: "ok", data: { action: "advanced", completedLabel: "completed:clarification", commentUrl: "..." } }
```

If the active gate is different:

```jsonc
// → { status: "error", class: "gate-refusal", detail: "...is waiting on \"plan-review\"...", hint: "call cockpit_context first" }
```

### PR-number-as-issue rejection

```jsonc
// Tool: cockpit_context with a PR number
{ "issue": "generacy-ai/generacy#950" }  // #950 is a PR
// → { status: "error", class: "wrong-kind", detail: "generacy-ai/generacy#950 is a pull request; cockpit_context requires an issue" }
```

No engine round-trip, no diagnosis turn.

## Installation (existing clusters)

`generacy update` pulls the latest orchestrator image (which contains the updated entrypoint) and refreshes the compose file (which contains the `GENERACY_CLUSTER_ROLE` env var). Both together enable the MCP tool.

For fresh clusters via `generacy launch`, the tool is available from first boot.

## Troubleshooting

### `claude mcp list` shows no `cockpit` entry

Check:

1. `echo $GENERACY_CLUSTER_ROLE` — should print `orchestrator` inside the orchestrator container.
2. Look at container stdout at boot for the `[entrypoint] registered cockpit MCP server` line.
3. `cat ~/.claude.json | jq '.mcpServers.cockpit'` — should print `{"command": "generacy", "args": ["cockpit", "mcp"]}`.

If the env var is missing, the compose file is out of date (`generacy update` didn't run or failed).

If the env var is set but no registration log appeared, the cluster-base image is older than the companion change — pin to a newer image tag.

### `generacy cockpit mcp` exits immediately with role error

The command refuses to start when `GENERACY_CLUSTER_ROLE=worker`. You're running it in a worker container. This is intentional — the MCP server is orchestrator-only.

### Tool calls fail with `class: "invalid-cursor"`

Two sub-cases:

- **Malformed / never-issued**: your caller code is corrupting the cursor string. It's an opaque token — pass it through verbatim from the previous response.
- **`resetFrom: "expired"`** (this is `status: "ok"`, not an error, despite the name): the server dropped your cursor's position from its retention buffer. Retention is 10 minutes / 10 000 events by default. This happens on server restart or when a consumer stalls for longer than retention. Engage your startup-sweep recovery.

### Events not batching as expected

Defaults are `maxWaitMs=55000`, `coalesceWindowMs=3000`, `maxBatchSize=256`. Override per-call:

```jsonc
{
  "epic": { /* ... */ },
  "maxWaitMs": 10000,       // shorter wait → more idle wakeups
  "coalesceWindowMs": 500,  // tighter coalesce → smaller batches
  "maxBatchSize": 50
}
```

### Tool result shape unclear

Every tool result is one of:

```jsonc
{ "status": "ok", "data": { /* tool-specific */ } }
// or
{ "status": "error", "class": "<one of>", "detail": "<human-readable>", "hint": "<optional>" }
```

Error `class` values: `invalid-args`, `wrong-kind`, `unknown-gate`, `not-an-epic`, `gate-refusal`, `invalid-cursor`, `transport`, `internal`.

## For CLI users

`cockpit watch` NDJSON output is unchanged (spec § Out of scope). Continue using it for shell scripts, humans watching `less`, etc.

The MCP transport is for interactive agent sessions (Claude Code) — it produces no NDJSON, only tool responses. It shares the *event source* with `cockpit watch`, so events observed on both surfaces are the same underlying transitions.

## For developers hacking on the server

Local dev outside a cluster:

```bash
cd packages/generacy
pnpm build
node ./dist/cli/index.js cockpit mcp
# Reads JSON-RPC on stdin; writes on stdout. Ctrl-C to quit.
```

To exercise the tools, pipe a JSON-RPC request in:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node ./dist/cli/index.js cockpit mcp
```

For interactive testing use the `@modelcontextprotocol/inspector` browser tool pointed at the local binary. See MCP docs for details.

## Available cockpit CLI commands (unchanged)

- `generacy cockpit status <epic-ref>` — one-shot table snapshot
- `generacy cockpit watch <epic-ref>` — streaming NDJSON events
- `generacy cockpit context <issue>` — active gate + bundle
- `generacy cockpit advance <issue> --gate <name>` — flip a gate
- `generacy cockpit resume <issue>` — re-arm a failed phase
- `generacy cockpit queue <epic-ref> <phase>` — enqueue phase's issues
- `generacy cockpit merge <pr-ref>` — merge on green checks
- **`generacy cockpit mcp`** — start the stdio MCP server (new)

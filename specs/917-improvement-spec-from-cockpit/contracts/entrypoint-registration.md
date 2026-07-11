# Contract: Orchestrator entrypoint MCP registration

The cluster-base companion PR (out of tree — separate repo) owns writing `~/.claude.json` in the orchestrator container to register the `cockpit` MCP server.

## Registration form

**Preferred**: use `claude mcp add --scope user` (the official Claude Code CLI):

```bash
claude mcp add \
  --scope user \
  cockpit \
  -- generacy cockpit mcp
```

**Fallback if the CLI is unavailable at entrypoint time**: write the config file directly. The user-scope config lives at `${HOME}/.claude.json` inside the orchestrator container. Merge the `mcpServers.cockpit` key:

```json
{
  "mcpServers": {
    "cockpit": {
      "command": "generacy",
      "args": ["cockpit", "mcp"]
    }
  }
}
```

Both paths must produce equivalent config.

## Idempotence (Q4-A)

The entrypoint runs on every container boot. On boot:

1. Read `${HOME}/.claude.json` (or `claude mcp list --scope user` if using the CLI path).
2. If a `cockpit` entry exists with `command === "generacy"` AND `args === ["cockpit", "mcp"]`:
   - No-op. Do not log.
3. If a `cockpit` entry exists with any other command/args:
   - **Overwrite unconditionally** (Q4-A).
   - Emit one log line to stderr:
     ```
     [entrypoint] reconciled cockpit MCP entry: prior command "<prior>", now "generacy cockpit mcp"
     ```
4. If no `cockpit` entry exists:
   - Write the entry.
   - Emit one log line to stderr:
     ```
     [entrypoint] registered cockpit MCP server (user scope)
     ```

**No relay event** in v1 (Q4-A rationale): no cloud consumer for a `cluster.bootstrap` reconciliation event yet.

## Worker entrypoint

**MUST NOT register the MCP server.** `entrypoint-worker.sh` adds no MCP-related steps. SC-004 (regression test path) asserts:

- `claude mcp list --scope user` inside a worker container returns no `cockpit` entry.
- Running `generacy cockpit mcp` inside a worker container exits non-zero with the role-refusal message (defense-in-depth check on `GENERACY_CLUSTER_ROLE=worker`).

## Merge order

Two-step ship:

1. **This PR (generacy repo)** — ships `generacy cockpit mcp` command and `GENERACY_CLUSTER_ROLE=*` scaffolder env writes. Command is inert on clusters until step 2 registers it. Newly-scaffolded clusters (via `generacy launch`) get the env vars immediately; existing clusters get them on their next `generacy update` compose refresh.
2. **Cluster-base companion PR** — modifies `entrypoint-orchestrator.sh` to run the registration step. Ships to the next `cluster-base` release channel; existing clusters pick it up on next `generacy update`.

Between steps 1 and 2, orchestrators run with the env var set but no MCP registration → no behavior change. Auto sessions continue to use the CLI.

## Role env var invariants (Q2-A drift hazard)

The scaffolder change in this PR MUST be mirrored in `packages/cloud-deploy/` (separate repo — `generacy-ai/generacy-cloud`) compose generation:

- `GENERACY_CLUSTER_ROLE=orchestrator` on orchestrator service
- `GENERACY_CLUSTER_ROLE=worker` on worker service

If cloud-deploy drifts (doesn't set the env var), orchestrator boots with `GENERACY_CLUSTER_ROLE=undefined`, which the `cockpit mcp` refusal check treats as "not a worker" → server starts normally. That's the safe drift direction. Reverse drift (worker service missing the env var) means the defense-in-depth check fails open — the primary control (worker entrypoints not registering the server) still holds.

Tracked as companion cloud-deploy issue: TBD (`GENERACY_CLUSTER_ROLE` env var addition, cloud-deploy).

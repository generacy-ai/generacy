---
"@generacy-ai/generacy": minor
---

Add a `generacy cockpit mcp` server that exposes the cockpit verbs as MCP tools
(#917). The new stdio MCP server registers `cockpit_advance`, `cockpit_context`,
`cockpit_merge`, `cockpit_queue`, `cockpit_resume`, `cockpit_status`, and
`cockpit_await_events`, mirroring the CLI surface so an agent can drive an epic
over MCP with the same ref-input parsing, schemas, and exit semantics. It ships
an event-bus (with a per-process registry) backing `cockpit_await_events` for
streaming state transitions, keeps stdout clean for the JSON-RPC transport, and
refuses to start under a worker cluster role.

Also teaches the cluster scaffolder to emit `GENERACY_CLUSTER_ROLE`
(`orchestrator` / `worker`) into the scaffolded docker-compose so the role the
MCP server checks is present on freshly scaffolded clusters.

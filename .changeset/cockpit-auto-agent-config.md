---
"@generacy-ai/cockpit": minor
"@generacy-ai/orchestrator": minor
"@generacy-ai/generacy-plugin-claude-code": minor
---

Cockpit auto model/effort configuration + effort on conversation launches.

`@generacy-ai/cockpit`: `CockpitConfigSchema` gains an optional `auto` block
(`cockpit.auto` in `.generacy/config.yaml`) for the `/cockpit:auto` run loop —
`loop` (model/effort for the loop session, consumed by headless launchers),
`heartbeatSeconds` (base heartbeat interval, 60–3600), `quiet` (suppress
transcript narration for headless runs), and `agents` (per-role
`{ provider?, model?, effort? }` selectors for the clarifier / reviewer /
validator / fixer / diagnoser analysis subagents, mirroring the orchestrator's
`AgentEntrySchema`). An invalid `auto` block degrades to a loader warning and
is ignored, so it can never break `owner`/`assignee` consumers.

`@generacy-ai/orchestrator` + `@generacy-ai/generacy-plugin-claude-code`:
`ConversationTurnIntent` / `POST /conversations` gain an optional `effort`
field, threaded through `ConversationManager`/`ConversationSpawner` to
`claude --effort <level>` — the phase path already supported effort; the
conversation path (used for headless slash-command launches like
`/cockpit:auto`) now does too.

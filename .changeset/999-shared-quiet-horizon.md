---
"@generacy-ai/generacy": patch
---

Raise the cockpit MCP event-bus retention window and registry idle-TTL defaults
from 10 min to 120 min, expressed as a single shared exported constant
(`DEFAULT_QUIET_HORIZON_MS`) in
`packages/generacy/src/cli/commands/cockpit/mcp/event-bus.ts` so the two
horizons cannot silently desync (FR-001 / FR-002 / FR-003, #999). Fixes
`resetFrom:"discarded"` / `"expired"` cursor recoveries during long quiet
implementation phases of `/cockpit:auto`. Env-var override surface
(`COCKPIT_MCP_BUS_IDLE_TTL_MS`, `COCKPIT_MCP_EVENT_RETENTION_MS`) and
constructor/options seams unchanged; `retentionCount = 10_000` unchanged.

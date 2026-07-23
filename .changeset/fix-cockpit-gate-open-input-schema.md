---
"@generacy-ai/generacy": patch
---

fix(cockpit-mcp): give `cockpit_gate_open` a real input schema so `--gates=ui` stops 401/invalid-args'ing. `GateRecordSchema` was a `z.record().and(z.object({}).passthrough())` intersection, which has no `.shape` — so the MCP SDK advertised an **empty** input schema for the tool. With no declared property types, the tool-call boundary stringified the typed `generation` (number) and `scope` (object) fields, and the orchestrator's authoritative `GateOpenSchema` rejected the envelope as `invalid-args`. Replace it with a flat `z.object({...}).passthrough()` that types the fields (mirroring `GateOpenSchema`, but leniently so it never rejects an envelope the orchestrator would accept). Adds a regression pin.

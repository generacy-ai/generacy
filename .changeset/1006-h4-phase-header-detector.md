---
"@generacy-ai/cockpit": minor
"@generacy-ai/generacy": minor
---

Detect LLM-authored epics with `####` phase headers as a loud warning (#1006).

`@generacy-ai/cockpit`: `parseEpicBody` now emits a `warnings[]` entry containing
the stable marker substring `phase headers must be '###'` when an epic body has
zero-populated phases, non-empty ad-hoc refs, and at least one phase-shaped
`####` heading (e.g. `#### P1 — …` or `#### Phase 2`). Turns a silent
`/cockpit:auto` stall into an immediate, actionable signal.

`@generacy-ai/generacy`: `cockpit status --json` envelope and `cockpit_status`
MCP tool `data` payload gain an additive `warnings: string[]` field, verbatim
from `parsed.warnings` (empty array on clean bodies). Non-breaking: existing
consumers that read only `scope` and `rows` continue to work.

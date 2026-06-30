---
"@generacy-ai/generacy": minor
"@generacy-ai/cockpit": minor
---

Add journal-based stuck detection to `generacy cockpit status`/`watch` (#793).

The cockpit now reads `.agency/conversations/{n}/journal.jsonl` and flags
`agent:in-progress` issues whose journal has been stale beyond a configurable
threshold, surfacing them in the status table and watch output. Adds a journal
reader and stuck-detection config (loader/schema/types) to `@generacy-ai/cockpit`,
plus the status/watch wiring in the `generacy` CLI.

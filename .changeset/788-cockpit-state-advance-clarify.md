---
"@generacy-ai/generacy": minor
"@generacy-ai/cockpit": minor
---

Add `generacy cockpit state`, `cockpit advance`, and `cockpit clarify-context` verbs (#788).

`state` classifies one issue and prints its curated cockpit tier; `advance`
manually flips a waiting gate (waiting-for → completed); `clarify-context`
gathers JSON context for the open clarification request. Also export
`nodeChildProcessRunner` (and its `CommandRunnerOptions`/`CommandResult` types)
from `@generacy-ai/cockpit` so CLI verbs reuse the foundation's default
`CommandRunner` instead of importing `node:child_process` directly.

---
"@generacy-ai/orchestrator": patch
---

Fix ClarificationAnswerMonitorService resuming on its own bot comments (#993).

The monitor's answer predicate now filters `[bot]`-suffix authors upstream of
the trust helper, and only accepts a candidate whose `created_at` is strictly
newer than the latest question-marker comment on the issue. `matchMachineMarker`
gains a `MACHINE_MARKER_FAMILIES` prefix pass so every `<!-- generacy-stage:*`
and `<!-- speckit-stage:*` marker (including the previously-missed
`<!-- speckit-stage:clarification`) is skipped without a code change.

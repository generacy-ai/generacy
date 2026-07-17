---
"@generacy-ai/generacy": minor
---

Add `generacy cockpit doorbell <epic-ref>` — a wake-sensor CLI verb for
`/cockpit:auto` (agency#431). The verb spawns as a background sensor,
constructs its own in-process refcounted `EpicEventBus` via `acquireEpicBus`,
and emits one newline-terminated stdout line per bus event (the event `type`
word: `issue-transition`, `phase-complete`, `epic-complete`) plus an initial
out-of-band `armed` line. Three arming forms: `doorbell <epic-ref>`,
`doorbell <tracking-ref> --tracking`, `doorbell --new "<title>"`. Optional
`--exit-on-epic-complete` mirrors `cockpit watch`. Unblocks auto-drive wake
latency, which was silently degrading to the 5-min `ScheduleWakeup` heartbeat
because the skill's arm-command was returning `error: unknown command
'doorbell'`.

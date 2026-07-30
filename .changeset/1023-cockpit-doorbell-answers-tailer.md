---
"@generacy-ai/generacy": minor
---

Add answers-file tailer to `generacy cockpit doorbell` (#1023). The doorbell now tails `/workspaces/.generacy/cockpit/answers.ndjson` alongside its smee subscription and poll-fallback subscriber, waits for the parent dir / file to appear (never `mkdir`s), replays existing content on start (capped at the last 10 000 lines, aligned with the in-process event-bus retention), and handles rotation + truncation via inode + size tracking. Each validated line is emitted as a new `{"type":"gate-answer",…}` variant on `CockpitStreamEvent` — surfaces on both stdout NDJSON (harness `Monitor` wake path) and the per-epic in-process bus (`cockpit_await_events` wake path). Lines from other epics are dropped with an `info` log naming the `gateId`; malformed lines are skipped with `warn`. The stream continues on errors and stdout stays event-only. Consumers dispatching on `event.type` should add a `case 'gate-answer'` arm.

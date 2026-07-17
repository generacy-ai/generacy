---
"@generacy-ai/generacy": patch
---

fix(cockpit): treat GitHub rate-limit errors as retriable in the doorbell startup-retry classifier

`classifyGhError` did not recognize GitHub rate-limit errors — the GraphQL primary limit surfaces as plain text (`API rate limit already exceeded …`) with no `HTTP 429` marker, and the secondary/abuse limit arrives as `HTTP 403` — so both fell through to `permanent`, causing `generacy cockpit doorbell` to `exit(3)` instead of retrying. Because rate-limiting is the dominant transient `gh` failure on a shared token, a rate-limited `acquireEpicBus`/`resolveEpic` would kill the wake sensor mid-run and drop `/cockpit:auto` to the 5-minute heartbeat. Primary, secondary, and abuse-detection rate-limit messages are now classified retriable, matched before the permanent 401/403 rules so a 403 secondary limit is no longer mistaken for a scope error.

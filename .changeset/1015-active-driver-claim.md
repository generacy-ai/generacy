---
"@generacy-ai/generacy": minor
"@generacy-ai/cockpit": minor
---

Add `cockpit_claim` + `cockpit_release` MCP tools for per-scope active-driver claim (#1015). Two concurrent `/cockpit:auto` conversations can no longer silently double-drive the same scope: the claim is stored as an `<!-- cockpit:claim v1 -->` marker comment on the scope issue (source of truth) plus a `cockpit:claimed` label (enumeration index). Claim is idempotent (acquire / refresh / takeover) with a 10-minute absolute staleness threshold. Refusal payload carries the incumbent's full `holder` claim + `commentUrl` so the calling skill can render an actionable gate without a second GitHub call. `@generacy-ai/cockpit` gains two `GhWrapper` methods — `editIssueComment` and `deleteIssueComment` — plus an `id: number` field on `IssueComment` (REST-numeric comment id extracted from the URL). Observer tools (`cockpit_status`, `cockpit_context`, `cockpit_await_events`) are structurally unable to touch the claim (verified by regression test).

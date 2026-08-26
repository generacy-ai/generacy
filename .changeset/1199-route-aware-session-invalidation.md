---
"@generacy-ai/orchestrator": patch
---

Route-aware CLI-session invalidation + transition logging (#1199).

The phase loop already dropped the CLI session on a **provider** change; it now
also tracks the launch **route** (`'subscription' | 'gateway'`, derived from the
resolved model via `resolveRoute` in `@generacy-ai/generacy-plugin-claude-code`).
When the route flips between phases — even with an unchanged provider — the
session is invalidated (crossing the CLI config-dir boundary) and an
`agent.route.transition` line is logged with `{ phase, prevRoute, nextRoute,
prevModel, nextModel }`. A simultaneous provider + route change logs both lines
and drops the session once; the first CLI phase (`undefined → route`) only
initializes the tracker (no line, no drop).

The resolved route is also surfaced verbatim in the spawn/launch log payloads of
the phase spawner and the four direct callers (PR-feedback, review, remediate,
merge-conflict). No new public exports, no new label vocabulary, and no change to
launch options — `route` is a log/session-tracking field only.

---
"@generacy-ai/generacy": minor
"@generacy-ai/cockpit": minor
---

Add orchestrator API status tier to `generacy cockpit status`/`watch` (#792).

The cockpit now queries the orchestrator API (`/queue`, `/workflows`) for queue
depth and active-worker counts and surfaces them in the status footer and watch
output. Adds an orchestrator client in `@generacy-ai/cockpit`, plus shared
token-resolution, footer-rendering, and warning helpers in the `generacy` CLI.
Degrades gracefully when the orchestrator auth token is absent.

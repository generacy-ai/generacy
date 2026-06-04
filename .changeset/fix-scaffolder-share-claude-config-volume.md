---
"@generacy-ai/generacy": patch
---

Share the `.claude` directory volume between orchestrator and workers in scaffolded clusters.

The generated compose mounted only `~/.claude.json` (a file) and no shared
`/home/node/.claude` directory volume, so workers never inherited the
orchestrator's Claude auth, speckit slash-commands, or conversation history.
Every spec-kit phase launched an unauthenticated Claude CLI, exited "Not logged
in" in <1s, and the phase runner committed an empty phase — producing PRs with
phase commits but no real artifacts.

Align the generated compose with the canonical cluster-base layout: add a shared
`claude-config:/home/node/.claude` volume on both services, stop mounting
`workspace` on the worker (per-job checkouts are container-local), and mount
`shared-packages` read-only on the worker. Only the `.claude` directory is
volume-mounted — never the `.claude.json` file path (preserving the #737 fix).

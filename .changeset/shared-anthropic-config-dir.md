---
"@generacy-ai/generacy": patch
---

Scaffolded cluster compose now sets `ANTHROPIC_CONFIG_DIR=/home/node/.claude/anthropic-config` on the orchestrator and every worker. Claude Code keeps its OAuth credentials in `~/.config/anthropic`, which is outside `~/.claude`, so the shared `claude-config` volume no longer carried the login on its own: workers spawned an unauthenticated CLI and each phase exited "Not logged in" in <1s while the phase runner committed an empty phase. Relocating that store into the shared volume restores one login for the whole cluster.

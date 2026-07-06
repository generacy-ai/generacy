---
"@generacy-ai/generacy": minor
---

Wire the `@generacy-ai/claude-plugin-cockpit` commands into Claude Code during
`generacy setup build` (#816). The setup build now resolves the cockpit
commands directory using the same 4-tier lookup as speckit (local workspace →
shared packages volume → npm global) and copies its `*.md` command files into
`~/.claude/commands/cockpit/`, so the `/cockpit:*` commands are available
alongside `/speckit:*`. When the plugin package is not installed, the build logs
a warning listing the paths checked instead of failing.

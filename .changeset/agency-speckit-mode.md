---
"@generacy-ai/generacy": patch
---

`generacy setup build` now registers the agency MCP server with `--mode speckit`, scoping worker sessions to the 11 tools the speckit playbooks actually use (~6 KB of tool definitions per session instead of ~26 KB / 49 tools in agency's default coding mode). The mode and flag ship in agency ≥ the PR pairing this change; older agency CLIs ignore unknown argv, so mixed versions degrade gracefully to today's behavior.

---
"@generacy-ai/workflow-engine": minor
"@generacy-ai/orchestrator": patch
---

Spec-stage phase commits (`specify`/`clarify`/`plan`/`tasks`) now exclude and revert repo-root
agent-context files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`),
so a prompt regression can never re-bloat them through a worker-produced commit. Adds
`GitHubClient.revertPaths()`. Also removes the dead #899 Layer-1 static-grep drift guard (it
watched a code path cluster workers never execute).

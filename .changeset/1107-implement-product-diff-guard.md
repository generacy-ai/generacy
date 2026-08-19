---
"@generacy-ai/workflow-engine": minor
"@generacy-ai/orchestrator": patch
---

Tighten the implement-phase "produced no product-code changes" guard so it can no longer be structurally defeated on speckit branches (#1107).

`@generacy-ai/workflow-engine` gains two local-git `GitHubClient` methods: `getCurrentCommitSha()` (`git rev-parse HEAD`) and `getFilesChangedByOwnCommits(startRef)` (`git log --first-parent --no-merges --name-only <startRef>..HEAD`), which isolate the files a branch's own commits touched — immune to base-merge-introduced and earlier-phase files.

`@generacy-ai/orchestrator` now (a) excludes the spec-kit `update_agent` targets (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`) by exact root-relative filename via a new `EXCLUDED_EXACT_PATHS` set, and (b) measures a phase-scoped diff window anchored to a start ref captured after the pre-implement base merge and persisted in Redis (via new `PhaseTrackerService` raw string get/set/clear) so it spans all pre-restart increments. The pass/fail surface, escalation path, and detection-failure fallback are unchanged.

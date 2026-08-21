---
"@generacy-ai/orchestrator": patch
"@generacy-ai/generacy-plugin-claude-code": patch
"@generacy-ai/workflow-engine": minor
---

Fix validate-origin remediation to consume the shared remediation budget and have a reliable stop. Both validate-origin and review-origin remediations now converge on the single `RemediateExecutor` (each dispatch bumps `remediationCount`), so the `on-remediation-limit` gate is reachable on the validate path. The validate failure fingerprint reason is now stable across test-output nondeterminism, and the executor reports a `timedOut` signal so partial work from a timeout-kill is committed while a clean-run non-zero exit leaves the branch untouched. When a clean-run non-zero exit skips the remediate commit, the working tree is now reverted (hard-reset + clean, preserving `.generacy/`) via the new `GitHubClient.discardWorkingTreeChanges()` method so the abandoned partial fix cannot be committed by the subsequent review phase. Retires the `ValidateFixHandler` adapter and the `validate-fix` launch intent.

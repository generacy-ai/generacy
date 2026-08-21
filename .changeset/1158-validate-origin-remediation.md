---
"@generacy-ai/orchestrator": patch
"@generacy-ai/generacy-plugin-claude-code": patch
---

Fix validate-origin remediation to consume the shared remediation budget and have a reliable stop. Both validate-origin and review-origin remediations now converge on the single `RemediateExecutor` (each dispatch bumps `remediationCount`), so the `on-remediation-limit` gate is reachable on the validate path. The validate failure fingerprint reason is now stable across test-output nondeterminism, and the executor reports a `timedOut` signal so partial work from a timeout-kill is committed while a clean-run non-zero exit leaves the branch untouched. Retires the `ValidateFixHandler` adapter and the `validate-fix` launch intent.

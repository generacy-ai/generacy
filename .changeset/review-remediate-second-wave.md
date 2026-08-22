---
"@generacy-ai/orchestrator": patch
"@generacy-ai/workflow-engine": patch
---

Fix the second wave of review/remediate regressions found in the post-merge review of #1153: narrow the resume-strip retain set (clarification/sibling-review/ci answers are stripped again; only remediation-limit and, under the CI gate, implementation-review survive), trust actions-runs CI green and post an honest, deduped CI-pause comment, dedupe the remediation-limit comment against issue comments, clear the Redis remediation budget on completion and at the on-ci-green approval pause, mark validate-origin/body-only findings `synthetic` so the verification pass can resolve them, gate resolution-scoped reviews on scope consumption instead of "no prior artifact", preserve engine sidecars across `git clean` while never committing them (PrManager and the legacy feedback handler), expand untracked directories in `getStatus`, and reclassify fail-then-pass infra failures against real vitest/pnpm output with a per-package fallback.

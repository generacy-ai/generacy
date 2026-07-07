---
"@generacy-ai/workflow-engine": patch
"@generacy-ai/orchestrator": patch
---

Author-trust gating for workflow-ingested GitHub comments (#842).

Three ingestion surfaces — the clarify answer-scanner, the clarify resume prompt,
and the PR-feedback reader — previously treated every human-authored comment on an
issue or PR as trusted agent input, with no filter on who wrote it. On a public
repo this is a live prompt-injection / supply-chain vector: a drive-by account
(`author_association: NONE`) can attach "apply this patch" or a hostile link and
have an autonomous worker ingest it as requirements or context. A new shared
comment-trust helper now gates ingestion by `author_association`: `OWNER`,
`MEMBER`, and `COLLABORATOR` are trusted by default; `NONE`,
`FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `MANNEQUIN`, and `CONTRIBUTOR` are
excluded from agent context. The `gh` client and `Comment` type now carry
`author_association` so the decision is possible, an untrusted-data fence wraps
comment bodies that still reach a prompt, and each skipped comment is logged with
author, tier, comment ID, and surface (metadata only — no body content) so a
repo owner can widen the allowlist deliberately via config rather than silently
lose a legitimate collaborator's answer. All three surfaces share the one trust
helper rather than three parallel implementations.

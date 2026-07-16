---
"@generacy-ai/orchestrator": minor
"@generacy-ai/generacy": minor
"@generacy-ai/workflow-engine": patch
---

Authorship-gated clarification answer scanner, quote-safe parser, and
reply-only resume monitor. Replaces the content-sniffing L488 branch in
`clarification-poster.ts` (which fails both directions — bot self-answers
its own gate; developer quote-replies get silently discarded) with
`viewerDidAuthor`-based authorship + a new engine-written answer marker
family. Cluster-self-authored comments are answer sources only when they
carry `<!-- generacy-clarification-answers:<batch> -->`, stamped
exclusively by the new `cockpit_relay_clarify_answers` MCP tool. Adds
`ClarificationAnswerMonitorService` (mirror of `MergeConflictMonitorService`)
so a plain reply resumes the paused gate. `hasPendingClarifications` fails
closed on missing dir / unreadable file / parse failure. Prompt template,
parser, write-back regex, and cockpit tool now share `PENDING_ANSWER_LITERAL`
via `@generacy-ai/workflow-engine`, making prompt/parser drift structurally
impossible. See #958.

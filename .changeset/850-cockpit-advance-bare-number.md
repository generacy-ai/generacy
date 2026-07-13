---
"@generacy-ai/generacy": patch
---

Fix `cockpit advance`/`context` rejecting bare issue numbers with stale error copy (#850).

`cockpit advance <ref>` and `cockpit context <ref>` called `parseIssueRef`
directly instead of the shared `resolveIssueContext` wrapper, so they violated
the unified issue-ref grammar: bare numbers were rejected and the rejection
message pointed at the removed `cockpit.repos` config. Both verbs now route
through `resolveIssueContext`; the bare-number gate moves out of `parseIssueRef`
(narrowed to a strict qualified-forms-only parser, marked `@internal`) into
`resolveIssueContext`, and the error copy no longer references `cockpit.repos`.
A new ESLint `no-restricted-imports` rule blocks direct `parseIssueRef` imports
from cockpit command files, pointing callers at `resolveIssueContext`.

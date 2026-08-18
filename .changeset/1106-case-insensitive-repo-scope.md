---
"@generacy-ai/generacy": patch
---

Cockpit doorbell: compare gateKey/epicRef owner and repo case-insensitively (#1106).

GitHub owner/repo names are case-insensitive, but the AnswersFileSource repo-scope
filter compared them with a raw `!==`. On multi-repo clusters this silently dropped
every child-issue gate answer whose canonical casing differed from the bound epic
ref, so the /cockpit:auto doorbell never fired. Both sides of the owner/repo
comparison are now lowercased; issue-number matching and foreign-repo drop behavior
are unchanged.

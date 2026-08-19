---
"@generacy-ai/generacy": patch
---

Cockpit doorbell + scope + queue: compare owner/repo case-insensitively (#1106).

GitHub owner/repo names are case-insensitive, but four sites in the cockpit
consumer path compared them with a raw `!==`, silently dropping legitimate
work whenever operator-typed and GitHub-canonical casings differed:

- `AnswersFileSource` repo-scope filter — dropped child-issue gate answers so
  the /cockpit:auto doorbell never fired.
- `webhookToStreamEvent` + `SmeeDoorbellSource#buildRefSet` — every
  `issues`/`pull_request`/`check_run` webhook returned null when the epic body
  and the payload disagreed on casing, so the smee doorbell never fired at all.
- `applyScopeMutation` (`lineMatchesRef`) — `cockpit_scope_add` produced
  duplicate task-list entries; `scope remove` was a silent no-op.
- `cockpit queue` (`classifyRow`, phase loop, `pickTargetRepo`) — mixed-case
  refs were treated as separate repos or classified `cross-repo`, so no issue
  was ever labeled or assigned.

All four sites now normalize owner/repo to lowercase before comparison. Issue
numbers, gate keys, gate ids, free-text, file paths, and drop-log lines are
unchanged. Emitted event `repo`/`url` fields still use the payload's original
casing.

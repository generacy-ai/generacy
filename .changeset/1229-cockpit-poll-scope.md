---
"@generacy-ai/cockpit": minor
"@generacy-ai/generacy": patch
---

Cockpit poll path scopes events to the epic's resolved ref set: replace the free-text `gh search issues` query with an exact aliased-GraphQL `issueOrPullRequest(number:)` lookup (`GhWrapper.batchLookupIssuesOrPrs`) plus a defensive post-filter, so foreign issues no longer leak onto the epic event bus and PR refs are no longer hidden (#1229).

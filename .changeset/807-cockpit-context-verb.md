---
"@generacy-ai/cockpit": minor
"@generacy-ai/generacy": minor
---

Collapse the cockpit CLI surface to the rev 3 catalog (#807, S3). Merges the
`state`, `clarify-context`, and `review-context` verbs into a single
`generacy cockpit context <issue>` verb that classifies the issue's current gate
and emits the bundle that gate needs (clarification comment + spec/plan + code
refs for clarification; PR metadata + diff + checks for
implementation-review/merge preflight; artifact paths for spec/plan/tasks
review). Folds the CLI-local `gh-ext.ts` (`CockpitGh`) into the engine's single
`@generacy-ai/cockpit` gh wrapper and collapses the three ref/scope resolvers
(`shared/scoping.ts`, `shared/resolve-context.ts`, `issue-ref.ts`) into one
module. `advance` and `merge` behavior and the exit-code convention
(0 success / 1 gh-IO / 2 usage / 3 gate refusal) are unchanged.

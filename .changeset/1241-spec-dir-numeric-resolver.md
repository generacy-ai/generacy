---
"@generacy-ai/workflow-engine": minor
"@generacy-ai/orchestrator": patch
"@generacy-ai/generacy": patch
---

Resolve zero-padded `specs/NNN-…` directories by issue number (#1241).

spec-kit names feature directories with a zero-padded leading number
(`specs/006-foo` for issue 6), but the implement→continue tasks.md safety net
and five sibling call sites resolved the spec dir by string-prefix matching
`${issueNumber}-`. For any issue below 100 the prefix never matched, so the
safety net returned `unreadable` and the phase loop failed open — a partial
implement advanced as if complete.

`@generacy-ai/workflow-engine` now exports a shared, pure numeric resolver
(`matchSpecDir`, `findSpecDirName`, `SpecDirMatch`) that compares the numeric
value of the leading `^(\d+)-` segment, prefers an exact non-padded directory,
and reports ambiguity when more than one padded directory resolves to the same
issue. `@generacy-ai/orchestrator` (`evaluateTasksMd`, `epic-post-tasks`,
`clarification-poster`) and `@generacy-ai/generacy` (`cockpit context`) resolve
spec dirs through it, as do the engine's own preflight / get-context /
post-tasks-summary actions. Branch-name `startsWith` checks are unchanged.

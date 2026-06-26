---
"@generacy-ai/generacy": minor
"@generacy-ai/cockpit": minor
---

Add `generacy cockpit watch` and `generacy cockpit status` verbs (#787).

`watch` polls the epic's issues/PRs and emits structured cockpit events on state
transitions; `status` renders a grouped, colorized table of the epic's current
phase/state. Backed by shared scoping, pagination, issue-classification, and
`gh` wrapper helpers in `@generacy-ai/cockpit`.

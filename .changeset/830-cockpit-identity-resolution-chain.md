---
"@generacy-ai/generacy": patch
"@generacy-ai/cockpit": patch
---

Stop cockpit `queue`/`advance` from 403ing on App-credentialed clusters (#830).

`cockpit queue` and `cockpit advance` resolved the GitHub identity via `gh api user`,
which always 403s ("Resource not accessible by integration") on clusters using a
GitHub App installation token — App tokens have no user identity. Both commands now
route through a shared `resolveCockpitIdentity` chain that mirrors the orchestrator's
`identity.ts` precedence: `--assignee` flag / `cockpit.assignee` config →
`CLUSTER_GITHUB_USERNAME` / `GH_USERNAME` env → `gh api user`, with a loud error
naming all four knobs when every tier misses. `queue` requires an identity (assignee
is load-bearing); `advance` treats the actor as cosmetic comment attribution and
degrades to omitting the actor line rather than failing the gate advance. Adds the
`cockpit.assignee` config field to the cockpit config schema.

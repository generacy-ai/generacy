---
"@generacy-ai/generacy": minor
---

Add the `generacy cockpit manifest <init|sync>` verb (#790).

`manifest init` parses the epic issue body into the per-epic manifest at
`.generacy/epics/<slug>.yaml` (deriving the slug, extracting the plan, and
laying out the phase entries); `manifest sync` reconciles an existing manifest
against the epic body by diffing phases and applying the resulting change set.
Both subverbs share testing seams (`runner` / `gh` / `stdout` / `stderr` /
`cwd`) and surface error paths through `CockpitExit`.

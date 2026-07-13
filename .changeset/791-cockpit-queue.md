---
"@generacy-ai/generacy": minor
---

Add the `generacy cockpit queue <phase>` verb (#791).

`queue` resolves a phase (by tier or name) across the epic manifests in
`.generacy/epics/*.yaml`, groups the phase's issues to a single target repo,
classifies each issue's eligibility, and — confirm-gated — assigns every
eligible issue to the cluster account and applies its derived
`process:speckit-feature` / `process:speckit-bugfix` workflow label. Ineligible
issues (closed, cross-repo, no phase, not found) are reported as skips in the
preview.

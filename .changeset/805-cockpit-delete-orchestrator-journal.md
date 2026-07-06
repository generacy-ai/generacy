---
"@generacy-ai/cockpit": minor
"@generacy-ai/generacy": minor
---

Delete the dead cockpit orchestrator/journal subsystems (#805, S1).

Removes the orchestrator API client (`packages/cockpit/src/orchestrator/**` —
client, http, stub) and its exports (`createOrchestratorClient`, `OrchestratorClient`,
health/jobs/workers types), journal liveness (`journal.ts`, `readJournalLiveness`,
`StuckReason`, `JournalLivenessResult`), and the confirmed-dead `appendChildIssue`
export from `manifest/io.ts`. Drops `stuck`/`recovered` from the watch event model
and `CockpitEventSchema` (fixing the producer/schema drift), and removes
`orchestrator.*` and `stuckThresholdMinutes` from the config schema.

On the CLI side (`@generacy-ai/generacy`), `generacy cockpit status` loses the
orchestrator footer line and `generacy cockpit watch` loses the orchestrator
counts line, along with the now-unused orchestrator token/warn/footer helpers.

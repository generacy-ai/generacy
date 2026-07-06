---
"@generacy-ai/cockpit": patch
---

Clean up the G-S1 residue left after deleting the cockpit orchestrator/journal
subsystems (#810, S4). Removes the stale pending changesets that announced the
now-deleted orchestrator-status and journal-stuck-detection features, drops the
orchestrator-client references from the package `description`, the README
(the "Talk to a running orchestrator", two-mode client, degraded-mode, and
`ORCHESTRATOR_URL`/`ORCHESTRATOR_API_TOKEN` sections), and the `src/index.ts`
header comment. Adds a legacy-config tolerance test proving configs that still
carry the removed `orchestrator.*` / `stuckThresholdMinutes` keys parse cleanly
(Zod strip mode).

For the record, the S1 deletion (#805) also dropped the `STALE` column from the
`generacy cockpit status` table renderer and removed the `stuckAt` /
`lastJournalAt` fields from `StatusRow`.

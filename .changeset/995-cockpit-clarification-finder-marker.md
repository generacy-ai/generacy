---
'@generacy-ai/generacy': patch
---

fix: cockpit_context now finds clarification comments after `waiting-for:clarification` label re-application

`findClarificationComment` used to anchor on the most-recent `labeled` timeline event, which failed whenever requeue / boot-resume / cluster-restart re-applied the label without re-posting questions. It now positively identifies clarification-question comments via the shared `CLARIFICATION_QUESTION_MARKERS` registry (marker-first), falling back to the label-timeline heuristic with a deprecation warn when no marker-carrying comment exists. Resolves #995.

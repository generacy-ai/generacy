---
"@generacy-ai/cockpit": patch
"@generacy-ai/generacy": patch
---

Add a `stage-complete` classifier tier so mid-pipeline `completed:*` labels no longer read as terminal (#841).

The classifier previously mapped every `completed:*` label to the `terminal`
state, so an issue that had finished an interim phase (e.g. `completed:plan`) but
was still mid-workflow was ranked terminal and could silently outrank a live
`waiting-for:*` label under tier precedence. A new `stage-complete` tier fixes
this: only an explicit `TERMINAL_COMPLETED_LABELS` set (`completed:validate`,
`completed:epic-approval`, `completed:children-complete`) still maps to `terminal`;
every other `completed:*` now maps to `stage-complete`, which ranks below
`waiting`/`error` so an actionable label always wins. Promotion of a new label to
terminal now requires editing that explicit set, making silent demotion of
`waiting-for:*` impossible. Within the tier, `STAGE_COMPLETE_PIPELINE_ORDER`
gives latest-phase-wins tie-breaking for co-occurring demoted labels. The
`generacy cockpit status` renderer gains a dim color for the new state.

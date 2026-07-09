---
"@generacy-ai/generacy": patch
"@generacy-ai/cockpit": patch
---

Stop cockpit watch/status classifying closed issues as actionable merge candidates (#873).

The watch/status classifier was label-only: a `completed:validate` label meant terminal/merge-candidate with no check of the issue's open/closed state. Closed issues keep their label residue forever, so every closed-and-merged child kept rendering as an actionable merge candidate on every fresh watch — an operator copying the suggested `/cockpit:merge` would run a merge against an already-merged PR. An issue's `state: closed` now dominates any label-derived actionability tier: closed children render as done in their phase group (no suggestion), the watch startup sweep emits nothing actionable for them, and a live open→closed transition yields exactly one terminal "done" line with no suggested command.

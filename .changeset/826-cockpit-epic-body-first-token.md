---
"@generacy-ai/cockpit": patch
---

Fix the cockpit epic-body parser rejecting refs with trailing titles (#826).

`parseEpicBody` previously passed the entire checkbox remainder (ref + delimiter +
title) to `parseRef`, but every shape in `ref-shapes.ts` is `^…$`-anchored, so any
task-list line carrying a free-form title (`- [ ] owner/repo#N — title`, the house
style every real epic uses) failed to match and every child ref was dropped. The
parser now extracts the leading whitespace-delimited token and parses that, treating
the remainder as an unparsed title, matching the documented epic-body contract.

The misleading warning reason (hardcoded "bare '#N' shorthand is not accepted") is
replaced with a rejection-family taxonomy that describes what was actually seen —
bare `#N`, a non-`/(issues|pull)/N` URL path, or titled-but-not-ref-shaped text —
and the first-token silence rule keeps prose checkboxes that merely mention a ref
mid-sentence from warning.

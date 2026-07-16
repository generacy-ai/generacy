---
"@generacy-ai/orchestrator": patch
---

Fix clarification options being truncated when an option description wraps (#948).

`parseClarifications()` extracted the `**Options**:` block by matching a run of
consecutive `- ` lines, so the first continuation line ended the block. A
hard-wrapped option description — or one carrying indented sub-bullets — was
therefore cut off mid-sentence, and every option after it was silently dropped
before `postClarifications()` rendered and posted the comment. The human
answering the gate never saw the missing options.

The block is now delimited the same way `**Context**` and `**Question**` already
are (to the next `**Field**:` line, `###` heading, or EOF), with continuation
lines attached to the option above them. Across the 1,440 questions carrying
options in the repo's shipped `clarifications.md` files, this recovers 17
dropped options and 6 truncated descriptions.

Comments already posted are unaffected — the poster dedups on its marker and
will not repost.

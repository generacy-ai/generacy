---
"@generacy-ai/orchestrator": patch
---

fix: don't let the clarify phase skip its pause on a misparsed answer (#818)

The clarify gate could complete without pausing on `waiting-for:clarification`
when the bot's own question comment (or leaked question-side markup) was parsed
as if it were a human answer. Hardens clarification answer detection in the
worker:

- `isQuestionComment` now also recognizes the variant `### Q<n>:` heading shape
  when a section carries question-side markup (`**Question**:` / `**Context**:` /
  `**Options**:`).
- `parseAnswersFromComments` anchors the `Q<n>:` opener at line start so mid-prose
  references ("as per Q1: yes") no longer capture as answers, and skips (with a
  `SKIPPED_SUSPICIOUS_ANSWER` warning) any captured answer that still contains
  question-side markup.

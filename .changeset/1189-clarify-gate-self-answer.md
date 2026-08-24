---
"@generacy-ai/orchestrator": patch
---

Fix the clarify gate silently self-answering and skipping (#1189).

The FR-004 discriminator that distinguishes a question comment from a cockpit answer block required a colon after `Q<n>` (`### Q1: Topic`). A clarification batch posted with a different separator — `### Q1 — Topic` — therefore fell on the answer-block side of the test: the fail-closed guard never fired, `parseAnswersFromComments` captured each question's own topic as its answer, `clarifications.md` was written with `**Answer**: — <question title>`, every question read as answered, and the `on-questions` gate was skipped. The workflow then ran plan → tasks → implement on unanswered design questions, and because integration only ever replaces the literal `*Pending*`, a real answer posted afterwards could never land.

The discriminator now keys on whether the `Q<n>` heading line carries any trailing content, which is the property that actually separates the two shapes: a question comment always names its topic on the heading line, while a cockpit answer block writes a bare `### Q1` and puts the answer on the next line. A bare heading (with or without trailing whitespace) still does not match, so legitimate cockpit integrations are unaffected.

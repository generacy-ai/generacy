---
"@generacy-ai/workflow-engine": patch
"@generacy-ai/orchestrator": patch
"@generacy-ai/cockpit": patch
---

Terminate the PR-feedback loop on its own trigger; stop the runaway reply churn (#883).

The monitor triggers on `unresolvedThreads > 0`, but the handler treated "reply
posted" as done and never resolved the threads — so a successful cycle left its
own trigger unchanged and re-fired at poll cadence forever, stacking a duplicate
"I've addressed this feedback" reply (one per comment, doubling each round) and
burning a full Claude CLI run every ~5 minutes.

- **workflow-engine**: adds a `resolveReviewThread(threadId)` GraphQL mutation
  (App-token-capable, 3× backoff retry, no retry on auth failure), a thread `id`
  on the #861 `ReviewThread` shape, and a `blocked:stuck-feedback-loop` label
  definition.
- **orchestrator**: after a fix cycle pushes a commit and posts one reply per
  *root* thread, the handler resolves every thread it addressed before clearing
  the label — the termination edge. No-diff cycles now post no replies, log a
  `warn` that the trigger persists, and exit without the success line instead of
  churning. The monitor skips issues carrying the `blocked:` pause.
- **cockpit**: classifies `blocked:*` labels as the `waiting` state and sorts
  `blocked:stuck-feedback-loop` ahead of the `waiting-for:*` gates so the pause
  surfaces first.

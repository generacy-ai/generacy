---
"@generacy-ai/orchestrator": patch
---

Merge-conflict re-arm targets a resolution-scoped review, not the interrupted phase (#1131).

After `MergeConflictHandler` successfully resolves a merge conflict, the worker now re-arms into a `review` phase scoped to just the resolution diff (`baseSha..headSha` — the pre-merge branch tip → the `--no-ff` merge commit) instead of blindly resuming the interrupted phase. This closes a semantic-conflict safety gap: a git-clean-but-semantically-broken merge previously sailed straight back into the phase it interrupted with no correctness review of the resolution.

The re-arm is gated on `reviewPhaseEnabled`: when the flag is OFF, behavior is byte-identical to before (`startPhase: metadata.phase`). When the scope SHAs can't be determined, it re-arms `review` with a whole-branch fallback (scope omitted). An empty resolution window short-circuits the review executor straight to `validate`. `reviewScope`/`diffWindow` are orchestrator-internal and not re-exported.

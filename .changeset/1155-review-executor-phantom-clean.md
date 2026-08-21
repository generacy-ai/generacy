---
"@generacy-ai/orchestrator": patch
---

Review executor must fail (not falsely pass) on CLI failure, timeout, or missing findings (#1155).

Fixes a critical (P0) phantom-clean verdict: the review-phase executor returned `success: true, exitCode: 0` unconditionally and `readCandidateFindings` returned `[]` for a missing/invalid sidecar, so a review whose CLI died, timed out, or crashed was read as zero findings, computed to a `clean` verdict, and advanced the unreviewed change to `validate` (and marked the PR ready) as though a real review had confirmed it.

The executor now propagates the real child exit code / timeout into `PhaseResult` (mirroring `remediate-executor.ts`), and the agent writes its findings to a separate candidate path (`review-candidate-<id>.json`) that the engine clears before spawning, so a candidate present after the spawn is provably written this round. `readCandidateFindings` returns `ReviewFinding[] | null` — `null` (missing / unreadable / invalid) is treated as no proof of review, `[]` is a genuine clean review. A failed / no-verdict round persists nothing: any prior-round engine artifact — including `round` and `remediationCount` — is left exactly as-is, so repeated failures cannot burn the #1128 remediate cap and a crash between the candidate write and the engine rewrite cannot silently reset the budget. The happy path (valid candidate, exit 0) is byte-identical to before. The new candidate-path helpers are internal worker surface, not re-exported from the package public `index.ts`.

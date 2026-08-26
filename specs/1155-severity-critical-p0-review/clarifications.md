# Clarifications: Review executor must fail (not falsely pass) on CLI failure, timeout, or missing findings

## Batch 1 — 2026-08-21

### Q1: Clean-signal contract
**Context**: The whole bug is that a missing/stale findings sidecar computes to `clean` (`review-artifact.ts:235-289`). To close it we must define the *sole* signal the engine accepts as "reviewed clean". FR-002 scopes the failure to "after a failed / timed-out CLI", which leaves the dangerous exit-0-but-no-fresh-sidecar case (exit-0 crash, or an agent that exits 0 without writing) ambiguous. This choice determines the core `success`/verdict logic.
**Question**: What signal MUST the engine require before it will treat a review round as a legitimate `clean` verdict?
**Options**:
- A: A candidate sidecar written *this round* whose findings compute to `clean`. A missing or stale (not-written-this-round) candidate is NEVER `clean`, regardless of the CLI exit code — including exit 0. ("Proof of review" contract.)
- B: Literal FR-002 scoping — only a *failed/timed-out* CLI with a missing sidecar is a failure; an exit-0 CLI with a missing sidecar is still `clean`.
- C: Both conditions required together: exit code 0 AND a fresh candidate written this round.

**Answer**: A — A candidate sidecar written *this round* whose findings compute to `clean` is the sole clean signal. A missing or stale (not-written-this-round) candidate is NEVER `clean`, regardless of the CLI exit code — including exit 0 ("proof of review" contract). *Rationale: closes the exit-0-but-no-fresh-sidecar gap that literal FR-002 scoping leaves; keeps the verdict signal (fresh candidate) separate from the exit-code gate (FR-001).*

### Q2: Candidate vs engine-artifact separation (FR-003)
**Context**: `readCandidateFindings` reads the *same* path the engine writes (`getReviewArtifactPath`), so on round ≥ 2 a no-op agent has the prior round's engine-stamped findings re-ingested as this round's candidate (spec §"Round ≥ 2"). FR-003 asks to distinguish the two but explicitly leaves the mechanism open ("separate path, or a per-round written marker"). This choice also largely determines how FR-004 (crash-window) is satisfied.
**Question**: How should the engine distinguish a candidate written *this round* from the engine-authoritative artifact left by a prior round?
**Options**:
- A: Separate candidate file path (e.g. `review-candidate-<id>.json`); the agent writes the candidate, the engine reads it and writes the authoritative artifact to the existing path, then clears the candidate. A missing candidate on the next round is unambiguously "nothing written this round". (Also isolates the crash window — the engine artifact stays intact, so FR-004 is satisfied for free.)
- B: Keep the shared file but add an engine-verified "written-this-round" marker (e.g. a nonce/round token the charter tells the agent to stamp) and reject a candidate lacking the current round's marker.
- C: Compare the sidecar's mtime against the CLI spawn time; treat a file older than spawn as stale.

**Answer**: A — Separate candidate file path (e.g. `review-candidate-<id>.json`): the agent writes the candidate, the engine reads it and writes the authoritative artifact to the existing path, then clears the candidate. A missing candidate next round is unambiguously "nothing written this round". *Rationale: structurally distinguishes candidate from engine artifact (FR-003) and satisfies the FR-004 crash window for free; avoids fragile nonce/mtime mechanisms. Note: the agent's write target is supplied to the charter via `sidecarRelPath` (`review-charter.ts:18-19,130-134`), so pointing the agent at the candidate path is a caller-supplied value change, not an edit to the charter prompt text — the Out-of-Scope "no charter prompt text" line is preserved.*

### Q3: Artifact persistence on the failure / no-verdict path
**Context**: FR-002 says the engine MUST NOT persist a `clean` artifact on failure. It does not say whether the engine writes *anything*. `round` and `remediationCount` are both derived from the persisted artifact (`review-executor.ts:108-109, :249`), so "write nothing" leaves any prior-round artifact untouched (preserving both), whereas "write a failure marker" changes them.
**Question**: When a review round fails to produce a fresh verdict (per Q1), what should the engine persist?
**Options**:
- A: Persist NOTHING — leave any prior-round engine artifact exactly as-is, so `round` and `remediationCount` are preserved and no fresh `clean` is ever written. (First-round failure ⇒ no artifact exists ⇒ nothing to advance.)
- B: Persist a distinct non-`clean` / `failed` marker artifact (new field or verdict value) recording that this round failed.

**Answer**: A — Persist NOTHING. Leave any prior-round engine artifact exactly as-is, so `round` and `remediationCount` are preserved and no fresh `clean` is ever written. First-round failure ⇒ no artifact exists ⇒ nothing to advance. *Rationale: honors FR-002 (MUST NOT persist a clean artifact on failure); a distinct failure marker would need an out-of-scope schema change.*

### Q4: `round` advancement on a failed review
**Context**: `round` is monotonic and load-bearing for the `#1128` remediate cap and `#1126` delta-scoping. It advances only when an artifact is written with an incremented round. If a failed review still increments `round`, a series of failed/timed-out reviews would burn the review↔remediate budget without any real review happening.
**Question**: On a failed / no-verdict review round, should the review `round` counter advance?
**Options**:
- A: No — `round` advances only when a review actually completes and produces a fresh verdict; a failed round does not consume the counter (consistent with Q3 option A "write nothing").
- B: Yes — every dispatched review advances `round`, even a failed one.

**Answer**: A — No. `round` advances only when a review actually completes and produces a fresh verdict; a failed round does not consume the counter (consistent with Q3-A "write nothing"). *Rationale: advancing round on failed/timed-out rounds would burn the #1128 remediate cap without any real review.*

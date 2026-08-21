# Clarifications

## Batch 1 — 2026-08-21

### Q1: Severity → blocking/advisory mapping
**Context**: FR-002 bridges `ReviewArtifact` findings (`severity: critical|major|minor`) into the `FindingsArtifact` shape (`severity: blocking|advisory`), which drives how each finding is rendered (advisory is visually distinct). The spec Assumptions hardcode `critical`/`major` → blocking and `minor` → advisory, but `computeVerdict` already classifies "blocking" via a **configurable** per-workflow `blockingSeverity` threshold that defaults to `critical` (so at the default, `major` is *not* blocking). These two definitions disagree at the default.
**Question**: Should the bridge derive blocking/advisory from the configured `blockingSeverity` threshold (consistent with `computeVerdict`), or use the fixed `critical|major = blocking, minor = advisory` mapping regardless of config?
**Options**:
- A: Follow the configured `blockingSeverity` threshold — a finding is `blocking` iff `SEVERITY_RANK[severity] >= SEVERITY_RANK[blockingSeverity]`, else `advisory`. Consistent with verdict computation.
- B: Fixed mapping — `critical|major` → blocking, `minor` → advisory, independent of `blockingSeverity`.

**Answer**: A — Follow the configured `blockingSeverity` threshold: a finding is `blocking` iff `SEVERITY_RANK[severity] >= SEVERITY_RANK[blockingSeverity]`, else `advisory`. Consistent with `computeVerdict`; single source of truth avoids a `major` finding rendering blocking on a PR that `computeVerdict` scored clean.

### Q2: Per-finding marker identity basis
**Context**: FR-003 requires synthesizing a stable per-finding `marker` (embedded in the inline comment for cross-round thread matching), since `ReviewArtifact` findings carry no id. The marker must remain stable for "the same" finding across rounds so re-review resolves the right thread, but must differ between genuinely distinct findings. The available fields are `severity`, `file`, optional `line`, `title`, `detail`, `round`, `status`.
**Question**: Which fields should form the stable per-finding marker?
**Options**:
- A: Hash of `file` + `title` (identity = "this problem in this file"); tolerant of `line`/`detail` drift between rounds.
- B: Hash of `file` + `line` + `title`; a line shift creates a new marker (may re-post a thread after code moves).
- C: Hash of `file` + `title` + `detail` (full-text identity); any wording change creates a new marker.

**Answer**: A — Hash of `file` + `title` (identity = "this problem in this file"), tolerant of `line`/`detail` drift between rounds. Keeps the marker stable across remediate rounds so re-review thread matching works; B/C would spuriously mint new markers on line/wording drift and orphan the prior thread.

### Q3: Live PR number resolution for the poster
**Context**: FR-004 — `ReviewPoster` captures `prNumber` as a `private readonly` field at construction (`prManager.getPrNumber() ?? 0`), and the worker constructs it before the PR exists, so early rounds would post to PR #0. The fix must make posting target the live PR number resolved at posting time.
**Question**: How should the poster obtain the live PR number?
**Options**:
- A: Inject a getter callback (e.g. `getPrNumber: () => number | undefined`) into `ReviewPoster`; it resolves the live number on each `postRound`/`resolveResolvedThreads` call and skips when still undefined.
- B: Pass the resolved PR number as an argument to `postRound`/`resolveResolvedThreads` from the phase-loop block (which already holds `prManager`).
- C: Construct a fresh `ReviewPoster` at the side-effect block each round with the current `prManager.getPrNumber()`.

**Answer**: A — Inject a `getPrNumber: () => number | undefined` getter callback into `ReviewPoster`; it resolves the live number per `postRound`/`resolveResolvedThreads` call and skips when undefined. Changes no method signature (poster surface stays as-is), resolves at posting time (FR-004), and is inert when there is no PR.

### Q4: Round value handed to `postRound`
**Context**: FR-005 says the posting round must come from the persisted sidecar, not the loop-local `reviewRound` (which resets to 1 each run). But the bridged `FindingsArtifact` shape carries only `verdict` + `findings` — it has no `round` field, while the raw `ReviewArtifact` sidecar does (`round`). Today the block calls `postRound(artifact, reviewRound)` with the loop-local counter.
**Question**: How should the sidecar `round` reach `postRound` / the round-≥2 thread-resolution gate?
**Options**:
- A: Have `readFindingsArtifact` return the round alongside the bridged artifact (e.g. `{ artifact, round }`), and the block passes that round.
- B: Add a `round` field to the `FindingsArtifact` shape and populate it during the bridge.
- C: Read the raw `ReviewArtifact.round` directly in the phase-loop block (separate from the bridged artifact) and pass it.

**Answer**: A — Have `readFindingsArtifact` return `{ artifact, round }`; the block passes that round. `readFindingsArtifact` already reads the sidecar carrying `round`, so returning it keeps `round` with its single existing read rather than mutating the out-of-scope shared `FindingsArtifact` shape or doing a redundant second read.

### Q5: Cross-run "engine marked ready" persistence
**Context**: FR-006 — `markedReadyByEngine` (`pr-manager.ts:41`) is in-memory per worker run, so a later `address-pr-feedback` re-entry in a *new* run can't tell whether the engine (vs a human) marked the PR ready, and won't convert it back to draft on a remediate round. FR-007 requires never demoting a human-marked-ready PR.
**Question**: How should the "engine marked this PR ready" signal survive across worker runs?
**Options**:
- A: Persist the flag in the review-findings sidecar (add a field); read it on re-entry to reconstruct `markedReadyByEngine`.
- B: Derive it from live PR state — treat the PR as engine-marked-ready iff it is ready AND an engine round marker is present among its reviews (no new persisted field).
- C: Persist in a separate sidecar/state key dedicated to lifecycle flags.

**Answer**: A — Persist the `markedReadyByEngine` flag in the review-findings sidecar and read it on re-entry to reconstruct the state. The sidecar is the named source of truth for cross-run lifecycle state; an explicit persisted flag is unambiguous and never demotes a human-marked-ready PR (FR-007), unlike fragile PR-state derivation.

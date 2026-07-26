# Clarifications for #1047

*Feature*: PR-feedback fixer must consume review bodies, not just inline threads
*Branch*: `1047-problem-orchestrator-s-pr`

## Batch 1 — 2026-07-26

### Q1: File-name source for the FR-003 "touched a named file" check
**Context**: FR-004 says the parser reads `<!-- generacy-cockpit:unanchored-findings -->` blocks "for named files" and uses that list to gate FR-003. But the canonical wire shape at `agency/specs/422-summary-auto-md-s/contracts/request-changes-post.md § Unanchored-block shape` emits `### Finding <n>` sub-blocks with `**Finding:** <summary>` + `**Failure scenario:** <scenario>` + `_reason: ..._` — there is NO structured field carrying a file path. FR-005 forbids "heuristic file-name extraction" for the marker-absent path. This leaves a gap: with the marker present but no file field in the wire, the FR-003 gate has nothing to key on.
**Question**: Where do the "named files" come from for the FR-003 gate?
**Options**:
- A: **Regex-scan the finding prose inside the marker block** for path-shaped tokens (e.g. `[\w./-]+\.(md|ts|tsx|js|json|yml|yaml|sh)` anchored to word boundaries). Treats the block as authoritative-but-unstructured. Contract stays as-is; the "no heuristic extraction" rule of FR-005 is scoped to marker-absent bodies only, not to text inside the marker block.
- B: **Extend the wire contract** to add a `**Files:** path/one, path/two` line under each `### Finding <n>`. Requires a coordinated change in `agency/packages/claude-plugin-cockpit` (spec's Assumptions currently say the contract is out of scope for consumer-side landing).
- C: **Drop FR-003 entirely for this PR** and ship only FR-001/FR-002 (body reaches the prompt). Cycle-completion stays as-today (thread-resolve count). Weakest guarantee but zero contract entanglement — the fixer's own re-poll on the next round catches misses.
- D: **Content-hash gate instead of file-name gate**: any commit produced in the cycle counts as "made progress on body findings" so long as the newest review body existed in the prompt. No per-file check. Simpler, but re-introduces the false-complete failure mode the spec explicitly wants to eliminate (SC-003).

**Answer**: *Pending*

### Q2: Which review submission states FR-001 fetches
**Context**: FR-001 says "fetch review bodies via `GET .../reviews`" but doesn't restrict by review state. GitHub's `submissionState` for a review is one of `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`, `PENDING`. The evidence table shows REQUEST_CHANGES reviews are the observed failure mode, but `/cockpit:auto` also submits `COMMENTED` reviews when it has commentary-only feedback, and human reviewers routinely leave `APPROVED` reviews with body-embedded nits ("LGTM, but rename foo → bar"). Over-fetching risks feeding APPROVED-with-nit bodies through the cycle-completion gate and blocking a genuinely-done cycle.
**Question**: Which review submission states should FR-001 include?
**Options**:
- A: **`CHANGES_REQUESTED` only.** Matches the observed failure mode exactly. Any body finding in a COMMENTED / APPROVED review is out of scope — matches the "review = things I want fixed before this merges" convention.
- B: **`CHANGES_REQUESTED` + `COMMENTED`.** Both express "there is a finding here." APPROVED bodies are treated as pass-through noise. Broadest reasonable interpretation of "review body finding."
- C: **All non-`PENDING`, non-`DISMISSED` states** (`APPROVED` + `CHANGES_REQUESTED` + `COMMENTED`). Zero-heuristic: any submitted review with a body reaches the fixer prompt. Highest recall; highest risk of gating a cycle on an approver's LGTM nit.
- D: **`CHANGES_REQUESTED` for the FR-003 gate; all non-`PENDING`/`DISMISSED` for the FR-002 prompt inclusion.** Split-brain: everything reaches the prompt (fixer sees more context), but only `CHANGES_REQUESTED` bodies can block cycle completion.

**Answer**: *Pending*

### Q3: FR-003 gate scope when multiple new reviews land between cycles
**Context**: FR-003 says "the newest review body" (singular) but FR-001 fetches reviews plural, "newer than the last fix cycle." Between two fix cycles, a reviewer can submit two reviews (e.g., re-review after a partial fix), or two reviewers can each submit one. The prompt in FR-002 gets every non-empty body; the gate in FR-003 is scope-ambiguous — "newest" could mean literally the max-`submitted_at` review only, or "all reviews since the watermark."
**Question**: When >1 new review body arrives between cycles, whose file list gates FR-003?
**Options**:
- A: **Newest by `submitted_at` only.** Later review supersedes earlier ones. If reviewer resubmits with the fix already applied to their earlier finding, the older finding stops blocking. Simplest; matches the natural "the reviewer had another look" semantics.
- B: **Union of all new reviews since the watermark.** All body findings from all newly-fetched reviews count. Reviewer must explicitly re-submit acknowledging the fix (or resolve) to clear a stale finding. Highest recall; false-positives if the reviewer moved on but didn't re-submit.
- C: **Per-review-author newest.** For each reviewer with new reviews, their newest submission wins; other reviewers' newest submissions also gate. Handles the "two humans reviewing in parallel" case without letting a later same-author review wipe an earlier other-author finding.
- D: **Author-agnostic newest per reviewer role** (bot-authored `/cockpit:auto` reviewer separate bucket from human reviewers). Bot's newest gates its own findings; humans' newest per-author gates theirs. Matches the two-track review model the spec's evidence describes.

**Answer**: *Pending*

### Q4: Disposition when FR-003 blocks Disposition A
**Context**: The current fixer has exactly two dispositions: A (success — commit pushed, resolves succeeded) and B (blocked — `blocked:stuck-feedback-loop` label applied, workflow paused for human). FR-003 adds a new "hold" condition: commit was pushed, thread resolves succeeded, BUT no file named by the newest body was touched. The spec says "does not advance to Disposition A" but doesn't say what happens instead. This decides the user-observable behavior (does the run pause, retry, keep polling, or something else).
**Question**: When FR-003 blocks Disposition A, what is the cycle's outcome?
**Options**:
- A: **Reuse Disposition B** verbatim: apply `blocked:stuck-feedback-loop`, pause the workflow, human intervenes. Simplest; keeps disposition count at two; but conflates "fixer stuck in a loop" with "fixer needs another round for body findings" — the human sees the same label for both.
- B: **New disposition C — "body-finding not addressed"**: apply a new label (e.g. `blocked:body-finding-unaddressed`) and pause. Distinguishes the two failure modes; adds a label to the vocabulary but keeps behavior parallel to B.
- C: **Re-attempt automatic fix in the same cycle** (loop the fixer up to N times inside a single monitor tick, until either a body-named file is touched or an inner budget is exhausted; then Disposition B on exhaustion). Aggressive; risks unbounded token spend; matches the "just fix it" spirit but hides retries from the operator.
- D: **Silent no-op: skip the cycle-completion marker but do not label**; next poll interval re-enters and re-attempts naturally (relies on the monitor's normal poll cadence to drive retries; the workflow neither advances nor pauses). Least intrusive; observability is limited to logs.

**Answer**: *Pending*

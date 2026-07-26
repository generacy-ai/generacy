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

**Answer**: **B — Extend the wire contract** to add a `**Files:** path/one, path/two` line under each `### Finding <n>`.

Rationale: the file path is not missing information, it is *discarded* information. `Finding.file` is a required non-empty field and `UnanchoredEntry` carries the whole `Finding`, but the rendered markdown emits only summary / failure_scenario / reason (see `agency/specs/422-summary-auto-md-s/data-model.md` § Finding, § UnanchoredEntry, § UnanchoredBlock render). B is therefore a lossless one-line render fix on the producer side. A regex-recovers a field the poster deliberately threw away: it misses findings whose prose never names the path, and false-positives on incidentally path-shaped tokens ("unlike foo.ts, ..."). C abandons SC-003 outright and D re-introduces the false-complete mode SC-003 exists to eliminate.

**Load-bearing rider**: the consumer-side parser MUST treat an absent `**Files:**` line as "no named files → this finding does not gate". That keeps already-open PRs and older posters degrading to C behaviour rather than hard-blocking, and it keeps FR-005's no-heuristic-extraction rule intact. Land the generacy-side parse tolerant of both shapes; the agency-side render change can follow independently.

### Q2: Which review submission states FR-001 fetches
**Context**: FR-001 says "fetch review bodies via `GET .../reviews`" but doesn't restrict by review state. GitHub's `submissionState` for a review is one of `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`, `PENDING`. The evidence table shows REQUEST_CHANGES reviews are the observed failure mode, but `/cockpit:auto` also submits `COMMENTED` reviews when it has commentary-only feedback, and human reviewers routinely leave `APPROVED` reviews with body-embedded nits ("LGTM, but rename foo → bar"). Over-fetching risks feeding APPROVED-with-nit bodies through the cycle-completion gate and blocking a genuinely-done cycle.
**Question**: Which review submission states should FR-001 include?
**Options**:
- A: **`CHANGES_REQUESTED` only.** Matches the observed failure mode exactly. Any body finding in a COMMENTED / APPROVED review is out of scope — matches the "review = things I want fixed before this merges" convention.
- B: **`CHANGES_REQUESTED` + `COMMENTED`.** Both express "there is a finding here." APPROVED bodies are treated as pass-through noise. Broadest reasonable interpretation of "review body finding."
- C: **All non-`PENDING`, non-`DISMISSED` states** (`APPROVED` + `CHANGES_REQUESTED` + `COMMENTED`). Zero-heuristic: any submitted review with a body reaches the fixer prompt. Highest recall; highest risk of gating a cycle on an approver's LGTM nit.
- D: **`CHANGES_REQUESTED` for the FR-003 gate; all non-`PENDING`/`DISMISSED` for the FR-002 prompt inclusion.** Split-brain: everything reaches the prompt (fixer sees more context), but only `CHANGES_REQUESTED` bodies can block cycle completion.

**Answer**: **B — `CHANGES_REQUESTED` + `COMMENTED`.**

Rationale: A is a trap and D shares its defect. `agency/specs/422-summary-auto-md-s/contracts/request-changes-post.md` § Field rules mandates that `event` is ALWAYS `COMMENT`, never `REQUEST_CHANGES`, because GitHub returns 422 when an author submits REQUEST_CHANGES on their own PR and speckit PRs are authored by the cluster account under the single-credential model. Every `/cockpit:auto` request-changes review therefore lands with submissionState `COMMENTED`. A `CHANGES_REQUESTED`-only filter would fetch (A) — or gate on (D) — exactly ZERO of the observed failures in the evidence table, i.e. it would faithfully reproduce the bug this issue exists to fix. That makes A/D disqualifying, not merely conservative.

C's extra recall over B is purely APPROVED-with-nit bodies, which is the one class the question correctly identifies as cycle-blocking noise. Pairing B with Q1's marker + `**Files:**` keying further neutralises residual COMMENTED noise: only marker-bearing bodies can name a file, so only they can gate.

### Q3: FR-003 gate scope when multiple new reviews land between cycles
**Context**: FR-003 says "the newest review body" (singular) but FR-001 fetches reviews plural, "newer than the last fix cycle." Between two fix cycles, a reviewer can submit two reviews (e.g., re-review after a partial fix), or two reviewers can each submit one. The prompt in FR-002 gets every non-empty body; the gate in FR-003 is scope-ambiguous — "newest" could mean literally the max-`submitted_at` review only, or "all reviews since the watermark."
**Question**: When >1 new review body arrives between cycles, whose file list gates FR-003?
**Options**:
- A: **Newest by `submitted_at` only.** Later review supersedes earlier ones. If reviewer resubmits with the fix already applied to their earlier finding, the older finding stops blocking. Simplest; matches the natural "the reviewer had another look" semantics.
- B: **Union of all new reviews since the watermark.** All body findings from all newly-fetched reviews count. Reviewer must explicitly re-submit acknowledging the fix (or resolve) to clear a stale finding. Highest recall; false-positives if the reviewer moved on but didn't re-submit.
- C: **Per-review-author newest.** For each reviewer with new reviews, their newest submission wins; other reviewers' newest submissions also gate. Handles the "two humans reviewing in parallel" case without letting a later same-author review wipe an earlier other-author finding.
- D: **Author-agnostic newest per reviewer role** (bot-authored `/cockpit:auto` reviewer separate bucket from human reviewers). Bot's newest gates its own findings; humans' newest per-author gates theirs. Matches the two-track review model the spec's evidence describes.

**Answer**: **C — Per-review-author newest**: each reviewer's latest submission supersedes only their own earlier submissions.

Rationale: supersession is an authorship property — only the author of a finding is in a position to retract it. A is unsafe because the bot and humans genuinely review in parallel here (the cluster posts as `CLUSTER_GITHUB_USERNAME`, humans as themselves — see `packages/orchestrator/src/services/pr-feedback-monitor-service.ts:210` and the per-author trust loop at `:213-232`), so a human's later review would silently erase the bot's still-unaddressed body findings from the gate. B never lets a reviewer's own superseded finding clear, which under Q4's pause semantics pins the run on a reviewer who moved on without re-submitting. D is C plus a degenerate "bot bucket" that contains exactly one login, buying a role taxonomy for no additional coverage.

### Q4: Disposition when FR-003 blocks Disposition A
**Context**: The current fixer has exactly two dispositions: A (success — commit pushed, resolves succeeded) and B (blocked — `blocked:stuck-feedback-loop` label applied, workflow paused for human). FR-003 adds a new "hold" condition: commit was pushed, thread resolves succeeded, BUT no file named by the newest body was touched. The spec says "does not advance to Disposition A" but doesn't say what happens instead. This decides the user-observable behavior (does the run pause, retry, keep polling, or something else).
**Question**: When FR-003 blocks Disposition A, what is the cycle's outcome?
**Options**:
- A: **Reuse Disposition B** verbatim: apply `blocked:stuck-feedback-loop`, pause the workflow, human intervenes. Simplest; keeps disposition count at two; but conflates "fixer stuck in a loop" with "fixer needs another round for body findings" — the human sees the same label for both.
- B: **New disposition C — "body-finding not addressed"**: apply a new label (e.g. `blocked:body-finding-unaddressed`) and pause. Distinguishes the two failure modes; adds a label to the vocabulary but keeps behavior parallel to B.
- C: **Re-attempt automatic fix in the same cycle** (loop the fixer up to N times inside a single monitor tick, until either a body-named file is touched or an inner budget is exhausted; then Disposition B on exhaustion). Aggressive; risks unbounded token spend; matches the "just fix it" spirit but hides retries from the operator.
- D: **Silent no-op: skip the cycle-completion marker but do not label**; next poll interval re-enters and re-attempts naturally (relies on the monitor's normal poll cadence to drive retries; the workflow neither advances nor pauses). Least intrusive; observability is limited to logs.

**Answer**: **B — New disposition C**: apply `blocked:body-finding-unaddressed` and pause.

Rationale: D is factually broken, not merely quiet. FR-003's hold fires only AFTER the thread resolves have succeeded, so the very next poll hits the monitor's Case C at `packages/orchestrator/src/services/pr-feedback-monitor-service.ts:264-285` (`totalUnresolvedThreads === 0` → log, reset state, `return false`) and never re-enqueues. Nothing "re-enters naturally"; the run stalls silently with the body finding unfixed — the exact failure mode this issue documents.

B is close to free: the monitor's pre-enqueue skip gate is a bare `l.startsWith('blocked:')` prefix match with an explicit no-allow-list contract (`:328-341`), so a new label is honoured with zero monitor-side change. It also preserves the triage signal A destroys — "fixer looping" and "fixer needs a file outside the diff" call for different human actions, and collapsing both onto `blocked:stuck-feedback-loop` hides that. C re-runs an identical prompt against identical inputs for unbounded token spend and hides the retries from the ledger.

## Batch 2 — 2026-07-26

### Q5: FR-003 satisfaction semantics within a single gating review
**Context**: FR-003's clause "no commit touching any file it names" is ambiguous when a single gating review contains multiple findings — each with its own `**Files:**` list. Two readings:
- **Union**: the review is cleared if any commit in the cycle touches any file named by *any* finding in that review. One hit clears the whole review.
- **Per-finding**: every finding in the review must have at least one of its named files touched. Missing any one blocks the cycle.

SC-003 says "cycles falsely marked complete despite unaddressed body findings" = 0. The union reading admits false-completes when a reviewer emits N findings (files A, B, C) and the fixer touches only A — the review clears despite findings 2 and 3 sitting unaddressed. The per-finding reading matches SC-003's spirit more literally but is stricter and risks blocking legitimate partial-progress cycles.
**Question**: When a single gating review has multiple `### Finding <n>` sub-blocks each with a `**Files:**` list, when is that review satisfied?
**Options**:
- A: **Per-finding — every finding's `**Files:**` list must have at least one path touched.** Strictest reading of SC-003. Missing any one finding's files blocks the cycle to disposition C. Matches the "no false completes" spec goal literally.
- B: **Union — any commit touching any file named by any finding in the review clears the whole review.** Laxest reading. Cheapest to implement (single set-membership check). Accepts partial-progress cycles as complete, risking SC-003 regression when the fixer touches one file but ignores the sibling findings.
- C: **Per-finding, with finding-level tracking** — each `### Finding <n>` is a separate gate; disposition C lists which findings remain unaddressed. Requires per-finding state in the block-parser output and a richer disposition-C log message, but gives the operator actionable "these three findings still need files touched" output on the blocked label.
- D: **Per-finding for `CHANGES_REQUESTED`-style reviews, union for `COMMENTED`-only** — treats stronger review states as stricter gates. Splits the semantic on submission state; harder to reason about since Q2=B already established both states are equivalent to the fetch/gate path.

**Answer**: **C — Per-finding with finding-level tracking**: each `### Finding <n>` is its own gate, and disposition C names which findings remain unaddressed.

Rationale: B and D both admit the SC-003 false-complete, and D is structurally the same trap as batch-1 Q2=A. `agency/specs/422-summary-auto-md-s/contracts/request-changes-post.md` § Field rules fixes `event` to `COMMENT` on every self-authored review, so every `/cockpit:auto` review lands as `COMMENTED` — D's *union* branch would therefore be the effective rule for essentially all cockpit reviews (the exact class #1047 exists to fix), while its per-finding branch would apply only to human `CHANGES_REQUESTED` reviews, which are not the observed failure mode.

C over A: A already requires evaluating each `### Finding <n>` against its own `**Files:**` list, so C's only marginal cost is emitting the already-computed unsatisfied subset rather than discarding it. Without that, the operator gets a bare label — the existing disposition-B path is label-and-log only (`addBlockedStuckFeedbackLoopLabel` calls `addLabels` plus a logger line, under a comment that explicitly says 'Do NOT reply', `pr-feedback-handler.ts:748-767`) — leaving 'which of the N findings still blocks?' answerable only from orchestrator logs. That output is cheap and precedented: `maybePostUntrustedNotice` already posts a marker-keyed top-level PR comment via `client.postPrComment` with a `listPrCommentBodies` idempotency check (`pr-feedback-monitor-service.ts:435-480`).

Note the synergy with Q6: C's per-finding identity is the same state Q6=B needs, so the operator-facing comment and the durable acknowledgment record should be ONE artifact, not two mechanisms.

### Q6: Fixer behavior when `blocked:body-finding-unaddressed` is removed by the operator
**Context**: FR-007 defines disposition C: apply `blocked:body-finding-unaddressed` and pause. The operator eventually removes the label (either by hand-fixing the file themselves, by re-triggering the review, or by explicitly deciding the finding is invalid). Removing a `blocked:*` label re-enqueues the issue (`pr-feedback-monitor-service.ts:328-341` skip gate no longer applies). At that point, the same body findings are still on the PR — the fetch will re-surface them and, if no commit touched them yet, FR-003 will re-block *immediately*. The spec is silent on what breaks the loop.
**Question**: On resume after `blocked:body-finding-unaddressed` is removed, what breaks the potential label-loop?
**Options**:
- A: **Advance the review watermark past the gating reviews when applying disposition C.** Next resume re-fetches from the new watermark — the same body findings are no longer visible to the fixer, so FR-003 can't re-trigger on them. Operator's hand-fix (if any) stands; a new review is required to gate again. Simplest; consistent with "watermark advances normally" (Out of Scope §4). Risks losing findings the operator wanted the fixer to retry (they'd have to re-post).
- B: **Do not advance the watermark on disposition C; instead, remember the finding-set that was blocked and mark those specific findings as "acknowledged, do not re-gate" on resume.** Explicit per-finding acknowledgment (probably a `<!-- generacy-cockpit:ack-body-findings -->` marker on the PR or per-issue state). Findings still reach the prompt (FR-002) — just don't gate. Operator gets one clean retry; fixer sees the context.
- C: **Retry the fixer once on resume with the same findings; if it still doesn't touch a named file, advance to a terminal disposition D** (`blocked:body-finding-unaddressed-terminal`). Bounded retry, but adds a second label to the vocabulary and requires per-issue retry-count state.
- D: **Do nothing special on resume — accept that FR-003 will re-block if the operator removed the label without touching the file.** Explicit: removing the label without addressing the finding is a no-op / user error. Operator must hand-fix (or hand-touch) the file before removing the label. Matches disposition B's current behaviour (removing `blocked:stuck-feedback-loop` without unblocking manually re-loops).

**Answer**: **B — Do not advance the watermark.** Record the blocked finding-set and mark those specific findings 'acknowledged, do not re-gate' on resume; they still reach the prompt per FR-002, they just do not gate.

Premise correction first — the option set is built on a claim that does not hold: removing the label does NOT re-enqueue on this path. FR-003's hold fires only AFTER the thread resolves succeeded, so the next poll hits Case C (`totalUnresolvedThreads === 0` → log, reset, `return false`) at `pr-feedback-monitor-service.ts:264-283`, which precedes the `blocked:*` check at `:328-341` entirely. Nothing re-enters until a NEW review posts new threads. The loop Q6 describes is real but deferred to that next review-triggered cycle — where D would re-block on findings the operator explicitly cleared, a genuine repeating dead end.

A is worse than advertised: `grep -rni watermark packages/orchestrator/src` returns zero matches, so the watermark is net-new, and FR-001's 'newer than the last cycle' predicate is the SINGLE source feeding both the FR-002 prompt and the FR-003 gate. Advancing it therefore deletes the findings from the prompt on precisely the cycle where the fixer most needs them.

On persistence, B needs no new infrastructure but MUST NOT use process memory: the monitor's only per-PR state is two in-memory Maps (`lastUnresolvedThreadCount`, `lastZeroTrustedState`), `MonitorState` is pure polling health, and `PrFeedbackHandler` is constructed fresh per job in the worker (`claude-cli-worker.ts:295-299`) across a queue boundary from the monitor, so it holds no cross-cycle state by construction. The acknowledgment should ride the existing marker-comment-as-durable-state idiom (`postPrComment` + `listPrCommentBodies` marker check), which is restart-safe and process-agnostic. C by contrast needs that same new store PLUS a second label, and re-runs an identical prompt against identical inputs.

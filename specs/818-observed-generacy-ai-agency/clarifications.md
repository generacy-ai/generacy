# Clarifications: Clarify Phase Gate-Skip Race

**Issue**: [#818](https://github.com/generacy-ai/generacy/issues/818)
**Branch**: `818-observed-generacy-ai-agency`

## Batch 1 — 2026-07-06

### Q1: isQuestionComment Detection Rule
**Context**: FR-001 says `isQuestionComment` must return true for a body containing a `### Q<n>:` heading "followed within the same section by `**Question**:` or `**Options**:` markup". The current bot output (`formatComment`) always emits `### Q<n>:` + `**Context**:` + `**Question**:` + (optional) `**Options**:` in the same section. But the CLI's clarify Claude may or may not include `**Context**:` and `**Options**:`. Detection scope drives false negatives.
**Question**: What is the precise "question comment" detection rule that the tightened `isQuestionComment` must implement?
**Options**:
- A) Any body with at least one `### Q<n>:` heading whose section (up to the next `### ` heading or end-of-body) contains `**Question**:` — the loosest reliable signal.
- B) Any body with `### Q<n>:` heading whose section contains either `**Question**:` OR `**Context**:` OR `**Options**:` — matches a wider variant set.
- C) Any body with at least one `### Q<n>:` heading, full stop (no bold-markup co-location required) — simplest but risks classifying long human prose that quotes questions as a question comment.
- D) Only bodies that both (a) contain `### Q<n>:` AND (b) contain `**Question**:` anywhere in the body — cheap to implement, permissive on section boundaries.

**Answer**: *Pending*

---

### Q2: US2 Warn Trigger Timing
**Context**: US2 says "log a warning when `integrateClarificationAnswers` transitions any question from pending to answered based on a comment that could plausibly be the bot's own questions comment." FR-004 says warn when the gate transitions active→not-active after integration. But FR-002 (defense in depth) *prevents* those suspicious integrations from succeeding. If FR-002 prevents them, the FR-004 warn never fires — the two requirements interact.
**Question**: Where in the flow should the warn log line fire?
**Options**:
- A) Fire when FR-002 defense-in-depth *skips* an integration (attempted answer contained `**Question**:` / `**Context**:` markup). Emit the source comment id, question number, and captured text. This surfaces the near-miss even when the skip prevents damage.
- B) Fire only when a full pending→answered transition actually occurs from a comment that also has `### Q<n>:` headings (matches FR-004's wording literally). If FR-001/FR-002 succeed, this never fires — the warn becomes a residual-race detector.
- C) Fire in *both* places: one "skipped-suspicious" warn (from FR-002) and one "transition-with-question-headings" warn (from FR-004). Two distinct log messages/codes so operators can differentiate.

**Answer**: *Pending*

---

### Q3: FR-003 Timestamp Safety Net Necessity
**Context**: FR-003 (P2) proposes a timestamp-based check: compare comment `created_at` against `clarifications.md` mtime and refuse to integrate answers from a comment posted after the file was written in this run. This adds complexity: mtime is preserved across `git checkout` on most filesystems but not all, and the comparison window is subject to clock skew between GitHub and the cluster. Whether we ship this depends on whether FR-001/FR-002 are considered sufficient.
**Question**: Should FR-003 (timestamp check) be implemented in this bug fix?
**Options**:
- A) Yes — implement as specified. Use `statSync(clarificationsPath).mtimeMs` and reject comments with `created_at > mtime - 5s tolerance`. Ship as belt-and-suspenders.
- B) Defer FR-003 to a follow-up issue. Ship FR-001/FR-002 + FR-004 only. Re-evaluate if the SC-001 metric shows any residual skips after deployment.
- C) Drop FR-003 entirely — the marker-based (FR-001) + content-based (FR-002) defenses cover the race window, and timestamp comparisons add fragility (git mtime resets, GitHub clock drift).

**Answer**: *Pending*

---

### Q4: Comment ID Plumbing for FR-004
**Context**: FR-004 says the warn must include "source comment ids". Today, `parseAnswersFromComments(comments: Array<{ body: string }>)` receives only bodies — no ids. Producing a comment-id in the log requires widening the type and threading ids through `integrateClarificationAnswers` and the `GitHubClient.getIssueComments` return shape.
**Question**: What identifier should the warn log line surface for the offending comment?
**Options**:
- A) Plumb GitHub numeric comment `id` all the way through — widen `parseAnswersFromComments` input to `{ id: number; body: string; created_at?: string }`. Confirms exact comment for operators, but touches the type surface and existing tests.
- B) Log a body-derived synthetic id (first 8 chars of a hash of the body) — no signature changes, still unique-enough to correlate with GitHub via search. Cheaper but requires operators to manually locate the comment.
- C) Log just the comment index and a short excerpt of the body (first 80 chars) — no signature changes, no hash. Least precise but sufficient for pattern analysis.

**Answer**: *Pending*

---

### Q5: Greedy Regex Fix Scope
**Context**: The spec's Root Cause section calls out the answer regex at `clarification-poster.ts:326-327` as "greedy across the whole comment body" and flags "as per Q1: yes" prose as a potential false match. The listed FRs (FR-001–FR-006) do not directly mandate a regex change — they mandate `isQuestionComment` tightening and content-based skip logic. Whether to also harden the regex affects test coverage and blast radius.
**Question**: Is tightening `parseAnswersFromComments`'s regex in scope for this fix?
**Options**:
- A) In scope — add anchoring so `Q<n>:` only matches at the start of a line (or after a heading marker), rejecting mid-prose "as per Q1: yes". Add a regression test.
- B) Out of scope — the `isQuestionComment` upstream filter (FR-001) is the primary defense; leave the regex as-is. Track prose-quoting false matches separately if they occur in production.
- C) Partially in scope — add anchoring only when the comment body contains any `### Q<n>:` heading (i.e., when the risk is highest). Human free-form comments continue to use the current permissive regex.

**Answer**: *Pending*

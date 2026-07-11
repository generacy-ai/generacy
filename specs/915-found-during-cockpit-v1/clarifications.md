# Clarifications

## Batch 1 — 2026-07-11

### Q1: Synthetic-path discriminator
**Context**: FR-002 proposes `result.error.output.length === 0` as the discriminator that tells `buildErrorEvidence` a result is on the synthetic (post-exit classifier) path versus the shell/CLI process path. But the no-progress guard at `phase-loop.ts:426` populates `error.output` with the counter text (`` `no progress: tasks_remaining stayed at ${tasksRemaining} across two increments` ``), which means the FR-002 discriminator classifies no-progress as a **process** path and drops the `reason` — contradicting US1/FR-006, which lists no-progress as one of the three synthetic paths that MUST render a reason. This is foundational: it decides whether the fix is a caller-only change or also an API change to `buildErrorEvidence`.
**Question**: Which discriminator does `buildErrorEvidence` use to decide "synthetic vs process" so that all three named classifier paths (product-diff, no-progress, catch-block) render a `reason`?
**Options**:
- A: Change the no-progress guard to leave `error.output` empty and move the counter text into `error.message` only. FR-002's `output.length === 0` discriminator stays as written.
- B: Add an explicit `classifier?: string` parameter to `buildErrorEvidence`. Presence of the parameter is the sole discriminator; `error.output` is left free-form on every path (no code churn at the no-progress site's `error.output`).
- C: Both signals — the explicit `classifier` parameter is the primary discriminator; dev-mode assertion fails loudly if a caller passes `classifier` while `error.output` is non-empty, so the two signals stay in sync.

**Answer**: *Pending*

### Q2: Reason rendering rules for long / multi-line messages
**Context**: The product-diff `error.message` is a single ~150-char sentence (`Phase "implement" produced no product-code changes — all changed files are under excluded prefixes [specs/]. Implement must modify at least one non-excluded file.`), safe to inline. The catch-block sites set `message: String(error)` — arbitrary caller-thrown text that may contain embedded newlines, a stack-trace excerpt, or thousands of characters. FR-004 dictates the format as `**Reason**: <reason>` on its own line, but doesn't specify what happens when `<reason>` breaks that assumption. Choice here fixes the regression fixtures (FR-008) and the byte layout in `appendEvidenceBlock` / `renderFailureAlert`.
**Question**: How is `reason` normalized before rendering?
**Options**:
- A: Inline-only — replace embedded `\n` with `; `; cap at 1 KiB with a trailing `…` marker; no code fence.
- B: Preserve newlines — if `reason` contains a newline, render as a fenced code block **above** the label (`**Reason**:` on its own line, then a ```text``` fence with the verbatim message, capped at 1 KiB). Single-line reasons stay inline.
- C: Verbatim inline — no newline substitution, no cap; render as `**Reason**: <reason>` even when multi-line.
- D: Inline, cap only — pass newlines through (they'll render as spaces in markdown), cap at 1 KiB with `…`.

**Answer**: *Pending*

### Q3: Classifier names for the catch-block sites
**Context**: FR-003 names three concrete classifiers — `'no-product-code-changes'`, `'no-progress'`, `'catch-block'` — but there are (at least) two distinct catch-block synthetic-result sites in `phase-loop.ts`: the unexpected-spawn-error catch at ~:360–373 and the product-diff-detection-error catch at ~:588–599. Whether both use the literal `'catch-block'` string, or each gets its own name, determines the summary-line readability and the regression-fixture assertion strings (FR-008).
**Question**: What concrete classifier name does each catch-block synthetic-result site pass to `buildErrorEvidence`?
**Options**:
- A: Both catch-block sites pass the same literal `'catch-block'`. The `reason` text (`String(error)`) is what distinguishes them in the rendered alert.
- B: Each catch-block site passes a site-specific name — `'spawn-error'` for the unexpected-spawn catch (~:373), `'product-diff-error'` for the product-diff-detection catch (~:600). No shared string.
- C: Family-prefixed names — `'catch-block:spawn'` and `'catch-block:product-diff'` — so log filters can group all catch-block failures by prefix while still distinguishing the site.

**Answer**: *Pending*

### Q4: Backtick / markdown safety on the rendered `reason`
**Context**: `outputTail` is neutralized against fence-breakout via the ZWSP substitution `replace(/```/g, '`​``')` (`stage-comment-manager.ts:200` / :334). The `reason` line is rendered **inline** (`**Reason**: <reason>`), not inside a fenced block, so triple-backticks don't break a fence — but a single stray backtick or unbalanced backtick pair in `String(error)` output can still break the surrounding bold-label markdown or turn the message into inline code accidentally.
**Question**: How does the renderer sanitize `reason` for markdown?
**Options**:
- A: No sanitization — pass through verbatim. Trust that callers set sanitary messages; catch-block's `String(error)` is accepted as-is.
- B: ZWSP-escape single backticks (`` ` `` → `` `​ ``) in `reason` before rendering, matching the treatment already used for `outputTail`.
- C: Wrap the rendered value in inline code (`` **Reason**: `<reason>` ``) and ZWSP-escape any embedded backticks, so single backticks in the source never break formatting and the value renders monospaced.

**Answer**: *Pending*

### Q5: In-scope callsites for the classifier parameter
**Context**: FR-006 enumerates six `buildErrorEvidence` callsites and groups three of them as catch-block sites: `:294`, `:373`, `:548`. But `:294` (pre-validate install failure, inside `if (!installResult.success)`) and `:548` (post-phase failure, inside `if (!result.success)`) are **shell/CLI process-failure paths** — the `result.error.output` is the ring-buffer tail from a real command with a real non-zero exit code. Under FR-002's discriminator these are process paths and must NOT render a `reason` (US2 / FR-009). The FR-006 grouping therefore either (a) has stale line numbers, (b) is only listing which callsites need any code change (even if just a `classifier: undefined` argument), or (c) is asking the fix to widen scope and render `reason` on process paths too when `error.message` is human-readable.
**Question**: Which of the six FR-006 callsites need modification, and what change does each get?
**Options**:
- A: Only the three synthetic-result sites (no-progress `:429`, product-diff `:600`, product-diff `:630`, spawn-catch `:374` — i.e., every callsite whose surrounding block constructs a synthetic PhaseResult) pass `classifier`. The shell-path callsites (`:294`, `:548`) are untouched. FR-006's mention of `:294` / `:548` is a spec-authoring error.
- B: All six callsites pass a `classifier` argument, but the shell-path callsites (`:294`, `:548`) pass `undefined` so their rendered output is unchanged (satisfies US2 by discriminator, not by call-site omission).
- C: All six callsites render a `reason` — `:294` and `:548` on genuine shell failures pull `reason` from `result.error.message` too (widens the fix to include human-readable process-path failures). US2's "unchanged shape" is interpreted as "no phantom reason injected from **shell output**" rather than "no reason line at all".

**Answer**: *Pending*

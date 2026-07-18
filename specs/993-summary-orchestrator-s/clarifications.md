# Clarifications: fix(orchestrator): clarification-answer monitor resume-loops on the cluster's own bot comments

## Batch 1 — 2026-07-18

### Q1: Bot + answer-marker precedence
**Context**: FR-001 says any `[bot]`-suffixed author is "never an answer." FR-003(a) says a comment carrying a `CLARIFICATION_ANSWER_MARKERS` marker qualifies as an answer, and SC-003 explicitly says "any author, incl. bot." These conflict on a bot that posts a marker. This is not academic — cockpit posts `<!-- generacy-clarification-answers: -->` marker comments from the cluster itself (which authenticates as `generacy-ai[bot]`), and the existing monitor code (`clarification-answer-monitor-service.ts:180-184`) already documents that "cluster-relayed answers" are the phase-loop's job, not the monitor's.
**Question**: When a `[bot]`-suffixed author (including the cluster's own `generacy-ai[bot]`) posts a comment carrying a `CLARIFICATION_ANSWER_MARKERS` marker, does that comment count as an answer for the monitor's resume predicate?
**Options**:
- A: Bot filter wins — the marker never rescues a bot-authored comment. The phase loop, not the monitor, integrates cluster-relayed answers. FR-003 clarified to: `(a) marker AND author is not `[bot]``, `OR (b) non-bot, non-cluster-self`. SC-003 revised: marker-carrying comment from a NON-BOT author.
- B: Marker wins — a bot-authored marker comment IS an answer. FR-001 clarified to exempt marker-carrying comments. SC-003 kept as-is.
- C: Split — marker from `viewerDidAuthor === true` (cluster-self) is filtered; marker from a `[bot]` login that is NOT the cluster's own bot is treated as an answer.

**Answer**: A — bot filter wins; a `CLARIFICATION_ANSWER_MARKERS` marker never rescues a `[bot]`-authored comment for the MONITOR's resume predicate. Cluster-relayed answers (cockpit's `generacy-clarification-answers:` marker, authored by `generacy-ai[bot]`) are integrated via the `completed:clarification` label / phase-loop path — the relay applies that label directly, which resumes through LabelMonitorService, NOT this monitor. The existing code already documents this (`clarification-answer-monitor-service.ts:180-184`). Letting a bot marker count here reopens the exact bug. FR-003 → `(a) marker AND author not [bot], OR (b) non-bot, non-cluster-self`; SC-003 → non-bot marker author.

### Q2: "Latest clarification-question comment" definition
**Context**: FR-004 requires the candidate answer to be "strictly newer (by `createdAt`) than the latest clarification-question comment." Two plausible definitions exist: (i) newest by `createdAt` among comments matching `CLARIFICATION_QUESTION_MARKERS`, (ii) the comment carrying the numerically highest batch id in `<!-- generacy-clarifications:N -->`. Iterative clarify cycles can produce multiple question comments; the correct anchor determines whether a mid-cycle answer resumes correctly.
**Question**: What defines "the latest clarification-question comment" for the FR-004 newness check?
**Options**:
- A: The newest comment (by `createdAt`) whose body matches any prefix in `CLARIFICATION_QUESTION_MARKERS`. Simplest; robust to any marker family.
- B: The comment with the highest numeric suffix in `<!-- generacy-clarifications:N -->`, falling back to `createdAt`-newest among all question-marker prefixes if none carry a numeric suffix.
- C: The newest `createdAt` among a narrower set — only `<!-- generacy-clarifications:` and `<!-- generacy-cockpit:clarifications-batch:` (the two prefixes the clarify command and cockpit actually emit for question batches), excluding the umbrella `<!-- generacy-stage:clarification`.

**Answer**: A — newest by `createdAt` among `CLARIFICATION_QUESTION_MARKERS`. Simplest, handles iterative clarify cycles (an answer to batch N must beat batch N's timestamp), and stays robust to any question-marker family. The numeric-suffix approach (B) is fragile (needs a fallback, assumes numbering); narrowing the set (C) risks missing a future question family. Caveat: if the umbrella `generacy-stage:clarification` marker is ever emitted AFTER a question batch it could mis-anchor — if that timing is real, exclude it per C — but by default the canonical question-marker registry is the correct anchor.

### Q3: `MACHINE_MARKERS` additions — scope
**Context**: `MACHINE_MARKERS` already contains `<!-- generacy-stage:specification`, `<!-- speckit-stage:specification`, `<!-- speckit-stage:planning`, `<!-- speckit-stage:implementation`. FR-005 says "`generacy-stage:*` and `speckit-stage:*` HTML-comment prefixes." The one prefix demonstrably missing from the evidence is `<!-- speckit-stage:clarification`. Adding future stages (tasks, validate, analyze) or a wildcard match affects future-proofing vs. explicit safety.
**Question**: What is the intended scope of the FR-005 addition to `MACHINE_MARKERS`?
**Options**:
- A: Add exactly the observed-missing prefix — `<!-- speckit-stage:clarification` — and nothing else. Minimal, evidence-driven, keeps the enumerated-marker discipline intact.
- B: Add every current speckit phase — `<!-- speckit-stage:clarification`, `<!-- speckit-stage:tasks`, `<!-- speckit-stage:validate`, `<!-- speckit-stage:analyze` — even if some are unused today. Future-proof for a static enum.
- C: Change the match rule to a prefix-family match on `<!-- generacy-stage:` and `<!-- speckit-stage:` (any suffix). Broadest; catches any future stage without a code change but removes the audit trail of which stages are recognized.

**Answer**: C — prefix-family match on `<!-- generacy-stage:` and `<!-- speckit-stage:` (any suffix). This bug IS enumeration drift — the set missed `speckit-stage:clarification`, at least the second such divergence — so a family match eliminates the whole class: every engine-authored stage marker is skipped without a code change when a new stage appears. These prefixes are strictly engine-authored (a human won't post `<!-- speckit-stage:* -->`), so the match is safe, and it does NOT catch the question-batch prefixes (`generacy-clarifications:`, `generacy-cockpit:clarifications-batch:`), leaving Q2's anchor unaffected. The lost 'audit trail of recognized stages' is a weak cost — all stage markers should be skipped uniformly.

### Q4: `createdAt` vs `updatedAt` for the newness check
**Context**: FR-004 uses `createdAt`. GitHub also exposes `updatedAt` on comments; an operator could edit the always-present `<!-- generacy-stage:specification -->` summary to append an answer, or edit their own earlier answer comment. Using `createdAt` alone means an edit never satisfies newness (a rigid replay-safety guarantee); using `updatedAt` means edits can advance the workflow (but a bot editing its own comment could re-trigger the loop the fix is trying to close).
**Question**: For the FR-004 newness comparison, does the monitor use `createdAt` only, or `updatedAt` as a fallback?
**Options**:
- A: `createdAt` only (as literally written). An edited comment never qualifies as "new" for resume purposes. Simple, replay-safe; the operator's remedy for a missed answer is to post a new comment.
- B: `updatedAt` when it exceeds `createdAt`. Enables edit-based answers, at the risk that a bot updating its own comment (e.g. spec-summary status refresh) could satisfy the newness bound.
- C: `createdAt` for non-bot authors, `updatedAt` for markers only — matches the FR-003(a) marker-based branch's tolerance and keeps the bot-summary edit case blocked.

**Answer**: A — `createdAt` only. Replay-safe and deterministic, and it blocks the re-trigger vector: the bot UPDATES its own `<!-- generacy-stage:specification -->` summary as phases progress, so an `updatedAt`-based check (B) would let that ever-advancing timestamp re-satisfy newness and reopen the loop. `updatedAt`-for-markers (C) adds complexity for no benefit given Q1 already filters bot/marker comments. The operator's remedy for a missed answer is to post a NEW comment (natural, cheap).

### Q5: App-bot login — hardcoded, config-driven, or runtime-discovered
**Context**: FR-002 names `generacy-ai[bot]` explicitly. FR-001's generic `[bot]`-suffix rule already covers *any* App-bot login regardless of string. The FR-002 special-case matters mainly if the App-bot must be treated as **cluster-self** (a stricter category than "any bot"), e.g. so cockpit's own answer-marker comment can be routed to a self-authorship code path even when it isn't structurally tagged as `viewerDidAuthor === true` in some future/refactored fetch path. Fork/staging clusters may run under a different App login (`staging-generacy[bot]`, `generacy-preview[bot]`, etc.).
**Question**: How does the monitor determine which specific `[bot]`-suffixed login represents the cluster's own App identity (FR-002's "self" case)?
**Options**:
- A: Hardcode the literal `generacy-ai[bot]` as FR-002 states. Simplest; matches the current single-App-installation reality. Fork/staging clusters bypass this branch and fall through to the generic FR-001 `[bot]`-suffix filter, which produces the same outcome (never counted as an answer) — the specificity was only about labeling in logs, not behavior.
- B: Read the App login from a config knob (env or `.agency/`), defaulting to `generacy-ai[bot]`. Enables fork/staging clusters without recompiling. Adds one more configuration surface to keep in sync.
- C: Discover the App login at runtime by calling `GET /repos/:owner/:repo/installation` (`app_slug + "[bot]"`) and caching the result. Zero config; requires a new API dependency the monitor doesn't have today.

**Answer**: A — hardcode `generacy-ai[bot]`. FR-001's generic `[bot]`-suffix filter already makes EVERY App-bot login (incl. fork/staging `staging-generacy[bot]`, `generacy-preview[bot]`, …) behave identically — never counted as an answer — so FR-002's self-identification only affects log labeling, not behavior. A config knob (B) or runtime `GET /installation` discovery (C) adds a config surface / API dependency for a behavior that doesn't vary. If a future need arises to route cluster-self answer-markers to a specific self-path, revisit then; today A is correct and simplest.

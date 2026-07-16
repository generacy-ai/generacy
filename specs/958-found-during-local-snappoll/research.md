# Research: #958 — authorship-gated clarification answer scanner

## Decision log

### D1 — Authorship signal: `viewerDidAuthor` over `authorAssociation` / `author.login`

`viewerDidAuthor` on the GraphQL `IssueComment` (and `PullRequestReviewComment`) is the field returned by GitHub for "the account making this query authored this comment." #910 already plumbed it through `getIssueCommentsWithViewerAuth()` (`packages/workflow-engine/src/actions/github/client/gh-cli.ts`) and pushed it into `Comment.viewerDidAuthor` (`packages/workflow-engine/src/types/github.ts:103`). This PR consumes the field; it does not add fetch surface.

**Alternatives considered:**

- **`author.login === CLUSTER_GITHUB_USERNAME`** — brittle across App-token vs. PAT-token clusters (the App impersonates a bot login; the PAT is the user's own login). It's exactly what #910 replaced with `viewerDidAuthor` for the same reason.
- **`authorAssociation === 'OWNER'` / `MEMBER'`** — this is the trust signal, not the authorship signal. Trust says "may I read this comment as an answer source at all"; authorship says "did *my credential* write this." Conflating them is what caused #910 to accidentally trust the bot's own questions comment on the answer surface.

`viewerDidAuthor` is the right axis: it is a self-report from GitHub answering the exact question we ask ("did I write this?"), not an inference from adjacent metadata.

### D2 — Cluster-self marker: HTML comment stamped by deterministic code (Q1 → A)

The spec's Q1 answer nails this down: `<!-- generacy-clarification-answers:<batch> -->`, matching the `<!-- generacy-cockpit:clarifications-batch:<n> -->` HTML-comment shape already used for question comments. The load-bearing constraint is *"the marker must be written by deterministic code, not by an agent following prompt instructions"* — otherwise the marker is improvised per run (four different agent-invented markers observed on #5/#6/#7/#8, spec §"Why #909's fix can't hold" table).

**Alternatives considered:**

- **B: Parser-only, no cockpit refactor.** Would leave cockpit's agent free-writing the answer comment. The marker would then be improvised per run, reproducing this bug on the answer side. Spec Q1 correction: cockpit-relayed answers don't work today because parsing works — they work because `completed:clarification` bypasses the gate whether or not anything integrated. There is no working parse path to preserve, so "no regression vs. today" is a non-property.
- **C: Reuse an existing marker.** No existing marker means "this is an answer from the engine's authoritative surface." The question-family markers (`<!-- generacy-clarifications:`, etc.) are for the *questions* posting-dedup surface; reusing them collapses the two families and breaks `matchClarificationQuestionMarker`'s pre-filter.
- **D: Non-marker signals** (comment metadata, GraphQL author-association, specific commenter identity). GraphQL author-association returns per-comment role tiers (OWNER / MEMBER / CONTRIBUTOR / …); it doesn't answer "was this written by the engine's answer-relay surface" — it answers "does this account have permission to write here."

### D3 — Column-0 marker match rule extends unchanged

The existing `commentCarriesQuestionMarker` (`clarification-markers.ts`) uses a column-0 rule: `line.startsWith(prefix)` on `\n`-split lines. Quoted (`> `-prefixed) markers do not match, deliberately — this protects the human "quote the questions while answering" flow. The new answer-marker family inherits the exact same rule: `commentCarriesAnswerMarker(body)` iterates `CLARIFICATION_ANSWER_MARKERS` with `line.startsWith(prefix)`.

**Consequence:** if a human quotes the engine's answer comment (unusual — the engine's answer comment is not typically visible to humans as a starting point for reply), the marker is `> `-quoted and does not match. That comment is then classified as human (`viewerDidAuthor === false`) and parsed permissively — the correct outcome.

### D4 — Quote-stripping via a pre-parse pass, not a regex change

Two options for the `> `-quoted-line handling:

- **Pre-parse stripping**: on entry to `parseAnswersFromComments`, transform each comment body into `strippedBody = body.split('\n').filter(line => !line.startsWith('> ')).join('\n')`. Run the existing regex against the stripped body.
- **Regex lookbehind**: modify the `Q<n>:` opener regex to require the line's first non-EOL character to not be `>`.

**Chosen: pre-parse stripping.** Regex lookbehind for "line does not start with `>`" is possible (`(?<=^|\n)(?!>\s)`) but couples two behaviors into a hard-to-read pattern. Pre-parse stripping is one line, testable in isolation, and gives us a natural place to preserve the FR-006 "keep the leading answer, drop the quoted tail" behavior (the strip step surfaces both slices: original and stripped).

**Consequence for FR-006:** the stripping pass returns `{ headBeforeFirstQuote: string, remainder: string }`; the parser uses `headBeforeFirstQuote` for the answer capture and treats `remainder` as untrusted. A valid `Q1: A` at the head is preserved even if `> **Question**: …` follows.

### D5 — FR-004 blast radius asymmetric per `viewerDidAuthor` (Q3 → C)

The Q3 answer is asymmetric:

- **Human tripping the detector**: overwhelmingly a normal quote-reply. Skip only the offending comment; other human comments in the same poll integrate. After D4's quote-stripping, quote-replies should not trip the detector at all.
- **Cluster-self tripping the detector**: a self-authored comment that carries the answer marker AND question headings means either a cockpit relay bug (the tool emitted a malformed body) or a forged / improvised marker slipping past the marker check. Unknown extent → abort the entire poll's integration, leave the gate armed. The blunt "abort everything" for human comments (option B in Q3) would silently discard everyone else's real answers — the friction this issue exists to remove.

### D6 — `hasPendingClarifications` fail-closed disambiguation

FR-007 says "missing spec dir / unreadable file / unparseable content" all return `true` (pause). Two edge cases warrant explicit design:

- **Legit empty file**: a `clarifications.md` file with zero questions is a valid post-clarify state ("no clarifications needed"). Distinguish from "unparseable" via a non-empty-content check: `content.trim() === ''` → `false` (legit empty = no pending); `parseClarifications(content).length === 0 && content.trim() !== ''` → `true` (parse failed, treat as pending).
- **Truly unreadable file** (I/O error at `readFileSync`): `try/catch` around `readFileSync`, catch → `return true` (was `return false`).

The `parseClarifications`-based path is the interesting one — today the function returns an empty array on parse failure, indistinguishable from a legit empty file. The signal is content presence: non-empty content + zero parsed questions == parse failure.

### D7 — Monitor's resume mechanism: enqueue, never label (Q4 → C)

The Q4 answer is definitive: **enqueue a resume queue item; the monitor MUST NOT apply `completed:clarification`**. Reasons:

1. `MergeConflictMonitorService` is the mirror pattern (spec §Assumptions), and it never applies a completion label — it uses `enqueueIfAbsent` (`merge-conflict-monitor-service.ts` L171).
2. `completed:clarification` bypasses the gate whether or not any answer parsed (`phase-loop.ts` L785). FR-011 could otherwise force-advance an issue with one of five questions answered — this issue's own bug rebuilt.
3. The gate deactivates *by itself* when `hasPendingClarifications === false`. No label is needed to signal "answers arrived."

Reserving `completed:clarification` for the human's explicit "proceed anyway, I know parsing failed" override is the clean split: the label is a human force-advance; the monitor is an auto-resume that respects the gate.

### D8 — Single-source `PENDING_ANSWER_LITERAL` constant (Q2 → C + B)

Q2 answer combines options B and C:

- **C**: introduce `PENDING_ANSWER_LITERAL = '*Pending*'` as a single exported constant, imported by prompt template (`clarify.ts` L55), parser (`clarification-poster.ts` L303), write-back regex builder (L738–L740), and cockpit answer-relay tool (for its "no answer supplied for Q<n>" rendering).
- **B tolerance on top**: `isPendingAnswerValue(v)` accepts empty, whitespace-only, any `[…]`-bracketed value, or the literal. The bracketed rule subsumes the legacy `[Leave empty for now]`, so no separate legacy handling is required.

The load-bearing property is *structural impossibility of divergence*. A shared constant makes the prompt say what the parser looks for, mechanically. B alone leaves the prompt and parser as independent literals (that's how we got here).

### D9 — Cockpit skill rewrite is companion, not blocker

The spec §Assumptions is explicit: cockpit-side lands in this same PR (Q1 answer, "both sides land together"). The skill file(s) under `.claude/skills/cockpit-clarify/` currently instruct the agent to `gh issue comment` the answer body freehand. Post-fix, the skill instructs invocation of the new `cockpit_relay_clarify_answers` MCP tool with a structured `{ [questionNumber]: string }` payload. The tool is the sole writer of the answer-marker.

Whether we extend `cockpit_advance` (add an `answers?` field) or add a sibling `cockpit_relay_clarify_answers` verb: **sibling verb**, per the spec §"Fix" FR-003 note ("extend `cockpit_advance` or add a sibling verb"). Cleaner tool boundary — advance is a gate flip, relay is a comment+labels transaction. Callers dispatch on intent, not on payload presence.

## Sources / references

- `packages/orchestrator/src/worker/clarification-poster.ts` — L488 sniff (defect), L303 parser literal, L738-740 write-back regex, L610 `integrateClarificationAnswers`, L381 `hasPendingClarifications`.
- `packages/orchestrator/src/worker/clarification-markers.ts` — column-0 rule + marker match idiom to mirror.
- `packages/orchestrator/src/worker/phase-loop.ts` — L723 `onPhaseComplete` (FR-008 moves), L771 `if (!gateActive) continue` (FR-009 hoists over), L815 `postClarifications` call site.
- `packages/orchestrator/src/services/merge-conflict-monitor-service.ts` — the shape template for `ClarificationAnswerMonitorService` (Q4 confirms this is the reference).
- `packages/generacy/src/cli/commands/cockpit/advance.ts` — L162 `gh issue comment` audit-line site; the answer-relay refactor is a sibling of this.
- `packages/generacy/src/cli/commands/cockpit/manual-advance-marker.ts` — deterministic-stamping pattern to mirror for `formatClarificationAnswerComment`.
- `packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts` — L55 prompt template (`[Leave empty for now]` → `${PENDING_ANSWER_LITERAL}`).
- `packages/workflow-engine/src/types/github.ts:93-103` — `Comment.viewerDidAuthor` semantics (populated by `getIssueCommentsWithViewerAuth` only; non-`true` treated as not-self).
- `packages/workflow-engine/src/security/comment-trust.ts` — `isTrustedCommentAuthor` (unchanged; runs downstream of authorship + marker gate).
- specs/909-found-during-cockpit-v1/plan.md — retiring the marker-allowlist as the primary gate.
- specs/910-found-during-cockpit-v1/plan.md — `viewerDidAuthor` plumbing already in place.
- specs/898-found-during-cockpit-v1/contracts/monitor-contract.md — reference contract shape for the new monitor.

## Non-decisions (deliberately deferred)

- **Prose / numbered-list answer forms** (`"go with A for the first"`, `1. A`) — spec §Out of Scope. Raises false-positive risk without an authorship gate; may revisit after this PR.
- **`issue_comment` webhook subscription** — spec §Out of Scope. The monitor is authoritative.
- **General "detect fabricated-answer fingerprints across repos" recovery tool** — spec §Out of Scope, tracked as its own issue if wanted.
- **Cross-cluster clarification flows** — spec §Out of Scope.
- **`christrudelpw/snappoll#7` reset** — Q5 answer: out-of-band ops task, not this PR (FR-013 removed).

# Research: Clarification-answer monitor mistakes bot comments for human answers

**Feature**: `993-summary-orchestrator-s`
**Date**: 2026-07-18

## Question 1 — Why does `isTrustedCommentAuthor` not filter the App-bot login itself?

The trust helper's bot-login branch at `packages/workflow-engine/src/security/comment-trust.ts:100-110`:

```ts
if (ctx.botLogin) {
  const normalizedBot = normalizeLogin(ctx.botLogin);
  const normalizedAuthor = normalizeLogin(comment.author);
  if (normalizedBot !== '' && normalizedBot === normalizedAuthor) {
    return { trusted: true, reason: 'bot' };
  }
}
```

`ctx.botLogin` on the monitor is populated from `this.clusterGithubUsername` (`clarification-answer-monitor-service.ts:199-200`). On the snappoll cluster, that resolves to the **account** (`christrudelpw`) via the identity resolver, not the **App login** (`generacy-ai[bot]`) that authors the actual comments. `normalizeLogin` strips `[bot]` from both sides — but it's the *pre-normalization* login of the ambient identity that's wrong.

Two ambient realities collide:

1. The cluster PAT identity is a real user account (`christrudelpw`) — that's what `clusterGithubUsername` resolves to.
2. The App installation token authors comments as `generacy-ai[bot]` — that's the login on the wire.

`normalizeLogin(clusterGithubUsername) === 'christrudelpw'` ≠ `normalizeLogin('generacy-ai[bot]') === 'generacy-ai'`. The bot-branch never fires; the comment falls through to the `authorAssociation` check, which for App-installation-authored comments is `MEMBER` (App has admin/write via installation), returning `{ trusted: true, reason: 'member' }`. Every bot comment satisfies the "trusted human" predicate.

**Decision**: fix at the monitor call site, not inside the trust helper.

**Alternative considered**: change `isTrustedCommentAuthor` to always fail on `[bot]`-suffixed authors. **Rejected** — the trust helper is shared across three surfaces (`answer-scanner`, `clarify-resume`, `pr-feedback`), and the pr-feedback surface *legitimately* trusts self-authored (`viewerDidAuthor === true`) bot comments as "cluster-self" (that's how the phase-loop resumes its own drafts). A blanket `[bot]` refusal in the helper would break pr-feedback. Scoping the filter to this monitor keeps the fix's blast radius at one file.

**Alternative considered**: pass a different `botLogin` value to `isTrustedCommentAuthor` (e.g. the string literal `'generacy-ai[bot]'`). **Rejected** — the trust helper's bot branch produces `trusted: true, reason: 'bot'`, but the monitor's downstream code treats every `trusted: true` as a "human answer." Marking it `trusted: true, reason: 'bot'` doesn't distinguish it. The correct signal at the monitor is "this comment is not from a human, drop it" — a distinct concept from trust.

## Question 2 — Why is `commentCarriesMachineMarker`'s enumerated list insufficient?

Evidence from snappoll:

```
#5 comments (all authored by generacy-ai[bot]):
  1. <!-- generacy-stage:specification -->
  2. <!-- speckit-stage:clarification -->
  3. <!-- generacy-clarifications:5 -->
```

The MACHINE_MARKERS enumeration includes `<!-- speckit-stage:specification`, `<!-- speckit-stage:planning`, `<!-- speckit-stage:implementation` — but not `<!-- speckit-stage:clarification`. So comment #2 falls through the marker skip.

Comment #1 (`<!-- generacy-stage:specification -->`) *is* enumerated, so it gets skipped by the marker filter. But comment #2 reaches the trust check, and per Q1 above, passes it. So the monitor enqueues a resume.

**This is the second known enumeration-drift bug on this list.** The first was `<!-- generacy-clarification-answers:` (added #976). The pattern is: any new engine-authored stage marker requires touching this file. That's brittle.

**Decision (Q3=C)**: swap the stage-family enumeration for a family-prefix match on `<!-- generacy-stage:` and `<!-- speckit-stage:`. The other MACHINE_MARKERS families (`generacy-cockpit:manual-advance`, `generacy-clarification-answers:`, `generacy-untrusted-answer:`, `generacy-clarification-parse-failures:`) stay enumerated — they don't fit a family shape, and enumeration for them is the correct discipline.

**Safety check**: could a human ever legitimately post a `<!-- generacy-stage:X -->` comment? These prefixes are strictly engine-authored (the codebase's only writers are `packages/workflow-engine/src/actions/github/add-comment.ts` and the speckit posters). A human posting one is a deliberate act of workflow manipulation; treating it as machine-noise is the correct response. Same reasoning for `<!-- speckit-stage:X -->`.

**Safety check**: does the family match catch the question-batch prefixes (`generacy-clarifications:`, `generacy-cockpit:clarifications-batch:`)? No — those start with `<!-- generacy-clarifications:` and `<!-- generacy-cockpit:clarifications-batch:`, neither of which begins with `<!-- generacy-stage:` or `<!-- speckit-stage:`. The FR-004 anchor set is unaffected.

**Non-decision**: `MACHINE_MARKERS` remains a `readonly string[]` exported constant even though the family-match values are no longer strictly the same shape as the enumerated members. Downstream callers of `MACHINE_MARKERS` (verified: none outside `clarification-markers.ts`) don't iterate — they call the `commentCarriesMachineMarker` / `matchMachineMarker` predicates. So the family match can live inside the predicate implementation without changing the exported array's shape.

## Question 3 — Why `created_at` and not `updated_at` for FR-004 newness?

The ever-present `<!-- generacy-stage:specification -->` summary is the smoking gun. Its content is regenerated by the phase loop as phases progress, and GitHub's `updated_at` advances every time the phase loop patches the body.

An `updated_at`-tolerant newness check would allow this summary comment to *always* satisfy the "newer than latest question comment" bound, because the phase loop keeps ticking it forward. Even worse: the summary's initial `created_at` is *older* than any subsequent clarification-question comment, so `created_at` alone naturally excludes it. Switching to `updated_at` would flip that safety.

**Decision (Q4=A)**: `created_at` only. This is a hard invariant: no `updated_at` fallback anywhere in the predicate.

**Edge case considered — real human edits their answer to fix a typo**: with `created_at`, the edit doesn't advance newness, so a monitor that already resumed on the pre-edit answer sees no change (idempotent — the resume is already queued or already ran). A monitor that hasn't resumed yet still sees the pre-edit `created_at`, which is newer than the questions if the original comment was posted after the questions. Both paths work correctly with `created_at` only. The pathological case (`updated_at`-only edit to a pre-question comment) has no legitimate meaning — an operator wouldn't answer clarification questions by editing a comment they posted before the questions were asked. If they need to, they post a new comment (the spec's stated remedy).

**Edge case considered — operator uses `updated_at` on their own comment to advance answers post-hoc**: same-account trust already covers same-user edits via the `viewerDidAuthor === true` short-circuit in the trust helper (`comment-trust.ts:122-124`); but that path fires *only* when the fetching credential is the same as the authoring credential. Operators using their PAT vs. their App session vs. their web UI can produce mismatches. The right primitive is still: `created_at` for newness, post-a-new-comment for retries. Simplicity wins here.

## Question 4 — What defines "the latest clarification-question comment" for the newness anchor?

The candidates:

- **A**: newest `created_at` among comments whose body matches any prefix in `CLARIFICATION_QUESTION_MARKERS`.
- **B**: highest numeric suffix in `<!-- generacy-clarifications:N -->`, fallback to A.
- **C**: newest `created_at` among a narrower subset (only `<!-- generacy-clarifications:` and `<!-- generacy-cockpit:clarifications-batch:`, excluding umbrella `<!-- generacy-stage:clarification`).

**Decision (Q2=A)**: A. Simplest, robust to any future question-marker family, and handles iterative clarify cycles correctly (an answer to batch N must beat batch N's timestamp, and batch N is the newest by `created_at`).

**Why not B**: numeric-suffix parsing assumes numbering. Question comments from cockpit's `<!-- generacy-cockpit:clarifications-batch:` family are numbered differently (batch id, not question id). A fallback would be required for markers that don't carry a numeric suffix (the umbrella marker, older dialects). Extra code for no additional guarantee.

**Why not C**: narrowing risks missing a future question-marker family added to `CLARIFICATION_QUESTION_MARKERS`. The whole point of the registry is that it's the single source of truth — the anchor set should read *from* it, not fork away from it.

**Caveat**: if the umbrella `<!-- generacy-stage:clarification -->` marker is ever emitted **after** a question batch (currently it's emitted first, as part of the clarify prelude), it could mis-anchor. The registry documents `generacy-stage:clarification` as a question-family member; if timing evidence emerges that it's actually a "clarify started" prelude that outlives the last question, exclude it from the anchor set. Not needed today per direct read of `clarification-poster.ts`.

## Question 5 — Why don't we call `GET /repos/:owner/:repo/installation` to discover the App login?

The App login is currently the string literal `generacy-ai[bot]`. Fork/staging clusters may run under different Apps (`staging-generacy[bot]`, `generacy-preview[bot]`, etc.). The FR-002 discussion asks whether the monitor should discover this at runtime.

**Decision (Q5=A)**: no. FR-001's generic `[bot]`-suffix filter already makes **every** App-bot login behave identically — never counted as an answer. Discovery would only affect *log labeling* ("cluster-self" vs "external bot"), not behavior. Adding a new API dependency + caching for a log line is a poor trade.

**When would this change**: if a future need arises to route cluster-self answer-markers to a specific self-path (e.g. the monitor DOES want to integrate cockpit-relayed answers directly, bypassing the `completed:clarification` label). Today the label path is documented and working — the monitor is deliberately not that source of truth.

## Question 6 — Why don't we widen `CLARIFICATION_ANSWER_MARKERS` to accept bot markers?

FR-003(a) says a marker-carrying comment authored by a **non-bot** counts as an answer. `commentCarriesAnswerMarker` returns true on any comment carrying `<!-- generacy-clarification-answers:` — including bot comments (which is what the cluster's cockpit-relay posts). If the monitor treated marker-carrying bot comments as answers, the loop would still close (because the resume then integrates a real answer body).

**Decision (Q1=A)**: no. Cluster-relayed answers are integrated via the `completed:clarification` label + LabelMonitorService. The relay adds the label, LabelMonitorService resumes the phase-loop, the phase-loop integrates from `clarifications.md`. This monitor's job is to catch **new external human comments** — not to duplicate the relay path.

Rationale for keeping the paths separate:

- **Fewer race conditions**. If both the label path and this monitor's marker path fire on the same relay comment, the resume queue must dedupe. Today the paths are disjoint (label → LabelMonitor; free-text human comment → this monitor). Merging them would require a dedup key that spans both, which is more state to maintain.
- **Simpler predicate to audit**. "Answer means non-bot" is a one-line policy anyone can eyeball. "Answer means non-bot OR bot-with-answer-marker" adds a case that's easy to trip on later.
- **The bug in scope reopens if bot markers count**. The literal question in Q1 is: "if a `[bot]` author posts a marker comment, does it count?" Saying yes reopens the vector: the cockpit-relay's marker is authored by the cluster's own `generacy-ai[bot]` — the exact identity that caused this whole loop. The marker doesn't rescue.

## Question 7 — Does the `viewerDidAuthor === true` short-circuit inside `isTrustedCommentAuthor` interact with the FR-001 bot filter?

`isTrustedCommentAuthor` at line 122-124 returns `{ trusted: true, reason: 'self-authored' }` when `viewerDidAuthor === true`. If the monitor's fetching credential is the App installation token and the comment was authored by that same App installation, `viewerDidAuthor === true` and the trust helper returns trusted-self.

But: the FR-001 bot filter runs *before* the trust helper is called. So a `[bot]`-suffixed author never reaches the `viewerDidAuthor` check inside the trust helper — the monitor exits early. This means the trust helper's self-authored branch is dead code *from the monitor's perspective* for `[bot]`-authored comments (which is precisely the set the FR-001 filter targets).

**Decision**: fine. `viewerDidAuthor` remains meaningful for the *other* surfaces (`clarify-resume`, `pr-feedback`) that call the trust helper. This monitor's early bot filter is a stricter policy — bot comments never count, whether or not `viewerDidAuthor` fires. No change to the trust helper.

**Non-decision**: we do NOT delete the `viewerDidAuthor === true` short-circuit at line 122 of `comment-trust.ts`, even though the FR-001 filter makes it unreachable *from this monitor*. Deleting it would break `clarify-resume` and `pr-feedback` where self-authorship *is* the intended trust reason. Out of scope.

## Key references

- Spec: `specs/993-summary-orchestrator-s/spec.md`
- Clarifications: `specs/993-summary-orchestrator-s/clarifications.md`
- Monitor: `packages/orchestrator/src/services/clarification-answer-monitor-service.ts` (lines 156–260 for the predicate)
- Markers registry: `packages/orchestrator/src/worker/clarification-markers.ts`
- Trust helper: `packages/workflow-engine/src/security/comment-trust.ts` (unchanged, referenced for context)
- Comment type: `packages/workflow-engine/src/types/github.ts:72-104`
- GraphQL fetch that populates `viewerDidAuthor` and `created_at`: `packages/workflow-engine/src/actions/github/client/gh-cli.ts:318-392`
- Related issues: #958 (this monitor's introduction), #976 (previous marker-enumeration fix), #987 (adaptive-polling — same service, different logic)

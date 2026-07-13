# Research: Marker-based exclusion in clarification answer-scanner (#909)

## Decision 1 — Marker match rule: prefix substring, case-sensitive, ASCII, column-0-anchored

**Chosen**: prefix substring (`startsWith` per line) over the four FR-101 prefixes. Line-anchored to column 0. Case-sensitive ASCII.

**Rationale** (from clarify Q1→B + Q3→B):

- The dialect set is provably open: `generacy-stage:clarification`, `generacy-stage:clarification-batch-1` (this very issue's own batch comment), `generacy-clarifications:`, and `generacy-cockpit:clarifications-batch:` are all attested, with future variants like `-batch-2` clearly plausible. Exact-string containment (option A in Q1) misses every future variant by construction. The snappoll#4 fixture's marker is `<!-- generacy-stage:clarification-batch-1 -->` — the exact suffix variant that motivated Q1.
- Case-sensitivity: markers are engine-emitted constants written by the codebase, not by humans. There's no realistic path to a `<!-- Generacy-Stage:...` variant that we'd want to match, and locking case-sensitivity now costs nothing.
- Anchored regex per marker (Q1 option C) defends against accidental substring collisions in the middle of a body. But the four prefixes all live in our own `<!-- generacy-` namespace — the only *realistic* false-positive path is a human quoting the marker (US4), which is a positional problem, not a lexical one. So we solve it positionally (column-0), which is simpler than compiling four regexes.
- Column-0 rule (Q3→B): GitHub's `> ` block-quote is verbatim. A trusted human whose reply quotes the questions comment before adding their answers would otherwise trigger the exclusion and have their answers silently dropped. Excluded comments never reach the trust check, so unlike the untrusted path there's no explainer — the operator did the right thing and the gate just stays paused with zero signal. Column-0 anchoring costs one `split('\n')` + `startsWith` and removes the failure mode entirely.

**Rejected alternatives**:

- *Exact-string containment* — fails Q1's `-batch-1` variant, i.e., fails SC-001 out of the gate.
- *Anchored regex per marker* — one regex compilation per marker for defense against a false-positive class that can't realistically occur inside our own namespace. Column-0 anchoring solves the one real path (US4 quoted markers).
- *First-non-whitespace-line only* (Q3 option C) — under-excludes the moment any engine dialect emits a heading or preamble line before the marker. The current dialects put the marker first, but there's no code contract binding future variants to that shape.

## Decision 2 — Delegate `isQuestionComment` marker branch to the new predicate

**Chosen**: `isQuestionComment` calls `commentCarriesQuestionMarker(body)` as its first branch; the three inline `.includes()` calls at `clarification-poster.ts:212–216` are deleted. Content-shape branches (`### Q<n>:` split + `**Question**:` etc.) stay.

**Rationale** (from clarify Q2→B):

- FR-108's "single source" is only true of the whole file under this option. Leaving the three inline `.includes()` in place would grandfather in the pre-existing duplication under the new invariant — SC-007's grep guard would have to be scoped-out to `isQuestionComment` specifically, which is a lie about the invariant.
- One crucial note about this refactor: this finding exists precisely because `isQuestionComment` **existed but was never called** on the scan path. `parseAnswersFromComments` had its own hand-rolled FR-002 sniff that only caught the `**Question**:`/`**Context**:` dialect. So the tests must assert wiring at the `integrateClarificationAnswers` seam (the caller), not just the predicate in isolation — otherwise we'd ship the same recurrence-by-oversight.

**Rejected alternatives**:

- *Standalone* (Q2 option A) — leaves the duplication, forces the SC-007 guard to have exceptions. Ships the invariant with a footnote.
- *Two constants* (Q2 option C) — answers a different question. The posting-marker constant (`MARKER_PREFIX` at line 163) is a separate marker family; keeping it separate is fine but doesn't address where the *exclusion* markers live. We do both — posting-marker constant stays, exclusion predicate is new, and `isQuestionComment` delegates.

## Decision 3 — New module `packages/orchestrator/src/worker/clarification-markers.ts`

**Chosen**: dedicated module alongside `clarification-poster.ts`.

**Rationale** (from clarify Q4→B):

- **Named downstream consumer**: #910 (clarify-resume surface) needs the same predicate. Its dependency enforcement wants to reference the exclusion as a first-class import from a small module, not a helper buried in a 600-line poster module.
- **FR-108's "future markers land in one place"** gets a literal address — the file's raison d'être is the marker set.
- **Testability**: a dedicated test file (`clarification-markers.test.ts`) exercises the predicate in isolation without dragging in the poster module's WorkerContext mocks. The integration seam still gets its own coverage in `clarification-poster.test.ts` per FR-110.

**Rejected alternatives**:

- *Alongside `isQuestionComment` in `clarification-poster.ts`* (Q4 option A) — works today but creates awkward import shape for #910: importing `commentCarriesQuestionMarker` from a `-poster` file signals the wrong thing about coupling.
- *Package-boundary lift to `@generacy-ai/workflow-engine`* (Q4 option C) — speculative package extraction. Both known consumers (this file + #910) are orchestrator-side. Lift when a second **package** actually needs it. Spec Out-of-Scope § confirms.

## Decision 4 — Log at debug level, structured, no body

**Chosen**: `logger.debug({ event: 'clarification-answer-scanner-marker-excluded', commentId, author, markerPrefix, issueNumber }, 'Excluded from answer-scanner via question marker')`.

**Rationale** (from clarify Q5→B):

- Exclusion is **steady-state**: every healthy clarify cycle excludes the questions comment(s), and the scanner re-runs every poll cycle. Info level would emit the same idempotent line thousands of times per epic.
- Full structured shape stays (event name, commentId, author, markerPrefix, issueNumber) so it's grep/JSON-decodable the moment someone investigates at debug level. The event name is long-form to match existing surface conventions (`comment-skipped`, etc.).
- Body is deliberately absent — matches the SC-003 discipline elsewhere in the file (`logCommentSkipped` at line 58 also excludes body). No secret concern for comment bodies specifically, but the shape stays consistent.
- Q5→A (info level) would give the same shape but flood logs. Q5→C (leave to implementer) is exactly how two surfaces end up with two observability dialects — the drift genus this smoke test keeps finding.

## Decision 5 — Filter runs BEFORE trust check (not just after)

**Chosen**: the marker filter runs on the raw `comments` array before `isTrustedCommentAuthor` is called.

**Rationale**:

- FR-103 requires trust-independence. Placing the filter *after* trust would technically still work today (the bot is currently untrusted → the batch would fall into the "post an explainer" branch, and the marker filter could then intercept before the explainer POST). But that's structurally fragile: once #910 lands and the bot is trusted, the flow branch changes. The clean invariant is **"marker-excluded comments are structurally invisible to every downstream branch, including trust and the explainer."**
- Practical harm avoided: today, `postUntrustedAnswerExplainers` fires against the bot's own questions comment and posts a misleading "rejected answers" explainer. By moving the marker filter earlier, that path is impossible — the bot's questions never reach `skippedForExplainer`.
- The existing content-shape sniff inside `parseAnswersFromComments` (FR-002 → FR-106) still fires as belt-and-suspenders for anything that slips through unmarked.

**Rejected alternatives**:

- *Filter after trust* — works but breaks the invariant #910 will silently rely on.
- *Filter both places* — redundant. One correct barrier is enough.

## Decision 6 — Test coverage at the integration seam, not just the predicate

**Chosen**: `integrateClarificationAnswers` gets a new test block asserting the wiring; the predicate also gets its own file.

**Rationale** (FR-110):

- **This finding exists because `isQuestionComment` was tested but never called on the scan path.** The predicate in isolation could pass 100% of unit tests while the parser silently ingested question comments. The regression fixture must exercise `integrateClarificationAnswers` (or `parseAnswersFromComments` with the wiring in place) to guard against the same class recurring.
- SC-002's trust-independence assertion in particular can only be exercised at the integration seam — the predicate itself doesn't know about trust; the point of SC-002 is that the *flow* correctly runs the marker filter before trust.

## Implementation patterns referenced

- **Marker-substring dedup**: `postClarifications` at line 755–765 already reads two marker prefixes for its own dedup. This is the same pattern applied to a different concern (exclusion, not dedup); consistent stylistic precedent.
- **Structured warn/info logs**: `logCommentSkipped` at line 58 and the FR-002 warn at line 479 both use `logger.warn({ code, commentId, ... }, 'message')` shape. FR-107 mirrors it at debug level.
- **Content-shape sniff coexisting with marker check**: `isQuestionComment` at line 210 already has both a marker branch and a content-shape branch. This PR keeps the shape and consolidates the marker branch behind the predicate.
- **Filter-before-`parseAnswersFromComments`**: the existing code at line 643 (`answerComments = trustedComments.filter(...isQuestionComment...)`) is exactly the seam being extended. The extension moves the filter *earlier* in the flow so trust doesn't see marker-excluded comments; it does not remove or change any downstream parsing step.

## Key sources / references

- `packages/orchestrator/src/worker/clarification-poster.ts` — modified file, all line references in this doc are against the current tree state.
- `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts` — extended file; existing `isQuestionComment` tests at line 673 provide the pattern for new coverage.
- `packages/orchestrator/src/worker/types.ts` — `STAGE_MARKERS` (line 90) is a separate posting-marker family, deliberately not touched (spec Out-of-Scope §).
- `@generacy-ai/workflow-engine` `isTrustedCommentAuthor` — imported at `clarification-poster.ts:11`; unchanged. Marker filter runs upstream of it.
- generacy-ai/generacy#910 (finding #52) — the FR-105 ordering constraint depends on this PR landing first; #910 is the immediate downstream consumer of the FR-108 exports.
- snappoll#4 (christrudelpw/snappoll) — original observed failure. The batch comment ID 4938943909 with marker `<!-- generacy-stage:clarification-batch-1 -->` and `### Q<n>:` headings is the SC-001 fixture.

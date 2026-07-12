# Research — Found during the cockpit v1

## Decisions

### D1. Insertion position for `waiting-for:address-pr-feedback` in `WAITING_PIPELINE_ORDER`

**Decision**: Index 1 (immediately after `blocked:stuck-feedback-loop`, ahead of every `waiting-for:*` gate).

**Rationale**: Follows the #883 precedent verbatim: "surface the more-specific active state first when both coexist." An actively-rewriting-code state (worker literally editing files right now) is more-specific than **any** passive review gate it might coexist with, not just its documented co-occurrent (`implementation-review`). Index 1 preserves the one ordering that must still win — `blocked:stuck-feedback-loop` outranking it (the pause trumps the activity) — and it is robust against any future co-occurrence the FR-010 audit (or a real incident) surfaces.

**Alternative — Index 5 (immediately before `implementation-review`)** (Q1→B in clarifications): Minimum-diff literal reading of FR-001. Would fix the observed case (the pair `implementation-review + address-pr-feedback`) but leaves `address-pr-feedback` outranked by every other `waiting-for:*` in any future co-occurrence — silently re-manufactures the same invisibility bug for whichever pair shows up next. Rejected because Q1's answer is A.

**Reference**: `packages/cockpit/src/state/precedence.ts:26-36` (current order), clarifications.md Q1.

---

### D2. Which handler exit paths clear `agent:in-progress`?

**Decision**: All four terminal returns, implemented structurally at a single shared exit path (try / `finally`, or one coalesced call that skips the `finally` redundantly).

**Rationale (Q2→C)**:
- `agent:in-progress` means "a worker is working this issue *now*." At every one of the handler's four terminal returns — Case A (line 222), Case B (line 232), blocked-stuck (lines 302 / 337), happy (line 357) — the handler is *done*. The label is stale at all four, not just where `removeFeedbackLabel` happens to run.
- Case B's retained `waiting-for:address-pr-feedback` and the blocked-stuck disposition's added `blocked:stuck-feedback-loop` do not change that: the coexisting `agent:in-progress` in either terminal state is a lying label pair (the #902 under-cleaned-terminal-state family, applied verbatim).
- #879's single-in-flight-per-issue rule guarantees no other legitimate writer holds `agent:in-progress` when this handler returns, so the widest reading is also safe.
- A per-site edit at each of the four returns is fragile: a future fifth terminal return will reintroduce the leak. Hoisting the clear to a shared exit path (SC-005) makes the invariant structural rather than convention-based.

**Alternative A** (Q2→A): Only the paths that already call `removeFeedbackLabel` (Case A + happy). Split the other two into follow-up issues. Rejected because the #902 terminal-outcome invariant is about *exit-state truth*, not about which labels an exit path happens to touch — fragmenting one invariant into multiple PRs buys nothing.

**Alternative B** (Q2→B): Only line 357 (happy path). Narrowest reading. Rejected because it leaves the same stale label on the other three exits.

**Reference**: clarifications.md Q2; `packages/orchestrator/src/worker/pr-feedback-handler.ts:222,232,302,337,357`.

---

### D3. Interpretation of "single combined label edit" (FR-006)

**Decision**: One `removeLabels(owner, repo, issueNumber, ['waiting-for:address-pr-feedback', 'agent:in-progress'])` client invocation on the happy path.

**Rationale (Q3→A)**:
- The GitHub REST label API has no true atomic multi-label edit. "Single combined edit" maps to "one client-side invocation, fewest intermediate states," not "atomic on the server" (same caveat recorded in #902 Q5).
- `add-before-remove` is vacuous on the happy path — nothing is being added; two labels are removed.
- Partial failure at the network layer is possible but no worse than the alternative of two sequential `removeLabels` calls with a crash between them (which the current handler already tolerates via best-effort catch blocks).

**Alternative** (Q3→B): Two sequential `removeLabels` calls, one label each — preserves per-label failure isolation. Rejected because per-label failure isolation is an illusion at this layer (the client may decompose either shape into per-label HTTP calls internally); the "one client invocation, one intent" reading is cleaner.

**Reference**: clarifications.md Q3; `GitHubClient` interface at `packages/workflow-engine/src/actions/github/client/interface.ts:267-272` (single-label-array `removeLabels(labels: string[])`).

---

### D4. Scope of unlisted-gate promotions in this PR

**Decision**: Only `waiting-for:address-pr-feedback` is promoted in this PR. The other six unlisted gates from the docstring at `precedence.ts:22-24` are audited in the plan phase (FR-010) — any gate with demonstrated co-occurrence gets its own follow-up issue with its own co-occurrence analysis; the rest stay as-is with the finding recorded.

**Rationale (Q4→A + amendment)**:
- Only `address-pr-feedback` has an observed incident (snappoll-1 run 9) and understood co-occurrence semantics.
- Blanket promotion (Q4→C) assigns arbitrary precedence positions to gates whose co-occurrence semantics nobody has established — real regression surface for status/context classification.
- Pairing with `waiting-for:pr-feedback` (Q4→B) is docstring adjacency, not evidence. `pr-feedback` currently has no runtime writer (see audit in `data-model.md`), so on-issue co-occurrence is not possible today.
- Applying the finding-#52 lesson ("fix one surface; verifiably-identical siblings must not stay broken") requires an *evidence* bar — the plan-phase audit provides that evidence per gate.

**Reference**: clarifications.md Q4; audit table in `data-model.md`.

---

## Sources / References

- `packages/cockpit/src/state/precedence.ts` (WAITING_PIPELINE_ORDER, compareSourceLabels).
- `packages/orchestrator/src/worker/pr-feedback-handler.ts` (four terminal returns).
- `packages/workflow-engine/src/actions/github/client/interface.ts` (`addLabels` / `removeLabels` shapes).
- `packages/workflow-engine/src/actions/github/label-definitions.ts` (label declarations).
- `packages/workflow-engine/src/actions/workflow/update-phase.ts:41-51` (WAITING_FOR_LABELS map — writer for `clarification-review`, `children-complete`, `address-pr-feedback`).
- `packages/orchestrator/src/worker/epic-post-tasks.ts:123` (writer for `children-complete`).
- `packages/orchestrator/src/services/epic-completion-monitor-service.ts:45` (reader / remover for `children-complete`).
- `packages/orchestrator/src/worker/config.ts:71-73` (gate config that pauses on `sibling-review` alongside `implementation-review`).
- `packages/cockpit/src/__tests__/classifier.test.ts` (existing classifier assertions).
- Precedent: PR #883 (`blocked:stuck-feedback-loop` promoted to index 0).
- Precedent: #902 (terminal-outcome invariant — under-cleaned label sets).
- Precedent: #879 (single-in-flight-per-issue rule).
- Precedent: #403 (efficiency contract — no re-check on every event).
- Historical incident: snappoll-1 run 9 (`generacy-ai/tetrad-development#92`, finding #60).

---

## Implementation Patterns

- **Precedence table edit is one string added at index 1.** Existing `compareSourceLabels` logic handles it without change (unlisted still sorts after listed, listed compared by index).
- **Structural exit refactor uses try/finally.** Matches the existing "non-fatal on failure, logged" pattern of `removeFeedbackLabel` / `addBlockedStuckFeedbackLoopLabel`.
- **Coalesced `removeLabels(['label1', 'label2'])` is already supported** by the client interface (accepts a string array), so no interface change is needed.
- **Test fixtures** follow the existing `packages/cockpit/src/__tests__/classifier.test.ts` and orchestrator worker test patterns — no new test infrastructure.

---

*Generated by speckit*

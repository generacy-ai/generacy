# Clarifications: Address-pr-feedback flow must not advance implementation-review gate

**Issue**: [#941](https://github.com/generacy-ai/generacy/issues/941)
**Branch**: `941-summary-during-snappoll`

---

## Batch 1 — 2026-07-15

### Q1: Root-cause scope — culprit-first, invariant-first, or both
**Context**: The spec's leading hypothesis (Assumptions §1) is that the offending writer of `completed:implementation-review` lives in the address-pr-feedback flow. Code recon shows `PrFeedbackHandler.handle()` (packages/orchestrator/src/worker/pr-feedback-handler.ts) does NOT write `completed:implementation-review` on any exit path — it manages only `waiting-for:address-pr-feedback`, `agent:in-progress`, and `blocked:stuck-feedback-loop`. The actual writer may live in a monitor, a post-fix-session phase re-run through `phase-loop.ts`, or somewhere else entirely. This shapes whether "fix the specific writer" (FR-001) or "install a global invariant" (FR-003) is the primary deliverable.
**Question**: What is the primary deliverable of the fix?
**Options**:
- A: **Culprit-first** — locate the exact code path that writes `completed:implementation-review` in this scenario and remove/gate the write there. FR-003 is deferred as follow-up.
- B: **Invariant-first** — install a runtime guard in `LabelManager` that rejects any `completed:<human-gate>` write not tagged as coming from `cockpit advance` (audit-comment path) or an approve-review handler. Root-cause diagnosis is a byproduct of adding the guard (any current writer will trip it).
- C: **Both** — locate and remove the specific writer AND install the invariant guard as defense-in-depth. FR-003 lands in the same PR.

**Answer**: C — Both: locate and remove the specific writer AND install the LabelManager invariant guard as defense-in-depth, in the same PR. *Rationale*: The snappoll evidence shows two anonymous advances via what may be different sub-flows (31 and 14 minutes after their respective reviews), and recon has already eliminated the leading suspect — a culprit-only fix risks whack-a-mole, while a guard-only fix would start rejecting an unknown live writer in production without understanding what breaks downstream. The guard also doubles as the diagnostic that finds the writer.

---

### Q2: Approve-review auto-advance path — existence & scope
**Context**: FR-006 states the fix "MUST NOT break the happy path where a follow-up approve review legitimately unblocks the gate." FR-003 says legitimate writers of `completed:<human-gate>` include "an approve-review-triggered auto-complete path." Code recon does not surface any existing handler that watches for PR review `APPROVED` events and writes `completed:implementation-review`. The evidence timeline in snappoll#3 is on `speckit-bugfix` where `waiting-for:implementation-review` has condition `on-request` — meaning the gate only activates when explicitly requested — so an auto-advance from an approve review may have never existed here.
**Question**: Does an approve-review auto-advance path currently exist, and is creating one in scope for this fix?
**Options**:
- A: **Exists — protect it.** Point implementer at the existing handler; FR-006 is a real regression guard.
- B: **Does not exist — leave `cockpit advance` as the only writer.** FR-006 is a null constraint; FR-003 collapses to "the audit-comment path is the only writer." Approve-review auto-advance is out of scope (separate future feature).
- C: **Does not exist — create it as part of this fix.** Net-new capability: an approve-review handler writes `completed:implementation-review` + the `<!-- generacy-cockpit:manual-advance -->`-shaped audit comment (or an equivalent approve-review audit marker).

**Answer**: B — No approve-review auto-advance path exists; leave `cockpit advance` as the only legitimate writer. FR-006 is a null constraint and approve-review auto-advance is out of scope (separate future feature). *Rationale*: Every legitimate approval in the snappoll run flowed through `cockpit_advance` (all review verdicts are visible as advance calls in the operator transcript) — there is no happy path to protect. Creating a second writer inside the very change whose purpose is locking writers down works against the invariant; it can ship later as its own feature with its own audit marker.

---

### Q3: Terminal label state — re-add responsibility
**Context**: FR-002 mandates the terminal label state after the address-pr-feedback session is `waiting-for:implementation-review + agent:paused`. Today, `waiting-for:implementation-review` is added at gate-hit time (`LabelManager.onGateHit`) and — under normal flow — remains present when `pr-feedback-monitor-service` layers on `waiting-for:address-pr-feedback` and enqueues the fix session. But `LabelManager.onResumeStart` (`label-manager.ts:231`) strips all `waiting-for:*` labels at resume time, and if a resume runs between the fix session and the operator observing state, the gate label could be transiently missing. This determines whether the handler needs an explicit re-add.
**Question**: If `waiting-for:implementation-review` is missing from the issue at the moment the address-pr-feedback session terminates, must the handler re-add it?
**Options**:
- A: **Re-add defensively.** The handler always ensures `waiting-for:implementation-review` is present on exit (idempotent add). Simplest guarantee of FR-002.
- B: **Never re-add.** The handler only guarantees non-removal of `waiting-for:implementation-review` and non-write of `completed:implementation-review`. If the gate label is missing when the session ends, that's a bug in another code path (e.g., an unwanted `onResumeStart` invocation) and out of scope here.
- C: **Assert then re-add on mismatch, log-loud.** If `waiting-for:implementation-review` is missing at session exit, log a structured `error` line (`{ event: 'gate-label-missing-at-fix-exit', ... }`) and re-add — surfaces the underlying bug while still satisfying FR-002.

**Answer**: C — Assert then re-add on mismatch, log-loud: if `waiting-for:implementation-review` is missing at fix-session exit, emit a structured `gate-label-missing-at-fix-exit` error line and re-add it. *Rationale*: A silent defensive re-add satisfies FR-002 but buries the evidence of whichever path stripped the label — hidden masking between redundant mechanisms is exactly the defect class rev 3 exists to eliminate. C gives the same operator-visible guarantee while making the underlying bug loud enough to earn its own issue.

---

### Q4: FR-003 defensive-check site
**Context**: FR-003 mandates a defensive check that only two writers may add `completed:<human-gate>` labels. The check can live at several layers: a runtime guard in the label-writing seam (rejects the API call), a per-caller assertion (throws before calling), or test-only coverage (unit tests assert no unauthorized writer exists in current code). The choice affects blast radius (does the guard break existing tests? does it need a caller-identity mechanism?) and long-term durability (a test-only invariant can be regressed by a future refactor).
**Question**: Where should the FR-003 invariant be enforced?
**Options**:
- A: **Runtime guard in `LabelManager.applyLabels`** — reject any call adding a `completed:<human-gate>` label unless the caller passes an authorization token (e.g., `AllowGateComplete.CockpitAdvance` or `AllowGateComplete.ApproveReview`). Requires threading a token through call sites. Strongest enforcement.
- B: **Per-caller assertion at each writer site** — every place that writes `completed:<gate>` throws unless a source predicate matches. No shared guard type; each callsite documents its own justification.
- C: **Test-only invariant** — the FR-003 protection is a test that greps the codebase (or uses static analysis) to enforce "only `cockpit_advance.ts` and `<approve-review handler>` reference `completed:<human-gate>` writes." No runtime cost; regressed by refactor.

**Answer**: A — Runtime guard in `LabelManager.applyLabels`: reject any `completed:<human-gate>` add unless the caller passes an authorization token (e.g. `AllowGateComplete.CockpitAdvance`). *Rationale*: The writer being defended against is unknown — per-caller assertions only cover callers already found, and a test-only invariant is regressed by the first refactor. The seam guard is the only placement that catches writers we haven't met yet, and it is what makes Q1's diagnosis work.

---

### Q5: FR-005 regression-test layer
**Context**: FR-005 requires "a regression test [covering] request-changes review posted → address-pr-feedback session completes without resolving → the gate label state remains `waiting-for:implementation-review`." This can be implemented at three layers: a unit test on `PrFeedbackHandler` (fast, cheap, but only proves the handler itself doesn't do the write); an integration test that drives `phase-loop.ts` through a request-changes → fix-session cycle (proves the interaction chain, but slower); or a full end-to-end test spawning a real orchestrator + monitor + worker + mocked GitHub (highest fidelity, slowest). The choice affects whether the test is regression-locked *against a specific writer* or *against the invariant*.
**Question**: At what layer should the FR-005 regression test operate?
**Options**:
- A: **Unit test on `PrFeedbackHandler`** — asserts the handler never calls `github.addLabels(…, ['completed:implementation-review'])` on any exit path. Fastest, but only locks the *suspected* writer.
- B: **Integration test on the phase-loop / worker route** — drives a simulated `address-pr-feedback` queue item end-to-end through the worker and asserts the final label set on the mock GitHub client matches `{ 'waiting-for:implementation-review', 'agent:paused' }`. Locks the whole write chain in that flow.
- C: **Full end-to-end** — spawns `LabelMonitorService` + `PrFeedbackMonitorService` + `ClaudeCliWorker` against a mock GitHub, injects a request-changes review, asserts terminal issue state. Highest fidelity, slowest, most brittle.

**Answer**: B — Integration test on the phase-loop / worker route: drive a simulated address-pr-feedback queue item end-to-end and assert the terminal label set is `{waiting-for:implementation-review, agent:paused}` on the mock GitHub client. *Rationale*: Recon already suggests the handler itself is innocent, so a unit test on it locks the wrong door; the failure lived in the interaction chain, which the integration layer covers at a fraction of end-to-end's cost and flakiness. The Q4 seam guard brings its own unit tests, so the cheap layer is covered anyway.

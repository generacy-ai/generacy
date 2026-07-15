# Clarifications: Detect repeat-identical phase failures and escalate instead of retrying verbatim

**Issue**: #942
**Branch**: `942-summary-when-phase-fails`

## Batch 1 — 2026-07-15T17:19:33Z

### Q1: Failure fingerprint granularity
**Context**: FR-001 defines a "stable failure fingerprint" that must match across worker invocations for the same underlying defect but differ when the defect changes. The three plausible granularities carry very different false-positive / false-negative trade-offs. Too broad (phase + classifier alone) risks conflating two genuinely-different failures with the same classifier; too narrow (full reason text) risks missing a repeat when the reason has a timestamp or per-run detail baked in. This determines what `computeFailureFingerprint()` returns and directly gates RT-001 / RT-002.
**Question**: What tuple should the failure fingerprint be computed from?
**Options**:
- A: `{ phase, classifier }` — coarsest. Any two failures of `implement` classified `no-product-code-changes` collapse to one fingerprint regardless of reason text or output.
- B: `{ phase, classifier, sha256(reason_text) }` — medium. Same classifier but different underlying reason text (e.g. two different constraint violations) count as different fingerprints.
- C: `{ phase, classifier, sha256(reason_text + last_N_lines_of_output) }` — finest. Adds output tail so a classifier bucket that spans multiple root causes still discriminates.
- D: Something else (please specify)

**Answer**: *Pending*

### Q2: Fingerprint history persistence mechanism
**Context**: FR-002 forbids in-memory-only state (every external requeue starts a fresh worker invocation with counters reset). Two natural persistent surfaces exist: (a) the GitHub issue's `failure-alert` comment thread, which is already tamper-visible and survives cluster rebuilds, or (b) a new Redis/state-store keyspace scoped to `<owner>:<repo>:<issue>`. The choice affects failure modes (GitHub API rate limits vs. Redis availability), the shape of the detection code path, and whether history survives issue re-creation.
**Question**: Where should the fingerprint history be persisted?
**Options**:
- A: GitHub issue `failure-alert` comment thread. Detection re-scans comments (via `gh` / octokit) on each failure, extracts fingerprints from the comment marker, counts matches.
- B: New Redis keyspace (e.g. `failure-fingerprint:<owner>:<repo>:<issue>:<fingerprint>` → count, first-seen-at, last-alert-comment-id). Follows the `phase-tracker:*` pattern in `packages/orchestrator/src/services/phase-tracker-service.ts`.
- C: Both — write to Redis for fast detection, embed fingerprint hex in the comment marker as an audit backstop.
- D: Something else (please specify)

**Answer**: *Pending*

### Q3: Escalation label spelling, threshold N, and coexistence with `failed:<phase>`
**Context**: FR-003 leaves three coupled decisions unspecified: (1) the exact escalation label string (which downstream automation, cockpit verbs, and label allowlists in `LabelManager` will hard-code), (2) the threshold N at which escalation fires (issue text proposes 2; a higher N might reduce false escalations on genuinely-flaky-once phases), and (3) whether the escalation label REPLACES `failed:<phase>` (cleaner state, but breaks any tooling that watches for `failed:*`) or SUPPLEMENTS it (backwards-compatible, but two labels to reason about). RT-004 explicitly flags this as a clarification-driven decision.
**Question**: What are the label spelling, threshold N, and coexistence behavior?
**Options**:
- A: Label `failed:<phase>-repeated`, N=2, SUPPLEMENTS (both `failed:<phase>` and `failed:<phase>-repeated` present). Backwards-compatible with any tool watching `failed:*`.
- B: Label `failed:<phase>-repeated`, N=2, REPLACES (only `failed:<phase>-repeated` applied, `failed:<phase>` never added or removed if already present). Cleanest state; requires label allowlist audit.
- C: Label `escalation:repeat-failure`, N=2, SUPPLEMENTS `failed:<phase>`. Namespaces the escalation separately from `failed:*`.
- D: Something else (please specify label, N, and coexistence rule)

**Answer**: A — Label `failed:<phase>-repeated`, N=2, SUPPLEMENTS `failed:<phase>` (both labels present).
**Rationale** (@christrudelpw): Supplementing keeps every existing `failed:*` consumer working (including the cockpit classifier's error tier) while the `-repeated` suffix stays greppable in the same prefix family; replacing breaks exact-match watchers for no meaningful state-cleanliness gain. N=2 is right by the evidence: snappoll#8's three failures were byte-identical, so escalating on the second would have saved a full wasted retry with zero information lost.

### Q4: Cockpit verb scope for clearing escalation
**Context**: FR-006 requires the escalation to be reversible by an operator, but leaves open whether a first-class cockpit verb (e.g. `generacy cockpit clear-escalation <issue-ref>` or a variant of `cockpit resume` from #891) ships as part of this issue or is deferred to a follow-up. Deferring means operators use `gh issue edit --remove-label` manually in v1, which is workable but less discoverable. Shipping the verb here doubles the surface area of this change.
**Question**: Does a dedicated cockpit verb for clearing the escalation ship in this issue?
**Options**:
- A: Ship a new dedicated verb (e.g. `cockpit clear-escalation`) in this issue.
- B: Extend the existing `cockpit resume` from #891 to also clear the escalation label as part of its normal action, no new verb.
- C: Defer entirely — v1 relies on manual `gh issue edit --remove-label failed:<phase>-repeated`; a cockpit verb is a follow-up issue.
- D: Something else (please specify)

**Answer**: B — Extend the existing `cockpit resume` (#891) to also clear the escalation label as part of its normal action; no new verb.
**Rationale** (@christrudelpw): Resume is already the operator's "re-arm this failed phase" verb, and it is what the snappoll operator actually reached for on #8 and #13 — clearing the escalation there matches real usage with zero new surface area. A standalone verb would be a second thing to discover that is almost always run adjacent to resume anyway.

### Q5: Count-reset semantics when escalation is manually cleared
**Context**: RT-007 explicitly flags ambiguity: after an operator clears the escalation label (per FR-006), the next same-fingerprint failure could either (a) restart the count at 1 (treats the clearance as "operator confirms the retry is worth trying again from scratch") or (b) resume the prior count and immediately re-escalate on the very next failure (treats the clearance as "operator has fixed the upstream artifact — one more failure means the fix didn't work"). The two semantics have opposite effects on operator UX and on how many retries a mis-diagnosed fix consumes.
**Question**: When an operator clears the escalation label, how should the fingerprint count behave on the next same-fingerprint failure?
**Options**:
- A: Reset count to 1 — the escalation was "acknowledged and dismissed"; treat subsequent failures as fresh. Operator gets N-1 more retries before re-escalation.
- B: Resume prior count — clearance is not a reset; the very next same-fingerprint failure re-escalates immediately. Operator must clear again to buy one more attempt.
- C: Reset only if the operator also removes the `failed:<phase>` label (interpreted as "artifact repaired"); otherwise resume.
- D: Something else (please specify)

**Answer**: B — Resume the prior count: clearance means "I believe I repaired the input; verify with one attempt," so the very next same-fingerprint failure re-escalates immediately.
**Rationale** (@christrudelpw): The identical fingerprint is the whole signal: if the operator's repair worked, the fingerprint changes or the phase passes and the count is moot; if it recurs byte-identical, burning N-1 more retries re-creates precisely the waste this issue exists to stop. The conditional two-label protocol (option C) is subtle enough that operators would trip over it.

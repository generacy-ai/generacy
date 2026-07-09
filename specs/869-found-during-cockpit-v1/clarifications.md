# Clarifications

<!-- Batch 1 · 2026-07-09 -->

### Q1: Shared predicate vs. documented asymmetry
**Context**: FR-005 lets the implementer choose either (a) a single shared trust predicate imported by both monitor and handler, or (b) explicit documented asymmetry with the handler's zero-trusted path made non-destructive. This choice materially shapes the diff — (a) refactors `LabelMonitorService`/`PrFeedbackMonitorService` polling to filter unresolved threads by author trust before enqueue; (b) keeps monitor over-enqueue but hardens the handler. It also decides whether FR-002/FR-003 (loud zero-trusted retention) is a permanent contract or a transitional guard.
**Question**: Which path should the implementation take?
**Options**:
- A: Shared predicate — refactor monitor to filter unresolved threads through the same `isTrustedCommentAuthor` used by the handler; enqueue is trust-aware; FR-002/FR-003 loud-retention becomes the fallback for cases the monitor still can't screen (e.g., race between poll and comment edit).
- B: Documented asymmetry — monitor continues to enqueue on any unresolved thread; handler owns all trust filtering; asymmetry is documented in-code (comment referencing this spec and #862) and FR-002/FR-003 becomes the permanent load-bearing contract.
- C: Implementer's discretion, pick whichever has smaller diff and document the choice in `plan.md`.

**Answer**: *Pending*

### Q2: Bot-notice idempotency mechanism (FR-004)
**Context**: FR-004 says the zero-trusted-exit notice must be idempotent — "one notice per zero-trusted state, not per poll." The spec doesn't say how to detect "already posted." Marker-in-body detection is simple but pollutes PR conversation with a magic string; a Redis-backed key is cleaner but adds a new state store dependency; issue-comment reactions leave the visible PR clean but require an extra API call. The choice affects visibility, test surface, and cleanup semantics when the state exits zero-trusted.
**Question**: How should the handler detect "notice already posted for this zero-trusted state"?
**Options**:
- A: Hidden HTML marker in comment body (e.g., `<!-- generacy:pr-feedback-untrusted-notice -->`) — grep prior PR comments on each poll; delete/edit when state exits zero-trusted.
- B: Redis dedupe key keyed on `<owner>:<repo>:<pr>:pr-feedback-untrusted-notice` (own TTL, own settlement rules); mirrors existing `phase-tracker:*` layout.
- C: Only post once per handler invocation and skip counting altogether — accept 1-per-poll cadence (noisy) as the initial cut; tighten later.
- D: Do not post any notice — drop FR-004 to zero and rely only on the `warn` log line from FR-003. (Rationale: bot-authored comments on the PR risk being counted as unresolved threads themselves under FR-001's expanded trust set.)

**Answer**: *Pending*

### Q3: Dedupe settlement on exception paths (FR-006)
**Context**: FR-006 requires the enqueue-dedupe key to be settled on "every terminal exit path (success, zero-trusted retention, exception)." "Success" and "zero-trusted" are unambiguous, but "exception" spans transient failures (network flap talking to GitHub) and permanent failures (malformed thread data). Clearing on transient failures risks a busy-loop with the monitor re-enqueuing every poll; preserving until TTL risks stranding the same class of bug this fix is closing. #862's dedupe redesign changes the semantic but does not itself decide this policy for #869's fix window.
**Question**: On a caught exception in the handler, what should happen to the dedupe key?
**Options**:
- A: Clear on all exceptions — retry immediately on next monitor poll. Accept the busy-loop risk on persistent failures (mitigated by monitor rate limit).
- B: Preserve on all exceptions — let TTL rescue. Accept the strand risk for transient failures until #862 lands. (This is arguably the current behavior modulo FR-002.)
- C: Distinguish by exception class — clear on transient (`ETIMEDOUT`, `ECONNRESET`, 5xx from `gh`), preserve on permanent (malformed data, 4xx). Requires a small classification helper.
- D: Defer entirely to #862 — FR-006 is verification-only in this issue; no code change to exception path in the interim.

**Answer**: *Pending*

### Q4: Behaviour when cluster identity is unresolvable
**Context**: FR-001 requires the trust set to include the "resolved cluster identity." Assumption 1 says if resolution fails, the handler "falls through to the existing `author_association` gate" and this is "a defensible degradation but should be logged." That is silent about whether FR-002/FR-003 (loud retention + `warn` log) still applies in this degraded mode. Given the whole point of this fix is that silent-success at zero-trusted is the recurrence surface of #861, letting the identity-unresolvable path silently strip the label would re-open the exact wound.
**Question**: When the identity resolution chain returns nothing at runtime and the only comments are from an unknown bot with `author_association: NONE`, what is the handler's behaviour?
**Options**:
- A: FR-002/FR-003 still apply — retain the label, emit `warn`, log the identity-resolution failure prominently; treat unresolvable identity as "safety over recovery."
- B: Legacy behaviour — remove the label and log the identity-resolution failure at `error`; accept that the operator will notice via the log line.
- C: Fail-loud stop — throw a specific `ClusterIdentityUnresolvedError` from the handler; let the worker's error path decide; monitor keeps re-enqueuing until identity resolves.

**Answer**: *Pending*

### Q5: Where the FR-004 notice is posted (and self-trust risk)
**Context**: FR-004 mandates a "bot-visible notice … to the PR." Two placement choices exist: (a) a top-level PR issue comment (via `gh pr comment`) or (b) a reply on each unresolved review thread (via the review-comments API). Choice (b) is more visible to the operator working the thread but creates a subtler problem: under FR-001, comments authored by the cluster identity are now trusted — so the next monitor poll would see the bot's own notice as an "unresolved trusted comment on an unresolved thread" and hand it to the worker to address. The trust filter has no built-in way to distinguish "feedback the operator posted through the cockpit" from "notice the handler itself posted." Placement (a) sidesteps this because top-level PR comments are not review-thread comments and are not what the monitor's unresolved-thread scan enumerates.
**Question**: Where does the FR-004 notice go, and how is the self-trust loop prevented?
**Options**:
- A: Top-level PR comment via `gh pr comment` — no interaction with review-thread scanner; simplest; slightly less contextual for the operator.
- B: Reply on each unresolved review thread + suppress the bot's own notice comments in the trust predicate via a marker-body check (adds a targeted skip rule specifically for FR-004 notices).
- C: Reply on each unresolved review thread + resolve the thread from the bot immediately after posting the notice — the thread is then "resolved" and drops out of the monitor's enumeration. (Operator can re-open when they reply from a maintainer account.)
- D: Both A and B — top-level PR comment as the primary surface and per-thread reply as an extra hint; requires the marker-suppression rule from B.

**Answer**: *Pending*

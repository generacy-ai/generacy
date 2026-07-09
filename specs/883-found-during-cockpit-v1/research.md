# Research: PR-feedback loop termination (#883)

Design decisions behind the plan, plus the alternatives considered and rejected.

## 1. `resolveReviewThread` is the termination edge (not un-labeling, not resolving on the PR checkbox side)

**Decision:** Call the `resolveReviewThread` GraphQL mutation on each addressed thread after commit+push.

**Rationale:** The monitor's trigger is thread-level `isResolved`. Nothing else the handler writes (label change, PR comment, workflow status) transitions that plane. The mutation is the one and only edge that turns the trigger off. Manual verification 2026-07-09 on `christrudelpw/sniplink#4` proved the App token can execute it (5/5 successes), which forecloses the alternative of "surface an authorization gap and ask the operator to resolve manually."

**Alternatives rejected:**
- Un-labeling only (today's behavior): reproduces the observed bug — the loop's trigger persists because the label plane and the thread plane are decoupled.
- Detach the monitor from `isResolved` and use a different trigger (e.g., "no new comments since the bot's last reply"): breaks the operator's clean re-entry path via un-resolve; is also a much larger surface change.
- Have the handler close the whole PR feedback item as `agent:done` and rely on out-of-band cleanup: silent completion, no per-thread verification signal to the operator.

## 2. Input-set closure for "threads it addressed" (spec Q2-A)

**Decision:** The set of threads the handler resolves = every trusted unresolved thread present at cycle start.

**Rationale:** The spec walks through the counter-examples on real data: the `zod` comment on this PR was anchored at `lib/validation.ts:1` (the import site) while its fix landed in `package.json`. Any diff-locus intersection (options B/C in Q2) would have left that thread unresolved forever, reproducing the original bug on the subset. Over-resolution costs the operator one un-resolve click (FR-008); under-resolution costs a permanent stuck loop. The asymmetry is decisive.

**Alternatives rejected:**
- Diff-locus intersection (B): file-path based — leaves off-locus threads stranded, is the exact re-trigger scenario the spec exists to end.
- Diff-hunk intersection (C): line-range based — same issue as B, stricter, same failure mode.
- Transcript-parsing (semantic acknowledgment): brittle, requires reading Claude's JSON logs, coupling handler to CLI output shape.

## 3. Bounded synchronous retry per mutation (spec Q1-C)

**Decision:** `resolveReviewThread` retries 3× with backoff 1s/2s/4s before treating a failure as terminal. The retry lives inside `github.resolveReviewThread`, not in the caller.

**Rationale:** GitHub GraphQL is called over HTTPS through `gh api`; transient 5xx and secondary-rate-limit responses are the realistic failure class for a network-heavy batch. Absorbing them synchronously (~7s worst case for 3 tries per thread) keeps the batch cost bounded — with 5 threads and worst-case retries, the batch adds ~35s to a cycle that already spends ~3 minutes in the CLI. This is negligible.

Placing the retry in the client method (not the handler) keeps the handler's per-thread loop flat and makes the retry semantics testable in isolation.

**Alternatives rejected:**
- No retry — the persistent-fail path (deleted thread, permission change) still needs handling; without retry, every transient blip strands the thread.
- Async retry with backoff via a queue — overkill for a per-cycle bounded batch; the queue itself becomes new state to reason about.
- Retry in the handler with a shared helper — moves the fault domain to the wrong layer; makes the client interface leaky.

## 4. Strict-decrease as the sole success test after retries (spec Q1 tail / FR-006 / FR-010)

**Decision:** After the batch (each thread has completed its retry budget), the cycle logs success iff `resolveSuccesses ≥ 1`. Successes clear the label; failures each emit exactly one warn naming the thread and the manual remedy.

**Rationale:** All-or-nothing (Q1-B) reproduces the original loop-forever bug in miniature: one anomalous thread (deleted, permissioned-away) holds the whole cycle hostage, the trigger stays active, the loop re-fires. Strict-decrease is the truthful ratchet — every cycle either makes measurable progress or takes the blocked disposition.

**Alternatives rejected:**
- All-or-nothing (Q1-B): reproduces the bug for the persistently-failed subset.
- Per-thread pass/fail on the item level (fail the cycle if any thread failed): coarser than the current design; loses the informative warns.

## 5. Interleaved reply→resolve per thread (spec Q4-C)

**Decision:** For each thread in the input set: post the reply, then call `resolveReviewThread`. Label clear happens once, after the loop.

**Rationale:** Interleaving makes each thread's outcome atomic-ish (both-succeeded / reply-only / neither), which is what makes the per-thread counting in FR-010 coherent. Reply-first inside the pair leaves the human with a diagnostic breadcrumb on any thread whose resolve failed — a reply without resolve is one click from fixed; a resolve without reply is silent completion (collapsed thread, no notification, no "please verify" ping).

**Alternatives rejected:**
- Batch-then-batch (Q4-A: reply-all, then resolve-all): if the reply POST succeeds but resolve fails, threads are indistinguishable from today's bug from the monitor's POV; next cycle re-fires and posts another duplicate reply on a "replied but unresolved" thread.
- Batch reverse (Q4-B: resolve-all, then reply-all): a resolve without reply is a silent-completion UX regression.

## 6. Reply granularity: one reply per root thread (FR-005)

**Decision:** The reply loop iterates threads (not comments). The reply targets the thread's `rootCommentId`.

**Rationale:** The observed amplification (5 → 10 → 20 replies per cycle) came from iterating `unresolvedComments` — a flat list that grew each cycle because bot replies were themselves comments in the same thread. Iterating threads and posting one reply per root breaks the amplification even before the terminating-edge fix lands.

**Alternatives rejected:**
- Filter comments by author before iterating: fragile, requires bot-login knowledge in the handler, still fails on repeated cycles that happen faster than filter-cache updates.
- Keep per-comment iteration but dedupe by root: same end state as per-thread iteration, but reads worse (you're grouping-then-collapsing an unnecessarily-large input).

## 7. Reply text: SHA-parameterized, no cycle counter (spec Q5, B-minus-counter)

**Decision:** `"Addressed in <sha> — please review, and re-open this thread if it still falls short."` where `<sha>` is the short hash of the just-pushed commit.

**Rationale:** The SHA is naturally stateless (the handler just pushed it) and makes the text self-truthing on every cycle. A re-triggered cycle that produces no diff posts no reply at all (FR-003) and lands in the blocked disposition — so the text never gets an "in-latest-commit" lie again. The cycle counter (Q5-B) requires the handler to count prior bot replies on the thread to derive N — that's new state and buys nothing that GitHub's un-resolve/re-resolve markers and distinct SHAs don't already show.

**Alternatives rejected:**
- Same static text every cycle (Q5-A): the current text ("in the latest commit") is literally false on a re-triggered cycle where the operator disagreed with the last commit.
- Include cycle counter (Q5-B full): stateful for no operator benefit.
- Branch on first-cycle vs. later (Q5-C): requires a "is there a prior bot reply on this thread" lookup — new state, no operator benefit.

## 8. Blocked disposition: new `blocked:stuck-feedback-loop` label + `blocked:*` prefix skip (spec Q3-B)

**Decision:** No-diff cycles (and cycles with zero resolve successes) leave `waiting-for:address-pr-feedback` in place, add `blocked:stuck-feedback-loop`, and the monitor skips enqueueing while ANY `blocked:*` label is present.

**Rationale:** Q3-A (do nothing) is the exact eternal-churn this spec exists to end. Q3-C (mark item as `agent:failed`) misreports a design condition as an agent crash. B is the honest signal: "the loop paused itself because it can't advance." Making it a `blocked:*` prefix (not a specific label) means future stuck-in-a-different-way situations can add sibling labels without touching the monitor skip logic.

The label is added at the same code site as the FR-006 warn — no separate branch. Removing the label is the operator's explicit signal that they want another attempt (a click in the UI, no CLI plumbing).

**Alternatives rejected:**
- New workflow phase or state — infrastructurally heavy for a signal that fits naturally in an existing label.
- Item-level agent status — misleading (nothing crashed), and item status is a separate plane from labels which is already used inconsistently.

## 9. Cockpit classifier: `blocked:*` → `waiting` tier, pipeline-priority above all `waiting-for:*` (FR-011)

**Decision:** Extend `classifyByPattern` with a `blocked:*` branch mapping to `waiting`; prepend `blocked:stuck-feedback-loop` to `WAITING_PIPELINE_ORDER`.

**Rationale:** The `waiting` tier already carries the semantics FR-011 asks for — "actionable escalation-gate state (not idle, not in-progress)". Idle == `pending` / `unknown`; in-progress == `active`. Reusing the tier avoids a taxonomy expansion; giving `blocked:*` top pipeline priority means an issue that carries both `waiting-for:address-pr-feedback` and `blocked:stuck-feedback-loop` renders `blocked:stuck-feedback-loop` as its `sourceLabel`. `cockpit watch` naturally emits a transition line when `sourceLabel` changes; no CLI-side change is needed.

**Alternatives rejected:**
- New `blocked` tier at rank 2 (above `waiting`): adds a state to every consumer's rendering path (UI, CLI, tests) for a signal that fits inside `waiting`.
- Leave classification alone and add a special-case in `cockpit watch` / `cockpit status`: bypasses the classifier — the library's whole point.

## 10. Monitor label check: `getIssueLabels` per polled trust-live PR

**Decision:** Fetch the linked issue's labels between the trust-live check and the enqueue call.

**Rationale:** One extra API request per polled trust-live PR (bounded by the open-PR count of the cluster's assigned issues). At the current poll cadence (~5 min) this is negligible. Alternative was to piggyback on `PrLinker.linkPrToIssue(...)` — but `PrLinker` returns assignees not labels, and expanding its return type couples an unrelated abstraction.

**Alternatives rejected:**
- Push blocked-label state into a monitor-local map: brittle (miss the transition when the operator clears the label out-of-band).
- Read labels from the queue-manager item snapshot: labels live on GitHub, not in the queue item; wrong source of truth.

## Sources / references

- Live incident 2026-07-09 10:52–11:04Z on `christrudelpw/sniplink#4` / PR #14 — the observed churn recorded in spec §Observed.
- GitHub GraphQL: `resolveReviewThread` mutation ([docs](https://docs.github.com/en/graphql/reference/mutations#resolvereviewthread)).
- `packages/workflow-engine/src/actions/github/client/gh-cli.ts:479` — existing `getPRReviewThreads` GraphQL call, extended by this change.
- `packages/orchestrator/src/worker/pr-feedback-handler.ts:596` — existing per-comment reply loop, replaced by the per-thread inline loop.
- `packages/cockpit/src/state/label-map.ts`, `precedence.ts`, `classifier.ts` — cockpit classifier and precedence, extended by this change.
- Spec `#861` (thread-level `isResolved`), `#869` (untrusted-notice), `#878` (`viewerDidAuthor`), `#879` (in-flight dedupe) — prior work in the same handler/monitor pair. `#883` is the terminating-edge companion, not a rework.

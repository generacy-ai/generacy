# Clarifications

## Batch 1 — 2026-07-09

### Q1: Partial `resolveReviewThread` failure semantics
**Context**: FR-001 says the handler MUST resolve each thread it addressed; FR-006 says every successful cycle MUST strictly decrease the unresolved-thread count. Live verification recorded 5/5 mutations succeeding under the App token — but the batch is called via network to `api.github.com/graphql`, so transient 5xx / secondary-rate-limit / node-not-found responses on a subset of threads are realistic. Spec is silent on how partial success interacts with the success/warn log and the label clear. This directly reproduces the original bug in miniature if not addressed: a cycle where 4/5 resolves succeed but 1 fails would leave the trigger active and re-fire the loop with a growing reply batch on the un-resolved thread.
**Question**: If `resolveReviewThread` succeeds for some threads but fails for others in the same cycle, does the cycle count as successful (log success + clear `waiting-for:address-pr-feedback` label) so long as the unresolved-thread count strictly decreased, or is any partial failure an anomaly that must warn and hold the trigger?
**Options**:
- A: Strict-decrease is the sole success test — if at least one resolve succeeded (unresolved count strictly dropped), log success + clear label; emit one `warn` per failed resolution so the operator can un-resolve/re-trigger if desired.
- B: All-or-nothing — any failed resolution warns and does NOT log success; label is NOT cleared; the next monitor poll re-enqueues and the handler retries the remaining threads (idempotent because succeeded threads no longer appear as unresolved).
- C: Retry each failed mutation synchronously with bounded backoff (e.g., 3 tries × 1s/2s/4s) before deciding per Q1-A or Q1-B; treat post-retry failure as the terminal outcome.

**Answer**: C, then A — bounded synchronous retry per failed mutation (3× with backoff) absorbs the transient-5xx class; after retries, strict-decrease is the success test: if the unresolved count dropped, log success, clear the label, and emit one `warn` per persistently-failed thread naming it and the manual remedy (one click in the UI, guided by the reply that *is* on the thread). Pure B risks an infinite CLI-burning loop on a mutation that will never succeed (deleted thread, permission change) — holding the whole cycle hostage to one anomalous thread reproduces the churn this spec ends. The leftover unresolved thread then flows into Q3's disposition on the next cycle, which is the correct pressure valve.

### Q2: Definition of "threads it addressed"
**Context**: FR-001 says the handler resolves "each thread it addressed"; FR-005 says one reply per unresolved root thread; FR-006 asserts strict decrease of the unresolved count. But "addressed" is never defined. The three plausible sets diverge in behavior:
- (a) All trusted unresolved threads at cycle start — includes threads the CLI's diff didn't touch (e.g., a formatting nit the CLI ignored). Resolving these still "addresses" them per the reply text ("I've addressed this feedback…") but is technically dishonest if the diff doesn't include the fix.
- (b) Only threads whose file/line locus intersects the diff — honest but requires per-thread diff-vs-locus check; threads outside the diff are left unresolved, so the trigger persists and the next cycle re-fires (reproducing the original bug for the untouched subset).
- (c) Only threads the CLI's transcript explicitly acknowledges — requires transcript parsing, brittle.

Under-resolving (b/c) risks reproducing the terminating-edge bug for the un-addressed subset; over-resolving (a) risks resolving threads whose fix isn't actually in the diff.
**Question**: Which set of threads must the handler resolve (and reply to) at the end of a successful cycle?
**Options**:
- A: All trusted unresolved threads that existed at cycle start (input-set closure) — treat the whole batch as the unit of work; if a specific thread wasn't fixed by the diff the operator un-resolves it (FR-008 re-entry). Simplest, matches the observed working cycle (5 addressed → 5 resolved).
- B: Only threads whose file paths intersect the diff — per-thread locus check; un-touched threads stay unresolved, monitor re-polls; accept the risk that a subset can re-fire the loop until the CLI addresses them or the operator resolves manually.
- C: Only threads whose file+line range intersects the diff hunks — stricter than B; same re-fire risk on the untouched subset.

**Answer**: A — input-set closure: every trusted unresolved thread at cycle start. The locus-intersection options (B/C) fail on real data from this very PR: the `zod` comment was anchored at `lib/validation.ts:1` (the import) while its fix landed in `package.json` — any diff-locus check would have left that thread unresolved and re-fired the loop forever on a comment that *was* fixed. If the CLI judged a comment to need no code change, that is still an answer — the reply says so and the thread resolves; the operator's un-resolve (FR-008) is the honest disagreement channel. Under-resolution is the original bug; over-resolution costs one click to undo.

### Q3: No-diff cycle disposition (label / gate / item state)
**Context**: FR-003 says a no-diff cycle MUST NOT post replies; FR-004 says it MUST NOT log success and MUST emit a `warn` line naming the persisting trigger. Spec is silent on what the worker does next: the `waiting-for:address-pr-feedback` label, the workflow item's phase/status, whether any new label is added to make the stuck state visible. This matters because option choices diverge in operator experience:
- Leaving everything untouched means the monitor re-polls, re-detects unresolved threads, and re-enqueues → identical no-diff cycle re-runs at poll cadence (~5 min), burning Claude CLI compute forever until an operator intervenes. That's the exact churn this spec exists to end.
- Adding a `blocked:*` label pauses the loop cleanly but requires operator to notice + clear.
- Failing the item makes it appear as an agent failure in cockpit, which may be misleading (nothing crashed).
**Question**: On a no-diff cycle, what disposition does the worker apply beyond the FR-004 `warn` line?
**Options**:
- A: Leave `waiting-for:address-pr-feedback` label and workflow gate untouched; end the item without changing labels or status. Monitor will re-poll and re-fire an identical no-diff cycle every poll interval until the operator intervenes. (Loop restart IS the operator signal; log volume grows.)
- B: Leave `waiting-for:address-pr-feedback`; ADD a new `blocked:stuck-feedback-loop` label; monitor must skip enqueueing while `blocked:*` is present. Operator removes the label to permit another attempt.
- C: Leave `waiting-for:address-pr-feedback`; mark the item as `agent:failed` (surfaces as an item failure in cockpit); monitor keeps re-polling but does not re-enqueue while `agent:failed` is present.

**Answer**: B — leave `waiting-for:address-pr-feedback` (truthful state, per #879's Q3), add `blocked:stuck-feedback-loop`, and the monitor skips enqueueing while any `blocked:*` label is present. A is the exact eternal churn this spec exists to end; C misreports a design condition as an agent crash. One addition: `blocked:*` must be classified as *actionable* by cockpit watch/status (it is precisely an escalation-gate state for auto mode) — a pause nobody surfaces is a strand.

### Q4: Ordering of reply, resolve, and label-clear within a successful cycle
**Context**: Today's handler runs (1) CLI, (2) commit+push, (3) reply-per-comment, (4) clear label. FR-001 inserts `resolveReviewThread`; FR-005 changes reply granularity. The order of the new steps determines partial-failure behavior:
- Reply-then-resolve: if the reply POST succeeds but the resolve mutation fails, the thread carries an "I've addressed this" reply but stays unresolved — indistinguishable from today's bug from the monitor's POV; next cycle re-fires and posts another duplicate reply.
- Resolve-then-reply: if resolve succeeds but reply POST fails, the thread is resolved but the operator sees no "please verify" reply — silent completion.
- Interleaved-per-thread: atomically reply+resolve one thread at a time; partial batch failure leaves a mix of (replied+resolved) threads and (untouched) threads — cleanest for FR-006's strict-decrease invariant.

Order also interacts with the Q1 partial-failure choice.
**Question**: In what order does the handler run reply-per-thread, resolve-per-thread, and label-clear on a successful cycle?
**Options**:
- A: Batch → CLI, commit/push, reply-per-thread (all threads), resolve-per-thread (all threads), clear label. Simplest; matches today's shape.
- B: Batch reverse → CLI, commit/push, resolve-per-thread (all threads), reply-per-thread (all threads), clear label. Resolve happens first so a reply failure doesn't strand the trigger; a partial resolve failure is discovered before any reply is posted.
- C: Interleaved per-thread → for each addressed thread: reply then resolve (or vice versa); after loop, clear label. Cleanest partial-failure story (each thread is atomic-ish); each thread's success/failure counted independently against Q1.

**Answer**: C, with reply→resolve within each thread — interleaved per-thread gives each thread an atomic-ish outcome (replied+resolved, or untouched-after-retries), which is what makes Q1's per-thread counting and warns coherent. Within a thread, reply first: if the pair is forced to fail halfway, fail with the human informed (a reply without resolution is diagnosable and one click from fixed; a resolution without a reply is a silent completion — collapsed thread, no notification, no "please verify" ping). Label-clear last, per Q1's verdict.

### Q5: Reply text on re-triggered (operator-un-resolved) cycles
**Context**: FR-008 lets the operator un-resolve a thread via the GitHub UI to re-trigger a new cycle. The current reply text is a single static string: `"I've addressed this feedback in the latest commit. Please review the changes."` On the second cycle triggered by un-resolve, that text is now literally false ("in the latest commit" — but the latest commit is the one the operator disagreed with). It also does not communicate to a second operator viewer that this thread has been through two cycles.

The choice affects operator UX and handler statefulness: option A is stateless; option B/C need to look up prior replies on the thread to know which cycle they're on.
**Question**: What reply text does the handler post on the second (and later) cycle after an operator un-resolved a previously-addressed thread?
**Options**:
- A: Same static text every cycle — stateless; the operator can distinguish cycles by the commit SHA in adjacent bot commits and by the resolve/un-resolve markers GitHub renders on the thread.
- B: Include commit SHA + cycle counter — e.g., `"Re-addressed in <sha> (cycle N)."` — requires the handler to count prior bot replies on the thread to derive N.
- C: Different text on the first vs. subsequent cycles — first cycle uses today's text; subsequent cycles use `"I've reworked this per your latest feedback. Please review <sha>."` — requires detecting "is there a prior bot reply on this thread" but not counting.

**Answer**: B minus the counter — interpolate the commit SHA, drop the cycle number: `"Addressed in <sha> — please review, and re-open this thread if it still falls short."` The SHA is stateless (the handler just pushed it) and makes the text self-truthing on every cycle — a re-triggered cycle that pushes new work gets a new SHA, and a re-triggered cycle that produces *no* diff posts no reply at all (FR-003) and lands in Q3's blocked state instead. The cycle counter is the only stateful part of B and buys nothing that GitHub's un-resolve/re-resolve markers plus distinct SHAs don't already show.

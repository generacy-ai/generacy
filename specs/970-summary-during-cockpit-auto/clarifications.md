# Clarifications

## Batch 1 — 2026-07-17

### Q1: Terminal-green criteria & change detection
**Context**: FR-002 requires skipping `getPullRequestCheckRuns` for PRs "already terminal-green unless the head SHA or label set changed since last observation." This needs a precise definition to code against: what counts as "terminal-green", and which signal(s) reliably invalidate the skip. If the gate is too loose we silently miss regressions (new commit pushed to a green PR, new required-check registered); too tight and we still hammer GraphQL.
**Question**: Which combination defines "terminal-green" AND what triggers re-fetching a previously-terminal-green PR?
**Options**:
- A: Terminal-green = all check runs conclusion ∈ {`success`, `skipped`, `neutral`} AND zero pending. Re-fetch only when `headRefOid` changes.
- B: Same green definition as A, but re-fetch when `headRefOid` OR the observed label set changes (mirrors the D5 asymmetry the spec references).
- C: Green = all conclusions == `success` strictly (skipped/neutral count as non-terminal and stay polled). Re-fetch on `headRefOid` OR label change.
- D: Same as B, plus a periodic safety re-fetch every N cycles (e.g. every 20th cycle ≈ 10 min) even without change signal, to catch late-registered required checks.

**Answer**: *Pending*

### Q2: Rate-limit signal source
**Context**: FR-007/FR-008 require inspecting `x-ratelimit-remaining` / `retry-after` on `gh` responses. Assumption #4 flags that `gh` may swallow response headers and offers `gh api /rate_limit` on a slower cadence as a fallback. The spec does not pick a primary — this is load-bearing for whether we can react per-call or only every few minutes, and it changes the shape of the widening logic in FR-007.
**Question**: What is the primary rate-limit signal source, and is the alternative used at all?
**Options**:
- A: `gh` response headers only. If `gh` swallows them, we fix `gh` invocation to surface them (e.g. `gh api` with `-i`) rather than probe. No `/rate_limit` probe.
- B: `gh api /rate_limit` probe on a slower cadence (e.g. every 5 min or on suspected drain) is the primary signal. Response headers are best-effort supplemental.
- C: Both: prefer response headers when `gh` exposes them; fall back to `/rate_limit` probe when headers are absent or stale. Probe cadence bounded (≥ every 5 min while healthy, faster on low-budget).
- D: Neither — instead react only to 403 rate-limit errors after they occur (FR-008 only), skipping FR-007 proactive widening.

**Answer**: *Pending*

### Q3: Cache invalidation scope
**Context**: FR-004 says "Cache invalidation on write paths (label add/remove, merge, close/reopen)". Ambiguous whether this covers only mutations initiated by *this* cockpit process (in which case invalidation is a same-process hook call) or also externally-driven changes (webhook-style detection, poll-cycle diff, etc.). It also does not say what happens when a same-process mutation and a concurrent read race.
**Question**: What is the invalidation model?
**Options**:
- A: Local-only. Invalidation runs on cockpit-initiated mutations (calls to label add/remove, `cockpit_merge`, close/reopen). Externally-driven changes are picked up whenever the TTL expires. No same-process locking beyond the cache mutex.
- B: Local + poll-diff. Same as A, plus the poll loop diffs the fresh read against the cached entry and invalidates dependent keys (e.g. checks-cache for that PR) when it notices external-write signatures.
- C: Local + write-through. Same as A, plus on cockpit-initiated mutations the cache is *repopulated* with the post-mutation value returned by the write API (skipping the next fetch entirely) rather than just invalidated.
- D: Bypass instead of invalidate. Write paths bypass the cache entirely (read-your-own-writes always hits `gh`), and TTL is the sole invalidation mechanism.

**Answer**: *Pending*

### Q4: Poll widening thresholds & max interval
**Context**: FR-007 says "widen the poll interval as the budget drains" but does not specify the trigger threshold(s) or the ceiling. SC-006 hints at "≤ 5 min" as an example upper bound. This shapes both the widening algorithm and the operator-visible behavior when the account is under pressure.
**Question**: What thresholds and ceiling govern widening?
**Options**:
- A: Single-step: at `remaining < 20%` of budget widen to 2× base (60s), at `< 5%` widen to 4× (2 min). Hard ceiling 5 min. Reset to base once `remaining ≥ 30%`.
- B: Continuous: `interval = base × clamp(1, 10, 1 / max(0.05, remainingRatio))` — smoothly widens as budget drops. Ceiling 5 min (10× base). Reset when `remainingRatio` recovers above 0.3.
- C: Threshold + retry-after. On response, if `retry-after` present, honor it exactly. Otherwise use the single-step ladder from A. Ceiling 5 min.
- D: On 403 only (FR-008): stay at base 30s until a rate-limit 403 occurs, then exponential backoff (60s, 120s, 240s, cap 5 min) with reset on first success. Skip proactive widening.

**Answer**: *Pending*

### Q5: `resolveEpic` refresh trigger
**Context**: FR-005 requires making the per-cycle `resolveEpic` fetch conditional — "only when epic body/label hash changes or every N cycles". The spec does not define the hash inputs, how the change signal is obtained without a fetch (chicken-and-egg), or the value of N. Without pinning this down the fix could either be a no-op (still fetching every cycle to compute the hash) or oscillate.
**Question**: What is the trigger for refreshing `resolveEpic`?
**Options**:
- A: Fetch every Nth cycle only (N = 10 → 5 min at 30s cadence); never fetch mid-window. Any operator-visible edits to the epic body/label surface are picked up on the next N-boundary. Simplest.
- B: Fetch every cycle but only re-parse/re-resolve when the raw body+labels blob hash differs from the last observed. Saves parse cost but not the GraphQL point cost — invalidates the FR-005 goal. (Not recommended.)
- C: Cheap poll (`gh issue view <epic> --json updatedAt,labels`) every cycle, full `resolveEpic` only when `updatedAt` or labels changed OR every N=20 cycles as safety. Two-tier: light per-cycle, heavy conditional.
- D: Skill-side (`generacy-ai/agency`) exposes an edit doorbell; cockpit refreshes only on doorbell OR every N=20 cycles. Requires cross-repo coordination — out of scope per Assumption #1?

**Answer**: *Pending*

# Clarifications: smee SSE reconnect cap + jitter (receiver + doorbell)

**Issue**: [#991](https://github.com/generacy-ai/generacy/issues/991)
**Branch**: `991-summary-both-smee-sse`

## Batch 1 — 2026-07-18

### Q1: Exact cap value
**Context**: FR-001 / FR-002 / SC-001 target `MAX_BACKOFF_MS ≤ 60_000`, with the assumptions section describing "30–60s range." The implementer needs a single number to write into both constants; the choice trades real-time recovery speed against upstream hammer load during a genuinely long smee.io outage.
**Question**: What exact value should `MAX_BACKOFF_MS` become in both `SmeeWebhookReceiver` and `SmeeDoorbellSource`?
**Options**:
- A: `30_000` (30s) — fastest recovery; ladder becomes 5s → 10s → 20s → 30s(cap), only one attempt at the cap before the ladder would have doubled to 40s
- B: `45_000` (45s) — middle ground
- C: `60_000` (60s) — matches SC-001's outer bound; ladder becomes 5s → 10s → 20s → 40s → 60s(cap), lightest hammer load during long outages
- D: Other (specify value in ms)

**Answer**: *Pending*

### Q2: Jitter algorithm and band
**Context**: FR-003 says "±20–50% randomisation." Three common flavours exist (see AWS's "exponential backoff and jitter"), and they produce meaningfully different fleet-behaviour and different worst-case delays. SC-001 also allows for "net max ≤ ~90s with a +50% jitter band on a 60s cap" — implying the jitter can push *above* the cap. Need one concrete algorithm.
**Question**: Which jitter shape should the shared helper produce, and what is the exact band?
**Options**:
- A: **Full jitter** — `delay = random(0, min(base * 2^attempt, cap))`. Fleet spread is widest; can return values well below the exponential value.
- B: **Equal jitter** — `delay = capped/2 + random(0, capped/2)` where `capped = min(base * 2^attempt, cap)`. Guarantees at least half the exponential value; moderate spread.
- C: **Additive ±20% around the capped delay** — `delay = capped * (1 + random(-0.2, +0.2))`. Tight spread; may still cluster.
- D: **Additive ±50% around the capped delay** — `delay = capped * (1 + random(-0.5, +0.5))`. Wide spread; +50% overshoot allowed per SC-001.

**Answer**: *Pending*

### Q3: Shared helper placement
**Context**: FR-005 mandates a single `calculateBackoffDelay` shared between orchestrator (`packages/orchestrator`) and CLI (`packages/generacy`). Assumptions leave placement to plan phase, but the choice affects the changeset (which packages bump), the dependency graph, and whether a new package is created.
**Question**: Where should the shared helper live?
**Options**:
- A: New tiny utility package (e.g. `packages/backoff` or `packages/smee-utils`) — cleanest boundary, but adds a workspace package + release channel
- B: Inside `packages/orchestrator/src/` (exported), imported by `packages/generacy/` — introduces a `generacy → orchestrator` dependency direction that doesn't exist today
- C: Inside `packages/generacy/src/` (exported), imported by `packages/orchestrator/` — reverse direction; more natural if generacy is already an "upstream" of orchestrator
- D: Inside an existing shared package (specify which — e.g. `packages/config`, `packages/credhelper`)

**Answer**: *Pending*

### Q4: Jitter at attempt=0
**Context**: FR-004 says "base reconnect delay stays at ~5s." The current ladder starts at 5s (attempt 0). Applying jitter to attempt=0 changes the first-reconnect timing — potentially fractionally faster or slower than 5s. FR-006 explicitly asserts "`reconnectAttempt=0` produces the base delay" as an invariant, which reads as *no* jitter at attempt=0, but that could also be read as "the base pre-jitter."
**Question**: Should jitter be applied at `attempt=0` (the base delay), or only at `attempt >= 1`?
**Options**:
- A: Apply jitter at every attempt including `attempt=0` — treat FR-006's invariant as "the pre-jitter base is 5s, output may differ." Simplest / most uniform helper.
- B: Skip jitter at `attempt=0` — first reconnect is exactly the base delay; jitter only starts at `attempt=1`. Preserves FR-006's literal "produces the base delay."
- C: Apply jitter at every attempt but bound `attempt=0` to `>= base` (never faster than base) — never hammers upstream on first retry.

**Answer**: *Pending*

### Q5: Regression test approach (FR-007)
**Context**: FR-007 requires a regression test that "simulates the recovery path: after `reconnectAttempt` pins at the cap and the endpoint recovers, the next reconnect attempt fires within the new cap." The `SmeeWebhookReceiver` and `SmeeDoorbellSource` reconnect loops are non-trivial to drive end-to-end (SSE fetch, abort signals, sleep loops), so this could be a shared-helper-only test or a full reconnect-loop test.
**Question**: What scope satisfies FR-007?
**Options**:
- A: Pure unit test on `calculateBackoffDelay` — assert `helper(N)` where N was the pinned cap-attempt returns a value ≤ (cap + jitter overshoot). No SSE loop involvement. Cheapest; matches SC-001 measurement.
- B: Fake-timer test that drives one of the two reconnect loops (mock fetch / EventSource, `vi.useFakeTimers()`), pins `reconnectAttempt` at cap, then flips the fetch mock to "succeed" and asserts the next `sleep` resolves within `cap + jitter_max`.
- C: Both — a helper unit test AND a fake-timer loop test on at least one consumer.

**Answer**: *Pending*

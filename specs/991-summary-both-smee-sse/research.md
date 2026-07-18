# Research: smee SSE reconnect cap + jitter

**Issue**: [#991](https://github.com/generacy-ai/generacy/issues/991)
**Branch**: `991-summary-both-smee-sse`

## Decision log

### D1. Cap value: 30_000 ms

**Decision**: `MAX_BACKOFF_MS = 30_000`.

**Rationale** (from clarifications Q1 → A):
- Real-time recovery is the whole point of the fix. A failed reconnect during a genuine outage is just a cheap connection attempt.
- smee.io is built for many reconnecting SSE clients — retrying every ~30s vs 60s is not meaningful upstream load.
- Paired with equal jitter (D2), worst-case post-recovery reconnect is bounded at 30s (ladder `5s → 10s → 20s → 30s(cap)`), down from today's 5 min.

**Alternatives considered**:
- 45s (Q1 → B): middle ground, no strong reason to pick it.
- 60s (Q1 → C): lightest hammer load, but doubles the observable outage window vs 30s for the exact case the fix targets.

### D2. Jitter algorithm: equal jitter

**Decision**: `delay = capped/2 + random(0, capped/2)` where `capped = min(base * 2^attempt, cap)`.

**Rationale** (from clarifications Q2 → B):
- Every output bounded to `[capped/2, capped]`. Never overshoots the cap (predictable worst-case recovery — critical for a real-time transport). Never drops near-zero (won't hammer smee.io during sustained outages).
- 50% spread band is sufficient to de-sync a small fleet (orchestrator + a few doorbells on the same channel).

**Alternatives considered**:
- Full jitter (`random(0, capped)`): widest spread but allows near-zero delays that would hammer just-recovered upstream.
- Additive ±20% (`capped * (1 + random(-0.2, +0.2))`): tight spread, may still cluster.
- Additive ±50% (`capped * (1 + random(-0.5, +0.5))`): would push a 30s cap to 45s, breaking the predictable worst-case guarantee.

**Reference**: AWS's "Exponential Backoff and Jitter" (2015) — <https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/> — coined "equal jitter" as the middle path between exponential and full jitter.

### D3. Jitter applied at attempt=0

**Decision**: Apply jitter at every attempt including `attempt=0`.

**Rationale** (from clarifications Q4 → A):
- A smee.io restart drops every client on the channel simultaneously. Skipping jitter at attempt 0 (option B) re-synchronizes the entire fleet at exactly 5s on the first retry, defeating the whole point.
- Equal jitter at attempt 0 yields `[2.5s, 5s]`, de-syncing the first retry while keeping a sensible ≥2.5s floor.
- FR-006 reinterpreted: "the pre-jitter base is 5s"; post-jitter output at attempt=0 may be anywhere in `[2.5s, 5s]`.

### D4. Shared helper placement: new leaf package

**Decision**: New package `packages/smee-backoff` (`@generacy-ai/smee-backoff`), pure TypeScript, zero runtime deps.

**Rationale** (from clarifications Q3 → A):
- FR-005 mandates a single helper imported by both consumers.
- Q3 → A explicitly rejects option B (`generacy → orchestrator` import) — the CLI deliberately avoids that direction (see `channel-discovery.ts` copying constants verbatim to avoid this exact dep edge).
- Q3 → A allows option D (existing shared leaf) as an alternative *if* one both packages already depend on has a natural fit. The candidates are:
  - `@generacy-ai/activation-client` — device-flow only; not a natural home.
  - `@generacy-ai/config` — workspace/repo config; not a natural home.
  - `@generacy-ai/orchestrator-types` — types-only package; would carry runtime code awkwardly.
  - `@generacy-ai/workflow-engine` — workflow orchestration; not a natural home.
- None of the existing shared leaves is a good fit for a smee-transport utility. New-package overhead accepted.

**Sibling precedent**: `packages/activation-client` was extracted (issue #500) for the same "two callers, one algorithm" reason — pure protocol logic hoisted out of `packages/orchestrator/src/activation/` into a leaf package.

### D5. RNG injection seam

**Decision**: `calculateBackoffDelay(attempt, { base, cap, random?: () => number })`. Defaults to `Math.random`.

**Rationale**:
- Smallest possible seam to make SC-004's determinism test trivial without a `seedrandom` dep.
- Consumers pass no `random` field; only tests inject.
- No API cost (single optional field on the options object).

**Alternatives considered**:
- Global `crypto.getRandomValues` mock: coupling to a global, harder to reason about in fake-timer tests.
- `seedrandom` dep: adds a runtime dep for a test-only concern.

### D6. Regression tests: helper unit + one consumer loop test

**Decision** (from clarifications Q5 → C):
- **Pure unit test** on `calculateBackoffDelay` (SC-001 satisfaction): pinned attempts, injected RNG, band-boundary assertions (`[cap/2, cap]`), variance assertion (SC-004).
- **Fake-timer loop test** on `SmeeDoorbellSource` (SC-002 + FR-008 satisfaction): mock `fetch`, `vi.useFakeTimers()`, pin `reconnectAttempt` at cap, flip fetch mock to succeed, assert next reconnect fires within `MAX_BACKOFF_MS` (advancing timers by `cap + 1ms` and observing the successful connect).

**Rationale**:
- Helper test alone (option A) can't catch a regression in `reconnectAttempt` reset-on-success — that's the invariant the bug is actually about (FR-008).
- Loop test alone (option B) misses the deterministic band assertions (SC-001, SC-004).

**Consumer choice**: `SmeeDoorbellSource` over `SmeeWebhookReceiver`. The doorbell has a lighter dep graph (no `LabelMonitorService`, no monitor fan-out), so the fake-timer test wires up faster.

### D7. Base delay stays inline in each consumer

**Decision**: `BASE_RECONNECT_DELAY_MS = 5000` stays in `SmeeWebhookReceiver`; `DEFAULT_BASE_RECONNECT_DELAY_MS = 5_000` stays in `smee-source.ts`. Only `MAX_BACKOFF_MS` and the ladder math move.

**Rationale**:
- Each consumer's ctor takes a `baseReconnectDelayMs?` override — the constant is the class's own default, not the algorithm's parameter.
- The algorithm (`calculateBackoffDelay`) receives `{ base, cap }` at call time; the caller supplies `base`.
- Keeps the shared package's API minimal (no default-base opinion).

### D8. Changeset shape

**Decision**: single `minor` changeset covering `@generacy-ai/smee-backoff`, `@generacy-ai/orchestrator`, `@generacy-ai/generacy`.

**Rationale** (from CLAUDE.md changeset rules):
- New package with public exports → new capability → `minor`.
- Consumer packages get a bug fix + new capability (jittered backoff) → `minor` (consistent with the shared helper).
- One `.changeset/*.md` file, all three packages listed.

## Implementation notes

### Consumer refactor: SmeeWebhookReceiver

Delete lines:
- `smee-receiver.ts:69` — `private static readonly MAX_BACKOFF_MS = 300000;`
- `smee-receiver.ts:495-498` — `calculateBackoffDelay` method body (formula only).

Replace `reconnectDelayMs` getter body with:

```ts
private get reconnectDelayMs(): number {
  return calculateBackoffDelay(this.reconnectAttempt, {
    base: this.baseReconnectDelayMs,
    cap: 30_000,
  });
}
```

Delete the private `calculateBackoffDelay` method entirely.

### Consumer refactor: SmeeDoorbellSource

Delete lines:
- `smee-source.ts:30` — `export const MAX_BACKOFF_MS = 300_000;`
- `smee-source.ts:232-235` — private `calculateBackoffDelay` method.

Replace call site (currently `this.calculateBackoffDelay(this.reconnectAttempt)`) with:

```ts
calculateBackoffDelay(this.reconnectAttempt, {
  base: this.baseReconnectDelayMs,
  cap: 30_000,
})
```

`DEFAULT_BASE_RECONNECT_DELAY_MS` stays exported (still used by the ctor default).

**Note**: `MAX_BACKOFF_MS` is currently `export const` in `smee-source.ts`. Grep for external importers before deletion:

```
rg "from ['\"].*smee-source" packages/generacy/src --files-with-matches
```

If any importer references `MAX_BACKOFF_MS`, they get updated to import from `@generacy-ai/smee-backoff` (should be zero — the constant is internal to the reconnect loop today).

### Package.json wiring

New in `packages/orchestrator/package.json` `dependencies`:
```json
"@generacy-ai/smee-backoff": "workspace:^",
```

New in `packages/generacy/package.json` `dependencies`:
```json
"@generacy-ai/smee-backoff": "workspace:*",
```

(Version spec matches each package's existing convention — `^` for orchestrator, `*` for generacy.)

## References

- `packages/orchestrator/src/services/smee-receiver.ts:69, 483-498` — existing receiver ladder.
- `packages/generacy/src/cli/commands/cockpit/doorbell/smee-source.ts:29-30, 232-235` — existing doorbell ladder.
- `packages/activation-client/` — sibling shared-leaf-package precedent.
- AWS Architecture Blog, "Exponential Backoff and Jitter" (2015).
- clarifications.md — Q1 through Q5 answers.

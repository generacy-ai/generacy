# Implementation Plan: smee SSE reconnect cap + jitter (receiver + doorbell)

**Feature**: Lower `MAX_BACKOFF_MS` to 30s and add equal jitter for both smee SSE consumers (orchestrator `SmeeWebhookReceiver` + cockpit `SmeeDoorbellSource`), sharing a single `calculateBackoffDelay` helper.
**Branch**: `991-summary-both-smee-sse`
**Status**: Complete

## Summary

Two near-verbatim SSE reconnect ladders — one in `packages/orchestrator/src/services/smee-receiver.ts` and one in `packages/generacy/src/cli/commands/cockpit/doorbell/smee-source.ts` — currently cap their exponential backoff at **5 minutes** with no jitter. After a transient smee.io blip both consumers can sit disconnected for up to 5 minutes even once smee.io is healthy again, stalling the real-time path for the orchestrator's webhook delivery and for `/cockpit:auto`'s doorbell.

The fix has three parts, driven by the clarifications:

1. Lower the cap to **30_000 ms** in both consumers (ladder becomes `5s → 10s → 20s → 30s(cap)`), per **Q1 → A**.
2. Add **equal jitter** — `delay = capped/2 + random(0, capped/2)` where `capped = min(base * 2^attempt, cap)` — applied at **every attempt including attempt=0**, per **Q2 → B** and **Q4 → A**. Bounds every delay to `[capped/2, capped]`: never overshoots the cap, never near-zero.
3. Extract the shared math into a new leaf package **`packages/smee-backoff`** exporting a pure `calculateBackoffDelay(attempt, { base, cap, random? })` function, imported by both consumers, per **Q3 → A** (the only leaf packages `packages/orchestrator` and `packages/generacy` both already depend on are `activation-client`, `config`, `orchestrator-types`, and `workflow-engine` — none of which is a natural home for a smee-transport utility, so the new-package overhead is warranted).
4. Regression tests are **both** a pure unit test on the helper and a fake-timer test on one consumer's reconnect loop (SmeeDoorbellSource) that pins `reconnectAttempt` at the cap, flips the fetch mock to succeed, and asserts the next reconnect fires within the new cap — per **Q5 → C**. This guards `reconnectAttempt` reset-on-success (FR-008), which is the invariant the bug is actually about.

`reconnectAttempt` reset-on-success behaviour is preserved (FR-008); no config surface is introduced (constants stay in code).

## Technical Context

- **Language**: TypeScript (ESM, `NodeNext` module resolution). Node >=20 for both consumer packages; new `smee-backoff` package will match (Node >=20, ESM).
- **Test runner**: `vitest` (both consumers use it today; new package will use it too).
- **Runtime deps for `smee-backoff`**: **none**. Pure `Math.random` + `Math.pow` + `Math.min`. RNG injection point via optional `random?: () => number` so tests can pin the value (satisfies SC-004's deterministic-variance assertion).
- **Build**: `tsc` → `dist/`, matching sibling leaf packages (`packages/activation-client`, `packages/credhelper`).
- **Packaging**: new workspace package `@generacy-ai/smee-backoff`, `workspace:^` in orchestrator, `workspace:*` in generacy (matching each consumer's convention).
- **CI gate**: this diff touches `packages/*/src/` non-test files — a changeset is required (`minor` — new capability + shared package; single changeset covers all three packages).

### Files that will change

| File | Change |
|------|--------|
| `packages/smee-backoff/package.json` | NEW — leaf package manifest; zero runtime deps; ESM. |
| `packages/smee-backoff/tsconfig.json` | NEW — copy of `activation-client/tsconfig.json`. |
| `packages/smee-backoff/src/index.ts` | NEW — re-exports `calculateBackoffDelay`, types. |
| `packages/smee-backoff/src/calculate-backoff-delay.ts` | NEW — pure function with equal-jitter math. |
| `packages/smee-backoff/tests/unit/calculate-backoff-delay.test.ts` | NEW — pinned attempts, RNG injection, jitter-band + variance assertions. |
| `packages/orchestrator/package.json` | ADD `"@generacy-ai/smee-backoff": "workspace:^"` dep. |
| `packages/orchestrator/src/services/smee-receiver.ts` | REPLACE inline `calculateBackoffDelay` + `MAX_BACKOFF_MS` constant with imported helper call. Drop `Math.pow` line + `Math.min` line. `BASE_RECONNECT_DELAY_MS` stays inline as class default. |
| `packages/orchestrator/src/services/__tests__/smee-receiver.test.ts` (or existing file) | Update / add unit assertion that the receiver's reconnect delay comes from the shared helper (grep-free — remove any surviving `MAX_BACKOFF_MS` literal, SC-003). |
| `packages/generacy/package.json` | ADD `"@generacy-ai/smee-backoff": "workspace:*"` dep. |
| `packages/generacy/src/cli/commands/cockpit/doorbell/smee-source.ts` | REPLACE inline `calculateBackoffDelay` + `MAX_BACKOFF_MS` module constant with imported helper call. `DEFAULT_BASE_RECONNECT_DELAY_MS` stays for the constructor default. |
| `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/smee-source-reconnect.test.ts` | NEW — fake-timer loop test (FR-007b). Pins `reconnectAttempt` at cap, flips fetch mock to succeed, asserts next reconnect fires within `MAX_BACKOFF_MS`. |
| `.changeset/991-smee-backoff.md` | NEW — `minor` bump for all three packages. |

Grep-parity assertion (SC-003) is enforced by the diff itself: after implementation, `rg 'MAX_BACKOFF_MS' packages/orchestrator/src packages/generacy/src` should return zero hits (only appears in `packages/smee-backoff/src/` + tests).

## Project Structure

```
packages/
├── smee-backoff/                            # NEW leaf package
│   ├── package.json                         # @generacy-ai/smee-backoff, zero runtime deps
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts                         # exports calculateBackoffDelay + types
│   │   └── calculate-backoff-delay.ts       # pure equal-jitter helper
│   └── tests/
│       └── unit/
│           └── calculate-backoff-delay.test.ts
├── orchestrator/
│   ├── package.json                         # + dep on @generacy-ai/smee-backoff
│   └── src/
│       └── services/
│           └── smee-receiver.ts             # MODIFIED — import helper, drop local math + cap const
├── generacy/
│   ├── package.json                         # + dep on @generacy-ai/smee-backoff
│   └── src/
│       └── cli/
│           └── commands/
│               └── cockpit/
│                   └── doorbell/
│                       ├── smee-source.ts   # MODIFIED — import helper, drop local math + cap const
│                       └── __tests__/
│                           └── smee-source-reconnect.test.ts   # NEW — fake-timer loop test
└── .changeset/
    └── 991-smee-backoff.md                  # NEW — minor bump
```

## Architectural Decisions

- **New package (Q3 → A)** over folding into an existing shared leaf. The four candidates that both `orchestrator` and `generacy` already depend on (`activation-client`, `config`, `orchestrator-types`, `workflow-engine`) each carry semantic weight that doesn't fit a generic transport-backoff helper. Sibling precedent (`activation-client` extracted for the same "two callers, one algorithm" reason) makes a new leaf the low-risk default.
- **Equal jitter (Q2 → B)** over full jitter or additive ±50%. Bounds every output to `[cap/2, cap]`: never overshoots (predictable worst-case recovery for a real-time transport), never near-zero (won't hammer smee.io during sustained outages).
- **Jitter at attempt=0 (Q4 → A)** — a smee.io restart drops every client simultaneously; skipping jitter at attempt 0 would re-synchronize the whole fleet on the very first retry, defeating the entire point.
- **RNG injection** via optional `random?: () => number` parameter (defaulting to `Math.random`) is the smallest possible seam to make SC-004's determinism check trivial without a `seedrandom` dep.
- **Two-tier tests (Q5 → C)** — the pure helper test alone can't catch a regression in `reconnectAttempt` reset-on-success (the actual bug), so a fake-timer loop test on one consumer is required. Doorbell chosen over receiver because its dependency graph is simpler (no LabelMonitorService).

## Constitution Check

No `.specify/memory/constitution.md` file exists in this repo. Followed the CLAUDE.md-encoded rules:

- **Changeset gate**: diff touches multiple `packages/*/src/` non-test files → single new `.changeset/*.md` covering all three packages. `minor` bump (new capability + new package with public exports).
- **No premature abstraction**: single pure function, single parameter object, no builder/factory. RNG injection is the only extension seam and it exists purely for the SC-004 test.
- **No backwards-compat shims**: both consumers switch to the helper in the same PR. No feature flag, no dual code path.
- **Comment discipline**: helper carries one short JSDoc on the exported function (the equal-jitter formula belongs in the code, not a doc). Consumers get no new comments — the `calculateBackoffDelay` call site reads itself.

## Risks & Mitigations

- **R1**: Test flakiness from `Math.random`. Mitigation: tests use injected RNG (`random: () => 0.5` for a pinned mid-band value; `random: () => 0` and `random: () => 0.9999` for band-boundary sanity checks). No un-seeded `Math.random` in assertions.
- **R2**: A future consumer copies the ladder again instead of importing. Mitigation: SC-003 grep assertion is documented in `plan.md` + enforced by CI-visible test (`rg 'MAX_BACKOFF_MS' packages/orchestrator/src packages/generacy/src` returns zero) — added as a runtime assertion in the shared helper test file so it fails PR checks, not just local dev.
- **R3**: 30s cap is too aggressive against a genuinely long smee.io outage. Mitigation accepted per Q1 → A rationale (failed reconnect is a cheap connection attempt; smee.io is built for many reconnecting SSE clients). Assumptions section of spec captures this trade-off explicitly.
- **R4**: The fake-timer loop test in `smee-source.ts` couples to the private reconnect loop shape. Mitigation: test drives the public `start()` / `stop()` surface + injected `fetch` mock; only mocks the loop shape via `vi.useFakeTimers()` (the "clock advances" is the observable, not the internal call sequence).

## Next Step

`/speckit:tasks` to generate the task list.

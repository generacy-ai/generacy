# Tasks: smee SSE reconnect cap + jitter (receiver + doorbell)

**Input**: Design documents from `/specs/991-summary-both-smee-sse/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/calculate-backoff-delay.md, contracts/consumer-integration.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (all tasks map to US1 — the only user story)

## Phase 1: New leaf package skeleton

- [X] T001 [US1] Scaffold `packages/smee-backoff/package.json` — name `@generacy-ai/smee-backoff`, ESM (`"type": "module"`), Node `>=20`, zero runtime deps, `main`/`types`/`exports` all pointing at `dist/index.js` + `dist/index.d.ts`, `build` script `tsc`, `test` script `vitest run`. Copy the shape of `packages/activation-client/package.json` (the sibling precedent named in research.md D4).
- [X] T002 [P] [US1] Scaffold `packages/smee-backoff/tsconfig.json` — copy from `packages/activation-client/tsconfig.json` (NodeNext module resolution, `outDir: dist`, `rootDir: src`).
- [X] T003 [P] [US1] Add `vitest` devDependency to `packages/smee-backoff/package.json` matching the version pin used by `packages/activation-client` (keep the workspace vitest version consistent so root install doesn't fan out a new version).

## Phase 2: Core helper — pure function + unit tests

Contract source: `specs/991-summary-both-smee-sse/contracts/calculate-backoff-delay.md`.

- [X] T010 [US1] Create `packages/smee-backoff/src/calculate-backoff-delay.ts` implementing the equal-jitter algorithm exactly as specified in the contract §Algorithm and data-model.md §`calculateBackoffDelay`. Exports:
  - `interface BackoffOptions { base: number; cap: number; random?: () => number }` with the JSDoc from `data-model.md` (one short block per field).
  - `function calculateBackoffDelay(attempt: number, opts: BackoffOptions): number` with the equal-jitter formula: `raw = base * 2 ** attempt`; `capped = Math.min(raw, cap)`; return `capped/2 + rng() * (capped/2)` where `rng = opts.random ?? Math.random`.
  - Precondition guards throwing `RangeError` per contract §Errors: `base <= 0` → `'base must be > 0'`; `cap < base` → `'cap must be >= base'`; `!Number.isFinite(attempt) || attempt < 0` → `'attempt must be a non-negative finite number'`.
  - No logging, no self-timing, synchronous return (per contract §Non-goals).
- [X] T011 [US1] Create `packages/smee-backoff/src/index.ts` — barrel that re-exports `BackoffOptions` and `calculateBackoffDelay` from `./calculate-backoff-delay.js`. No other exports.
- [X] T012 [US1] Create `packages/smee-backoff/tests/unit/calculate-backoff-delay.test.ts` implementing every row of the contract §Test cases table (T1–T10). Each vitest `it()` block corresponds to one contract row:
  - T1: attempt=0, random=()=>0 → exactly `2500` (G2 lower bound).
  - T2: attempt=0, random=()=>0.9999 → `< 5000` and `> 4999` (G2 upper bound approach).
  - T3: attempt=3, random=()=>0 → exactly `15000` (`cap/2`); asserts G3 lower + G5.
  - T4: attempt=3, random=()=>0.9999 → `< 30000` and `> 29999` (G3 upper + G5).
  - T5: attempt=10, random=()=>0.5 → exactly `22500` (band midpoint at saturated ladder; G1 + G5).
  - T6 (SC-004 variance): attempt=3 called twice with `random` returning `0.1` then `0.9` → two distinct return values (`toBe` inequality).
  - T7: `attempt=-1` and `attempt=NaN` both throw `RangeError`.
  - T8: `base=0` throws `RangeError`.
  - T9: `cap=1000, base=5000` throws `RangeError`.
  - T10 (off-by-one guard): attempt=2, random=()=>0.5 → exactly `15000` (raw=20000 not yet capped; `10000 + 0.5*10000`).
- [X] T013 [US1] Confirm `pnpm --filter @generacy-ai/smee-backoff test` runs green locally before Phase 3 begins (helper is the dependency both consumers depend on).

## Phase 3: Consumer integration

**Blocked by Phase 2**: both consumers import from the helper, so it must build first. Within Phase 3, T020/T021 (orchestrator) and T030/T031 (generacy) touch disjoint files and are parallelizable across the two packages.

### Orchestrator receiver

- [X] T020 [US1] Add `"@generacy-ai/smee-backoff": "workspace:^"` to `packages/orchestrator/package.json` `dependencies`, matching orchestrator's existing `workspace:^` convention (research.md §Package.json wiring).
- [X] T021 [US1] Refactor `packages/orchestrator/src/services/smee-receiver.ts`:
  - Add `import { calculateBackoffDelay } from '@generacy-ai/smee-backoff';` at the top of the imports block.
  - Delete `private static readonly MAX_BACKOFF_MS = 300000;` (`:69`).
  - Delete the private `calculateBackoffDelay` method body (`:495-498`).
  - Replace the `reconnectDelayMs` getter (or equivalent call site) with:
    ```ts
    private get reconnectDelayMs(): number {
      return calculateBackoffDelay(this.reconnectAttempt, {
        base: this.baseReconnectDelayMs,
        cap: 30_000,
      });
    }
    ```
  - Leave `baseReconnectDelayMs` field + ctor option **unchanged** (public API stability per contracts/consumer-integration.md §Public API stability).
  - Leave `this.reconnectAttempt = 0` reset-on-success invariant **unchanged** (FR-008).

### Generacy doorbell

- [X] T030 [P] [US1] Add `"@generacy-ai/smee-backoff": "workspace:*"` to `packages/generacy/package.json` `dependencies`, matching generacy's `workspace:*` convention (research.md §Package.json wiring).
- [X] T031 [P] [US1] Before deleting the exported `MAX_BACKOFF_MS`, run the importer sweep documented in research.md:
  ```bash
  rg "MAX_BACKOFF_MS" packages/generacy/src
  ```
  If any file **outside** `smee-source.ts` imports `MAX_BACKOFF_MS`, update it to import from `@generacy-ai/smee-backoff` **first** (should be zero hits — the constant is loop-internal today).
- [X] T032 [US1] Refactor `packages/generacy/src/cli/commands/cockpit/doorbell/smee-source.ts`:
  - Add `import { calculateBackoffDelay } from '@generacy-ai/smee-backoff';`.
  - Delete `export const MAX_BACKOFF_MS = 300_000;` (`:30`).
  - Delete the private `calculateBackoffDelay` method (`:232-235`).
  - Replace the existing call site (`this.calculateBackoffDelay(this.reconnectAttempt)`) with:
    ```ts
    calculateBackoffDelay(this.reconnectAttempt, {
      base: this.baseReconnectDelayMs,
      cap: 30_000,
    })
    ```
  - Keep `DEFAULT_BASE_RECONNECT_DELAY_MS` exported (still used by ctor default per research.md D7).
  - Leave `reconnectAttempt` reset-on-success invariant **unchanged** (FR-008).

## Phase 4: Consumer regression test (FR-007b)

- [X] T040 [US1] Create `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/smee-source-reconnect.test.ts` per contracts/consumer-integration.md §Fake-timer loop test contract:
  - `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })`.
  - Mock `fetch`: first N calls reject / return non-2xx so `reconnectAttempt` climbs to cap-saturation; the (N+1)th returns a successful SSE-shaped stream.
  - Construct `SmeeDoorbellSource` with the mock `fetch` and a minimal `gh` stub.
  - **SC-002 assertion**: after N failed attempts, when the fetch mock flips to success, the fake-time elapsed between the last failure and the next fetch call is `< 30_000 + epsilon`.
  - **FR-008 assertion**: after the successful connect, force one more failure and assert the next sleep is back in `[base/2, base)` (i.e. `[2500, 5000)`) — proving `reconnectAttempt` reset to 0.
  - **Non-assertions**: no private-method call-count checks, no log-line checks, no direct read of `reconnectAttempt` — all inferred from sleep observables (contract §Non-assertions).

## Phase 5: Verification & changeset

- [X] T050 [US1] SC-003 grep-parity sweep (must be clean before opening the PR):
  ```bash
  rg 'MAX_BACKOFF_MS' packages/orchestrator/src packages/generacy/src   # → zero hits
  rg 'Math\.pow\(2, [^)]*attempt' packages/orchestrator/src packages/generacy/src   # → zero hits
  ```
  Any surviving hit outside `packages/smee-backoff/` is a regression against FR-005.
- [X] T051 [P] [US1] Run all three packages' test suites and confirm green:
  ```bash
  pnpm --filter @generacy-ai/smee-backoff test
  pnpm --filter @generacy-ai/orchestrator test
  pnpm --filter @generacy-ai/generacy test -- smee-source-reconnect
  ```
- [X] T052 [P] [US1] Create `.changeset/991-smee-backoff.md` per contracts/consumer-integration.md §Changeset — a **new** file (not an edit), `minor` bump for all three packages:
  ```md
  ---
  "@generacy-ai/smee-backoff": minor
  "@generacy-ai/orchestrator": minor
  "@generacy-ai/generacy": minor
  ---

  Cap smee.io SSE reconnect backoff at 30s (was 5min) and add equal jitter, sharing
  the algorithm via a new `@generacy-ai/smee-backoff` package. Reduces real-time
  recovery latency for the orchestrator webhook receiver and the cockpit doorbell
  after a transient smee.io outage.
  ```
  (Per CLAUDE.md changeset gate: a **newly added** file — editing an existing changeset does not satisfy `--diff-filter=A`.)

## Dependencies & Execution Order

**Sequential phase boundaries**:
- Phase 1 (package skeleton) → Phase 2 (helper + tests) → Phase 3 (consumers) → Phase 4 (consumer test) → Phase 5 (verify + changeset).
- Rationale: consumers import from the helper (Phase 3 depends on Phase 2 build); the fake-timer regression test (Phase 4) exercises the refactored consumer path (depends on Phase 3); the grep sweep + test run (Phase 5) needs all three packages in their final state.

**Parallel opportunities within phases**:
- Phase 1: T002 and T003 in parallel with T001 (disjoint concerns in the same manifest+config skeleton — pnpm workspace picks up all three once written).
- Phase 3: The orchestrator lane (T020, T021) and the generacy lane (T030, T031, T032) touch disjoint packages and are fully parallelizable. Within the generacy lane, T030 and T031 are `[P]`; T032 depends on T031's sweep result (need to know no external importers exist before deleting the export).
- Phase 5: T051 (test run) and T052 (changeset) are `[P]` — the changeset file is orthogonal to test execution.

**Test-first vs implementation-first**: Phase 2 lands the helper's unit tests alongside the helper (contract-driven; not strict TDD because the helper is a ~10-line pure function whose contract is fully specified in `contracts/calculate-backoff-delay.md`). Phase 4's fake-timer loop test lands **after** the consumer refactor because it exercises the refactored call path — a pre-refactor test would pin the current 5-min behaviour and immediately fail.

**No playbook coupling**: no file matching `packages/claude-plugin-cockpit/commands/*.md` appears in this spec or plan, so no `playbook-verification.test.ts` re-pin task is emitted.

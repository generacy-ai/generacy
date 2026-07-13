# Implementation Plan: Pair resume-event dedupe with pause lifecycle so same-gate re-visits are not stranded

**Feature**: Clear the `phase-tracker:<owner>:<repo>:<issue>:resume:<gate>` dedupe key at the pause site (`LabelManager.onGateHit`) so a fresh pause invalidates the prior cycle's resume dedupe by definition; the 24h TTL survives as a backstop only.
**Branch**: `849-found-during-cockpit-v1`
**Date**: 2026-07-08
**Spec**: [spec.md](./spec.md)
**Clarifications**: [clarifications.md](./clarifications.md)
**Status**: Complete

## Summary

`PhaseTrackerService` writes `phase-tracker:<owner>:<repo>:<issue>:resume:<gate>` with a 24h TTL when a resume event is enqueued (`label-monitor-service.ts:339`, `markProcessed()`), and `LabelMonitorService.processLabelEvent()` short-circuits any second enqueue for the same `(owner, repo, issue, gate)` while that key exists. Every legitimate same-gate re-visit within 24h (PR-feedback re-review after request-changes; a requeued issue re-entering a gate it already cleared) hits the residual key and strands silently. The `type === 'process'` branch already clears its stale dedupe before checking (`label-monitor-service.ts:278-280`); the `resume` branch does not — that gap is the bug.

**Fix**: pair the DEL with the *pause* lifecycle, not the resume check. When `LabelManager.onGateHit(phase, gateLabel)` successfully applies `waiting-for:<gate>` on the issue (i.e., a fresh pause exists on GitHub), it MUST delete `phase-tracker:<owner>:<repo>:<issue>:resume:<gate>`. Ordering is asymmetric on purpose (Q1→A / FR-009): the DEL runs **after** `retryWithBackoff(removeLabels + addLabels)` returns success, never before or inside it — a cleared dedupe guarding a pause that never manifested on GitHub would let a stale `completed:<gate>` from the previous cycle enqueue a resume for a pause that doesn't exist, introducing a *new* failure mode. The DEL is one-shot best-effort (Q2→A / FR-010): a `phaseTracker.clear(...)` call wrapped in a swallow-and-warn — Redis blips at DEL time cost at most 12h of the pre-fix behavior for that single pause, and the TTL backstop absorbs it.

**Wiring** (Q3→A / plan-phase decision): `LabelManager` takes a new optional `clearResumeDedupe?: (gate: string) => Promise<void>` constructor arg. `claude-cli-worker.ts:406` closes over `phaseTracker.clear(item.owner, item.repo, item.issueNumber, ` `resume:${gate}` `)` at wiring time. `LabelManager` stays Redis-free; tests stub one optional function. A `PhaseTrackerService` instance is added to the worker-mode server-boot branch (mirroring the full-mode instantiation at `server.ts:347`) and threaded into `ClaudeCliWorker` via `ClaudeCliWorkerDeps`.

**Observability** (Q4→A / FR-011): on successful paired-clear, `LabelManager.onGateHit` emits `logger.info(...)` with the message "Cleared paired resume dedupe on pause" and structured fields `{ phase, gateLabel, owner, repo, issueNumber }`. On swallowed DEL failure, `logger.warn(...)` with the same fields plus `error`. Turns SC-002 from "grep the runbooks for `redis-cli DEL phase-tracker:`" (measuring the symptom) into "grep the logs for the paired-clear line" (measuring the mechanism).

Scope: two source files (`packages/orchestrator/src/worker/label-manager.ts`, `packages/orchestrator/src/server.ts` — worker-mode branch) plus one wiring site (`packages/orchestrator/src/worker/claude-cli-worker.ts`). No new dependencies, no schema-persisted state, no relay changes, no TTL change. Existing `label-monitor-service.ts:273-282` (`process` clear) untouched (FR-005).

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js ≥22 (per orchestrator package).
**Primary Dependencies**: `ioredis` (via existing `PhaseTrackerService`), `pino` (Logger), `vitest` for tests. No new deps.
**Storage**: Redis — same key layout as today (`phase-tracker:<owner>:<repo>:<issue>:resume:<gate>`, `buildKey()` at `phase-tracker-service.ts:36`). No schema change.
**Testing**: `vitest`. Affected suites:
- `packages/orchestrator/src/worker/__tests__/label-manager.test.ts` — extend for the new callback in `onGateHit`: assert it's invoked with the gate suffix after successful label-apply (FR-001, FR-002), assert it's NOT invoked when `addLabels` throws after retry exhaustion (FR-009), assert pause labels still apply when the callback throws (FR-003 / SC-004), assert the paired-clear log line fires on success and the warn line fires on swallow (FR-011).
- `packages/orchestrator/src/worker/__tests__/phase-loop.test.ts` — smoke test that `LabelManager` is constructed with a non-`undefined` `clearResumeDedupe` when the worker wires `PhaseTrackerService` (the actual invocation is covered in label-manager.test.ts).
- `packages/orchestrator/src/services/__tests__/phase-tracker-service.test.ts` — pre-existing tests unchanged (regression guard for FR-006 TTL backstop). Add one case that clears a key and asserts subsequent `isDuplicate()` returns false (SC-003 backstop of the backstop).
- `packages/orchestrator/src/__tests__/pr-feedback-integration.test.ts` — extend with FR-007 scenario: pause at `waiting-for:implementation-review` → resume → pause at `waiting-for:address-pr-feedback` → resume → pause at `waiting-for:implementation-review` **again** → resume; assert the second `resume:implementation-review` enqueues (no "Duplicate event detected" log line). This is the SC-001 gate.
- One new pure-behavior test in `label-manager.test.ts` for FR-008: pause → immediate duplicate resume trigger inside the *same* cycle → assert the duplicate is still deduped by `PhaseTrackerService.isDuplicate()` (non-regression of the original dedupe purpose).

**Target Platform**: Node orchestrator + worker process inside cluster container. Redis is the shared dedupe store.
**Project Type**: Monorepo package (`packages/orchestrator`). No cross-package changes.
**Performance Goals**: N/A. One extra `Redis.del()` call per pause (~ms). Under Redis contention the swallow-and-warn keeps latency bounded by TTL fallback, not by client blocking.
**Constraints**:
- Zero new dependencies.
- `PhaseTrackerService` interface + implementation unchanged — the fix invokes existing `clear()`.
- `LabelManager.onGateHit()` public signature unchanged (`(phase, gateLabel)`). The new dependency is a constructor arg, not a method arg.
- `label-monitor-service.ts:273-282` (`process` clear) unchanged (FR-005).
- `label-monitor-service.ts:339` (`markProcessed` after enqueue) unchanged — dedupe is still written per cycle; the fix invalidates it at *the next pause*, not at the resume check.
- Default TTL (86400s / 24h) unchanged (FR-006).
- `LabelManager` retains zero Redis dependency; the callback is the only Redis-shaped surface it sees, and it's a `(string) => Promise<void>` — Redis-agnostic.
- DEL runs **after** `addLabels` returns success from `retryWithBackoff` (FR-009 / Q1→A). Not before, not inside the retry, not on retry-exhaustion.
- DEL is one-shot; errors are caught and logged at `warn` (FR-010 / Q2→A). Pause never blocks on Redis health.
- Pause labels are the source of truth: if `addLabels` fails after retries, `onGateHit` throws as today; the DEL never runs; the dedupe stays until TTL for that one pause (FR-009).

**Scale/Scope**: 2 source files modified (`label-manager.ts`, `claude-cli-worker.ts`), 1 modified in worker-mode boot branch (`server.ts`), 2 test files extended, 1 integration test extended. ~40 LOC production, ~140 LOC tests.

## Constitution Check

*GATE: no constitution file at `.specify/memory/constitution.md`. Repository-wide invariants from `CLAUDE.md`, clarifications, and adjacent completed epics (#822, #841, #845, #847):*

| Gate | Result | Note |
|------|--------|------|
| No premature abstractions / no half-finished implementations | PASS | One new optional constructor arg on `LabelManager`, one closure at the wiring site. No new plugin hook, no config surface, no interface split. |
| Match spec Q&A intent, not just the letter | PASS | Q1→A (label-apply first, DEL after retry-success), Q2→A (one-shot best-effort, warn on failure), Q3→A (narrow callback injection, not `PhaseTrackerService` field), Q4→A (dedicated info+warn log lines) — all encoded as FR-009 / FR-010 / plan-phase decision / FR-011 respectively, and mirrored in the implementation. |
| No backwards-compat shims for removed code | PASS | Nothing removed. `clearResumeDedupe` is optional; absent-callback path is identical to today's behavior (skips the DEL, no log). Existing `LabelManager` construction sites outside `claude-cli-worker.ts` (there are none in prod, one in `label-manager.test.ts`) require zero change to pass. |
| Tests hit real behavior, not mocks-of-mocks | PASS | `label-manager.test.ts` asserts on real callback invocation and real logger calls, not on Redis. The pair→resume→pair scenario in `pr-feedback-integration.test.ts` drives the real `PhaseTrackerService` against an in-memory `ioredis-mock` (already wired in that suite), so the SC-001 gate exercises the actual key state transitions. |
| Structured logging conventions | PASS | Both new log calls use the existing `logger.info(obj, msg)` / `logger.warn(obj, msg)` shape (label-manager.ts:37, 45, 63, 173 already establish the cadence). Structured fields chosen to match the surrounding calls: `phase`, `gateLabel`, `issue → issueNumber`, plus `owner` and `repo` because SC-002 needs to identify the specific `(owner, repo, issue)` triple by grep. `error` on the warn path uses `String(error)` matching `ensureCleanup`'s pattern (label-manager.ts:219). |
| Don't add features beyond what the task requires | PASS | No changes to `label-monitor-service.ts` `process` clear (Out of Scope), no TTL knob (Out of Scope), no retroactive repair (Out of Scope), no UI signal (Out of Scope). The paired-clear is scoped to the single `onGateHit` pause path (spec Assumption: unique pause site). |

Post-Phase-1 re-check: no violations introduced.

## Project Structure

### Documentation (this feature)

```text
specs/849-found-during-cockpit-v1/
├── spec.md              # (present, unchanged by /plan)
├── clarifications.md    # (present, unchanged by /plan)
├── plan.md              # THIS FILE
├── research.md          # Phase 0 output — dedupe design decisions + rejected alternatives
├── data-model.md        # Phase 1 output — callback type, LabelManager ctor shape
├── quickstart.md        # Phase 1 output — repro on live cluster, verify fix with log grep
├── contracts/
│   ├── clear-resume-dedupe-callback.md   # Callback signature + failure contract (FR-001, FR-003, FR-004, FR-010)
│   └── on-gate-hit-pairing.md            # Pause-lifecycle ordering + observability (FR-002, FR-009, FR-011)
└── checklists/          # (empty)
```

### Source Code (repository root)

```text
packages/orchestrator/src/
├── worker/
│   ├── label-manager.ts                # MODIFIED — add optional `clearResumeDedupe` ctor arg; call after successful onGateHit label-apply (FR-001, FR-002, FR-009, FR-011)
│   ├── claude-cli-worker.ts            # MODIFIED — accept `phaseTracker` in ClaudeCliWorkerDeps; pass a closure into new LabelManager(...) at line ~406 (Q3→A wiring)
│   └── __tests__/
│       └── label-manager.test.ts       # MODIFIED — extend for clearResumeDedupe invocation, retry-failure skip, callback-throw swallow, log lines (FR-001, FR-002, FR-003, FR-008, FR-009, FR-011)
├── server.ts                           # MODIFIED — instantiate PhaseTrackerService in worker-mode branch (~line 291) and pass into ClaudeCliWorker via deps (mirrors line 347 in full mode)
├── services/
│   └── __tests__/
│       └── phase-tracker-service.test.ts # MODIFIED — add "clear then isDuplicate returns false" case (SC-003 backstop)
└── __tests__/
    └── pr-feedback-integration.test.ts # MODIFIED — add FR-007 scenario: two-cycle pause→resume→pause→resume through implementation-review, assert second resume enqueues (SC-001)
```

**Structure Decision**: Changes stay inside `packages/orchestrator/src/worker/` plus the one server-boot wiring line. The paired-lifecycle invariant lives on the `LabelManager` class (the sole `waiting-for:*` label writer, per spec Assumption 2) — future maintainers adding a new pause path see the callback in the constructor and either wire it or make a deliberate choice not to. Splitting the callback into its own file is not warranted (single call site, tightly coupled to the existing `retryWithBackoff` structure).

## Design Overview

### Callback signature (`LabelManager`)

**Before** (`label-manager.ts:15-22`):
```ts
export class LabelManager {
  constructor(
    private readonly github: GitHubClient,
    private readonly owner: string,
    private readonly repo: string,
    private readonly issueNumber: number,
    private readonly logger: Logger,
  ) {}
```

**After**:
```ts
/**
 * Best-effort DEL of the paired `resume:<gate>` dedupe key.
 * Invoked by `onGateHit` *after* the pause labels are successfully applied on GitHub.
 * Errors thrown by this callback are caught and swallowed at warn — pause labels are
 * the source of truth. Absent (undefined) → paired-clear is skipped (backwards-compat).
 */
export type ClearResumeDedupeCallback = (gate: string) => Promise<void>;

export class LabelManager {
  constructor(
    private readonly github: GitHubClient,
    private readonly owner: string,
    private readonly repo: string,
    private readonly issueNumber: number,
    private readonly logger: Logger,
    private readonly clearResumeDedupe?: ClearResumeDedupeCallback,
  ) {}
```

- The callback accepts a **gate suffix** (e.g., `"implementation-review"`), NOT a full key. The Redis key layout is a `PhaseTrackerService` concern, not a `LabelManager` concern. The worker's closure builds the full `resume:<gate>` phase argument.
- Optional to preserve construction-site compatibility with `label-manager.test.ts:21` and any future non-Redis harness.

### `onGateHit` — paired-clear placement

**Before** (`label-manager.ts:78-97`):
```ts
async onGateHit(phase: WorkflowPhase, gateLabel: string): Promise<void> {
  await this.retryWithBackoff(async () => {
    const phaseLabel = `phase:${phase}`;
    const completedLabel = `completed:${phase}`;
    this.logger.info({...}, `Gate hit: ...`);
    await this.github.removeLabels(this.owner, this.repo, this.issueNumber, [phaseLabel, completedLabel]);
    await this.github.addLabels(this.owner, this.repo, this.issueNumber, [gateLabel, 'agent:paused']);
  });
}
```

**After**:
```ts
async onGateHit(phase: WorkflowPhase, gateLabel: string): Promise<void> {
  await this.retryWithBackoff(async () => {
    const phaseLabel = `phase:${phase}`;
    const completedLabel = `completed:${phase}`;
    this.logger.info({...}, `Gate hit: ...`);
    await this.github.removeLabels(this.owner, this.repo, this.issueNumber, [phaseLabel, completedLabel]);
    await this.github.addLabels(this.owner, this.repo, this.issueNumber, [gateLabel, 'agent:paused']);
  });

  // Paired-clear: the retry block above returned success, so `waiting-for:<gate>` now
  // exists on the issue in GitHub. Invalidate the prior cycle's resume dedupe so the
  // NEXT resume event for this gate can enqueue. One-shot, best-effort (FR-010).
  // Ordering: MUST run after retry-success — if addLabels exhausts retries and throws,
  // this line never runs and the dedupe survives to TTL (FR-009).
  if (this.clearResumeDedupe) {
    const gateSuffix = gateLabel.startsWith('waiting-for:')
      ? gateLabel.slice('waiting-for:'.length)
      : gateLabel;
    try {
      await this.clearResumeDedupe(gateSuffix);
      this.logger.info(
        { phase, gateLabel, owner: this.owner, repo: this.repo, issueNumber: this.issueNumber },
        'Cleared paired resume dedupe on pause',
      );
    } catch (error) {
      this.logger.warn(
        { phase, gateLabel, owner: this.owner, repo: this.repo, issueNumber: this.issueNumber, error: String(error) },
        'Failed to clear paired resume dedupe on pause (non-fatal, TTL backstop will absorb)',
      );
    }
  }
}
```

- **Ordering (FR-009)**: the DEL sits *outside* the `retryWithBackoff` block, executed only when the retry returns without throwing. If `addLabels` exhausts retries and throws, control leaves `onGateHit` via the throw and the DEL never runs — dedupe survives to TTL for exactly one pause. This is the Q1→A "asymmetric partial failure" contract: never clear a dedupe for a pause that didn't manifest on the issue.
- **One-shot (FR-010)**: single `await this.clearResumeDedupe(...)` inside a `try` — no inline retry, no re-throw. `PhaseTrackerService.clear()` already logs at `warn` internally on Redis error (`phase-tracker-service.ts:74-78`); the additional warn here identifies the *caller intent* ("paired-clear on pause") which the service log alone can't convey.
- **Scoping (FR-004)**: the callback receives only `gateSuffix` (e.g., `implementation-review`). The closure at the wiring site builds `resume:<gateSuffix>` and passes to `PhaseTrackerService.clear(owner, repo, issue, ` `resume:${gateSuffix}` `)`. Other dedupe keys — `process:*`, `resume:` for other gates — are untouched.
- **Second-pause safety (FR-002)**: `onGateHit` fires on every gate hit (the label-manager has no "have I seen this gate before?" state). The paired-clear runs *every* time, not just the first — the second pause-in-same-cycle after a webhook redelivery still invalidates the residual dedupe.
- **Gate-suffix parsing**: `LabelManager.onGateHit` receives `gateLabel` in the form `waiting-for:<suffix>` at every call site (`phase-loop.ts` builds it as `` `waiting-for:${gate}` ``). The `startsWith('waiting-for:')` check is defensive — future callers passing a bare suffix still work.

### Worker wiring (`claude-cli-worker.ts:406` and `ClaudeCliWorkerDeps`)

**`ClaudeCliWorkerDeps`** (~line 107):
```ts
export interface ClaudeCliWorkerDeps {
  processFactory?: ProcessFactory;
  sseEmitter?: SSEEventEmitter;
  jobEventEmitter?: JobEventEmitter;
  tokenProvider?: () => Promise<string | undefined>;
  /** Redis-backed phase tracker for paired-clear on pause. Absent → paired-clear is skipped. */
  phaseTracker?: PhaseTracker;
}
```

`ClaudeCliWorker` stores `this.phaseTracker` in the constructor. At the `new LabelManager(...)` site (~line 406):
```ts
labelManager = new LabelManager(
  github,
  item.owner,
  item.repo,
  item.issueNumber,
  workerLogger,
  this.phaseTracker
    ? (gateSuffix: string) =>
        this.phaseTracker!.clear(item.owner, item.repo, item.issueNumber, `resume:${gateSuffix}`)
    : undefined,
);
```

- Closure captures `item.owner`, `item.repo`, `item.issueNumber` at wiring time — no per-call re-lookup.
- `PhaseTracker.clear()` never throws (see `phase-tracker-service.ts:63-79`: try/catch swallows all errors and logs warn). So the `try/catch` in `onGateHit` around the callback is defense-in-depth for any *future* callback implementation that does throw. Today it exercises only the happy path plus the internal-swallow path.
- Non-Redis harnesses (tests, alternate deployments) pass `phaseTracker: undefined` and the paired-clear is skipped — matches pre-fix behavior.

### `server.ts` worker-mode `PhaseTrackerService` instantiation

**Before**: `PhaseTrackerService` is instantiated only in the `!isWorkerMode && config.labelMonitor` branch (line 347). Worker-mode boot (line 291) creates `ClaudeCliWorker` without a tracker.

**After**: The worker-mode branch instantiates `PhaseTrackerService` when `redisClient` is available and passes it via `ClaudeCliWorkerDeps`:
```ts
if (isWorkerMode) {
  // ... existing relay client setup ...
  const workerPhaseTracker = redisClient
    ? new PhaseTrackerService(server.log, redisClient)
    : undefined;
  const cliWorker = new ClaudeCliWorker(
    config.worker,
    server.log,
    { jobEventEmitter, tokenProvider: githubTokenProvider, phaseTracker: workerPhaseTracker },
  );
  // ...
}
```

- The full-mode branch (line 347) is unchanged. The two instances (full-mode monitor's tracker, worker-mode paired-clear tracker) share the same Redis keyspace — same `buildKey` layout, same TTL default — so operations on either instance interoperate. This is the whole point: the worker-mode `clear(resume:<gate>)` invalidates the dedupe key that the full-mode `markProcessed(resume:<gate>)` wrote.
- `redisClient` may be `null` in degraded mode (line 272). In that path `phaseTracker` is `undefined`, `LabelManager` skips the paired-clear, and behavior degrades to "TTL only" — but full-mode `markProcessed` also degrades in the same conditions (no Redis, no dedupe writes) so there's nothing to invalidate. Fully consistent.

### Non-changes (deliberate)

- **`PhaseTrackerService`** — no interface change, no implementation change. The fix invokes the existing `clear()`.
- **`label-monitor-service.ts:273-282`** — the `type === 'process'` clear-before-check pattern is a separate correctness fix for a separate case (re-queue after failure / completion). Deliberately untouched (FR-005). Not moved to a shared helper — the two clears live at semantically different lifecycle points (one at *pause* / worker side, one at *resume-check* / monitor side); coupling them would drag the label-monitor into the worker's dep graph or vice versa.
- **`label-monitor-service.ts:339`** (`markProcessed` after enqueue) — untouched. Dedupe is still written per resume; the fix invalidates it at the *next pause*, which is exactly the paired-lifecycle model spec §Summary calls for.
- **`onResumeStart`** (`label-manager.ts:148-187`) — this method removes stale `waiting-for:*` and `agent:paused` labels on resume. It does NOT need a paired-clear: the resume event that triggered this call already made it past `label-monitor-service.ts` (that's why we're in the worker at all), so the dedupe key is already fresh from the just-written `markProcessed`. Clearing here would be a no-op at best and a subtle race at worst.
- **TTL** — 86400s / 24h stays as the backstop (FR-006). Change is out of scope.
- **Redis key layout** — `phase-tracker:<owner>:<repo>:<issue>:<phase>` unchanged. `<phase>` for resume is still `resume:<gate>`.
- **Retroactive repair** — spec §Out of Scope: existing stranded issues use the documented `redis-cli DEL phase-tracker:<owner>:<repo>:<issue>:resume:<gate>` runbook. Fix only prevents new accumulation.

## Complexity Tracking

*Constitution Check passed; no violations.*

- 0 new files. 0 new interfaces beyond one exported type alias (`ClearResumeDedupeCallback`).
- 1 new optional constructor arg on `LabelManager`. 1 new optional field on `ClaudeCliWorkerDeps`.
- 2 new log lines (one info, one warn) at the same cadence as existing `onGateHit` logs.
- No new dependencies. No new schema-persisted state. No new HTML markers. No relay changes. No TTL knob.

## Risk / Rollback

- **Risk 1**: A future pause path is added (not through `LabelManager.onGateHit`) and the maintainer forgets to clear the paired dedupe. **Mitigation**: spec Assumption 2 flags this explicitly ("If a new pause path is introduced later, it must also clear the paired dedupe key (test guard needed)"). Existing `label-manager.test.ts` covers `onGateHit`'s paired-clear behavior; a new pause path adding `waiting-for:*` labels via a different code path would need its own test. There's no static guard against the drift — this is a documented review-time invariant, not a lint rule. The FR-011 info log at least makes the "no paired-clear ran" state observable post-hoc: an issue that pauses but doesn't emit "Cleared paired resume dedupe on pause" in the logs points at a new unpaired path.
- **Risk 2**: `retryWithBackoff` around `addLabels` exhausts retries silently in transient GitHub outages, the DEL never runs, and the operator sees the pre-fix stranding behavior for that one pause. **Mitigation**: this is the FR-009 asymmetric-partial-failure contract, not a bug — the alternative (DEL first) introduces a *worse* failure mode (cleared dedupe guarding no pause). Operators still have the documented `redis-cli DEL` runbook for the residual 24h. In practice `retryWithBackoff` uses 1s/2s/4s delays and 3 attempts — a truly persistent GitHub outage is already a red-alert state, not a per-issue concern.
- **Risk 3**: The wiring closure at `claude-cli-worker.ts:406` captures `item.owner` / `item.repo` / `item.issueNumber` in scope; if a maintainer refactors the surrounding block and moves `LabelManager` construction outside the per-`item` scope, the closure would capture stale identifiers. **Mitigation**: the closure is defined at the same site that captures `github`, `workerLogger`, etc. from `item` — the same failure mode already exists for those. The `PhaseTracker.clear()` signature explicitly takes `(owner, repo, issue, phase)` so any misuse would be visible in a code review as a hard-coded triple.
- **Risk 4**: `PhaseTrackerService.clear()` on a non-existent key is a no-op (`DEL` returns `0`, no error) — so calling this on the very first pause (before any resume has written a key) is safe. Confirmed against `phase-tracker-service.ts:71`: `redis.del(key)` is unconditionally executed; the info log ("Cleared dedup key") fires even on absent keys. This is harmless but produces one info log per first-time pause. Acceptable noise.
- **Risk 5**: In worker-mode with `redisClient === null` (Redis unavailable), the paired-clear is silently skipped (undefined callback). Full-mode is also skipping `markProcessed` in the same conditions — so there's nothing to invalidate and no stranding to prevent. Fully consistent, but if Redis is later re-enabled while stranded state exists from before the fix landed, the paired-clear will unblock those issues at the next pause hit. This is a *positive* recovery property.
- **Rollback**: revert the two modified source files and the worker-mode `server.ts` wiring line, revert the test extensions. Zero data migration, zero schema change, zero relay-payload change. Existing dedupe keys age out on their TTL (≤24h) as before. Operators fall back to the `redis-cli DEL` runbook for stranded issues.

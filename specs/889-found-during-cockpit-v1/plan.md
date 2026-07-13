# Implementation Plan: `waiting-for:merge-conflicts` provisioning + label-op crash-loop fix

**Feature**: Fix two independent defects that compose the observed crash-loop when the pre-implement base-merge (#864) detects a `CLAUDE.md` conflict on repos that predate `waiting-for:merge-conflicts`. Land (1) the missing label in `WORKFLOW_LABELS`, (2) a memoized create-if-missing ensure-pass in `LabelManager`, (3) a discriminated `WorkerResult` that lets `WorkerDispatcher` mark a label-op-exhaustion terminal-failed (not released), and (4) an audit test that fails whenever a new protocol label symbol appears in the codebase without a matching `WORKFLOW_LABELS` entry.
**Branch**: `889-found-during-cockpit-v1`
**Status**: Complete

## Summary

Two defects compose the observed `sniplink#6 / #7` crash-loop:

1. **Missing provisioning** — `phase-loop.ts:796` emits `waiting-for:merge-conflicts` at the pause site, but the label is *not* in `WORKFLOW_LABELS` (`label-definitions.ts:20-105`), so pre-#864 repos have no such label. `gh issue edit --add-label` hard-fails (`gh-cli.ts:779-791`), the retry backoff exhausts, and the error propagates out of `LabelManager.onGateHit`.
2. **Crash-loop on label-op exhaustion** — the exhausted throw bubbles through `phase-loop.pausePreMergeConflict` → `phase-loop.executeLoop` → `claude-cli-worker.processItem` (re-thrown at `claude-cli-worker.ts:668`), and `WorkerDispatcher.runWorker` catches it as an unhandled failure and calls `queue.release(...)` (`worker-dispatcher.ts:350`). The next worker re-claims the same item, re-runs base-merge, re-hits the conflict, re-hits the missing label → indefinite cycle.

The fix has four parts that ship together:

- **FR-001** — add `waiting-for:merge-conflicts` (color `FBCA04`, description `"Waiting for base-merge conflict resolution"`) to `WORKFLOW_LABELS`. Trivially closes the observed miss and lets `LabelSyncService` create it on the next repo touch.
- **FR-002 (Q1→C, memoized boundary net)** — `LabelManager` gains a per-`(process, repo)` memoized `ensureRepoLabelsExist()` pass that runs once, lazily, before the first `addLabels` call in the process's lifetime for that repo. It fetches the repo's current labels via `listLabels`, computes the missing set against `WORKFLOW_LABELS`, and calls `createLabel` for each miss. Steady-state cost after warm-up is zero. `LabelSyncService` continues to sync on repo-add / worker boot as the latency optimization; the memoized ensure-pass is the *load-bearing* correctness mechanism the tests target.
- **FR-003 (Q2→D + Q4→D, terminal-failed result, all four sites uniform)** — `LabelManager`'s four retry-exhaustion sites (`onGateHit`, `onPhaseStart`, `onPhaseComplete`, `onError`) throw a new `TerminalLabelOpError` carrying `{ site: 'gate-hit' | 'phase-start' | 'phase-complete' | 'error'; labelOp; ghStderr }`. `phase-loop.ts` and `claude-cli-worker.ts` catch this class distinctly, produce a `WorkResult` variant `{ status: 'failed-terminal', failureMetadata }`, and `WorkerDispatcher.runWorker` branches: `failed-terminal` → `queue.complete(...)` (no release), generic throw → `queue.release(...)` (unchanged). The `WorkerHandler` type widens from `Promise<void>` to `Promise<WorkerResult>` — every existing caller returns the implicit `{ status: 'completed' }` on happy path via a small adapter.
- **FR-004 (Q3→B, alert comment authoritative)** — on `failed-terminal`, `WorkerDispatcher` (the single authority — Q2→D) emits the FR-004 alert. Emission order: (a) best-effort `LabelManager.onError` to apply `agent:error` — try/catch, `warn` on failure, do NOT re-throw; (b) `StageCommentManager.postFailureAlert(...)` reusing the existing #865 contract, extended with a new `stage: 'label-op'` value and `evidence` shape carrying `{ command: 'gh issue edit --add-label <label>'; exitDescriptor: 'exited 1'; stderrTail: <ghStderr> }`; (c) if the alert comment itself fails, structured `error`-level log with `{ site, labelOp, ghStderr, alertError }`, still no re-throw, still no release. Missing-label case self-heals on the *next* attempt after FR-002 creates the label; the alert is only observed when GitHub is broken end-to-end.
- **FR-007 (Q5→D, hybrid audit)** — a Vitest test walks `packages/orchestrator/**/*.ts` and `packages/workflow-engine/**/*.ts` (excluding `__tests__/**`) with a regex scan for string literals matching `/^(phase|completed|waiting-for|failed|agent):[a-z-]+$/`, unions the set with a runtime-registry probe on the phase-loop's `onGateHit` / `onPhaseStart` / `onPhaseComplete` / `onError` boundaries via mocked runs, and asserts the union ⊆ `WORKFLOW_LABELS.map(l => l.name)`. Fails today for `waiting-for:merge-conflicts`, passes after FR-001.

## Technical Context

- **Language / runtime**: TypeScript, Node.js >=22, ESM. Packages `@generacy-ai/orchestrator` (`packages/orchestrator`) and `@generacy-ai/workflow-engine` (`packages/workflow-engine`).
- **Test runner**: Vitest (`packages/orchestrator/vitest.config.ts`, `packages/workflow-engine/vitest.config.ts`).
- **New dependencies**: none. All primitives already available: `node:fs/promises` (`readdir`, `readFile`) for the audit walk, `gh` CLI (via existing `GitHubClient`) for `listLabels` / `createLabel`.
- **Behavioral invariants preserved**:
  - Happy path of `LabelManager` (successful `addLabels`) — no observable change; the ensure-pass runs once per repo and returns early on repeat calls.
  - Generic thrown errors in `processItem` — still release (existing behavior for non-label failures).
  - `#864` merge-conflict pause protocol — untouched; this fix only patches the label plumbing beneath it.

## Constitution Check

No `.specify/memory/constitution.md` exists in the repo — no project-level constitutional constraints to verify. The change respects the standing generacy conventions:

- Additive-only public API (`WorkerHandler` widens `Promise<void>` → `Promise<WorkerResult>` with a discriminated-union carrying `status: 'completed'` as the default; all existing handlers keep their observable contract via a one-line adapter).
- `WORKFLOW_LABELS` remains the single source of truth for provisionable labels (FR-002 memoized ensure-pass consumes it directly; the FR-007 audit test asserts it).
- Failure surfaces reuse the #865 `FAILURE_ALERT_MARKER_PREFIX` contract (extended additively with `stage: 'label-op'`) — no new alert channel, no new marker.
- Tests colocated under `packages/orchestrator/src/worker/__tests__/` and `packages/orchestrator/src/services/__tests__/`; audit test under `packages/orchestrator/src/__tests__/label-protocol-audit.test.ts` (root level — it sweeps both packages).

## Project Structure

```
packages/
├── workflow-engine/
│   └── src/actions/github/
│       └── label-definitions.ts                          # MODIFIED — add `waiting-for:merge-conflicts` (FR-001)
├── orchestrator/
│   └── src/
│       ├── worker/
│       │   ├── label-manager.ts                          # MODIFIED — ensureRepoLabelsExist memoized (FR-002); retry sites throw TerminalLabelOpError (FR-003)
│       │   ├── terminal-label-op-error.ts                # NEW — typed error class + isTerminalLabelOpError() guard
│       │   ├── worker-result.ts                          # NEW — discriminated WorkerResult { status: 'completed' | 'failed-terminal' | 'released'; failureMetadata? }
│       │   ├── phase-loop.ts                             # MODIFIED — pausePreMergeConflict (and any other onGate/onPhase* callers) catches TerminalLabelOpError and surfaces via PhaseLoopResult
│       │   ├── claude-cli-worker.ts                      # MODIFIED — processItem catches TerminalLabelOpError, returns WorkerResult; happy path returns { status: 'completed' }
│       │   ├── stage-comment-manager.ts                  # MODIFIED — extend FailureAlertData.stage union with 'label-op'; renderFailureAlert supports the new stage summary line
│       │   └── __tests__/
│       │       ├── label-manager.ensure.test.ts          # NEW — FR-002 memoized ensure-pass (once per repo, self-heals missing labels, no-op on hot path)
│       │       ├── label-manager.terminal.test.ts        # NEW — FR-003 retry exhaustion throws TerminalLabelOpError at all four sites
│       │       └── phase-loop.merge.test.ts              # MODIFIED — regression fixture: pre-existing repo without waiting-for:merge-conflicts pauses successfully after the ensure-pass creates it (FR-005)
│       ├── services/
│       │   ├── worker-dispatcher.ts                      # MODIFIED — runWorker branches on WorkerResult.status: 'failed-terminal' → complete + alert; generic throw → release (unchanged)
│       │   └── __tests__/
│       │       └── worker-dispatcher.terminal.test.ts    # NEW — FR-006 label-op exhaustion produces failed-terminal, dispatcher completes (not releases), agent:error best-effort, alert comment fires
│       ├── types/
│       │   └── monitor.ts                                # MODIFIED — WorkerHandler return type widens to Promise<WorkerResult>
│       └── __tests__/
│           └── label-protocol-audit.test.ts              # NEW — FR-007 hybrid audit: static regex walk (load-bearing) + runtime-registry probe (secondary) asserts union ⊆ WORKFLOW_LABELS
└── (no other packages touched)
```

## Implementation Sequence

1. **FR-001 — add the missing label.** Append `{ name: 'waiting-for:merge-conflicts', color: 'FBCA04', description: 'Waiting for base-merge conflict resolution' }` to `WORKFLOW_LABELS` in `packages/workflow-engine/src/actions/github/label-definitions.ts`. Placement: after `waiting-for:dependencies` (alphabetical is not preserved elsewhere, so grouped with the `waiting-for:*` block per prevailing style).
2. **FR-002 — memoized ensure-pass.** In `LabelManager`:
   - Constructor gains a `private ensurePromise: Promise<void> | null = null` field and a shared per-process cache `LabelManager.ensuredRepos: Set<string>` (key `"owner/repo"`). Cache lives at the class level so multiple `LabelManager` instances (per-issue) in the same worker process share it.
   - New private method `private async ensureRepoLabelsExist(): Promise<void>` — returns early if the `(owner, repo)` pair is already in `LabelManager.ensuredRepos`. Otherwise calls `github.listLabels(owner, repo)`, computes `WORKFLOW_LABELS.filter(l => !existing.has(l.name))`, calls `github.createLabel(...)` per miss (best-effort per-label — a create failure is logged at `warn` but does not abort the pass; the subsequent `addLabels` will surface the real error). On the first call, `ensurePromise` holds the in-flight Promise so concurrent callers await the same pass; on completion, `LabelManager.ensuredRepos` is populated and `ensurePromise` is cleared. All subsequent calls are O(1).
   - Every retry-wrapped method (`onPhaseStart`, `onPhaseComplete`, `onGateHit`, `onError`, `onResumeStart`) calls `await this.ensureRepoLabelsExist()` as the first statement *inside* the `retryWithBackoff` callback. Placing it inside the retry means a transient `listLabels` failure gets retried too, and a partial ensure that failed on `createLabel` retries the whole pass on the next `retryWithBackoff` attempt (idempotent — `gh label create` on an existing label is safely re-runnable, though we prefer the pre-check via `listLabels`).
3. **FR-003 — terminal error class + WorkerResult discriminated union.**
   - Create `packages/orchestrator/src/worker/terminal-label-op-error.ts` exporting `class TerminalLabelOpError extends Error { readonly site: 'gate-hit' | 'phase-start' | 'phase-complete' | 'error'; readonly labelOp: string; readonly ghStderr: string; }` plus `export function isTerminalLabelOpError(e: unknown): e is TerminalLabelOpError`.
   - Create `packages/orchestrator/src/worker/worker-result.ts` exporting `type WorkerResult = { status: 'completed' } | { status: 'failed-terminal'; failureMetadata: { site: TerminalLabelOpError['site']; labelOp: string; ghStderr: string } }`. `'released'` is NOT in the union — release is the *default* behavior on unhandled throw at the dispatcher, not something `processItem` returns explicitly. Q2→D naming reduced to the two states `processItem` actually authors.
   - In `LabelManager.retryWithBackoff` — the final-attempt throw wraps the underlying `Error` in `TerminalLabelOpError` if the caller passes a `site` + `labelOp` descriptor. Update all four callers (`onGateHit`, `onPhaseStart`, `onPhaseComplete`, `onError`) to pass `{ site, labelOp }` context into `retryWithBackoff`. `onResumeStart` and `onWorkflowComplete` also throw the terminal error class for site coverage; `ensureCleanup`'s existing swallow behavior is unchanged (already best-effort).
   - `packages/orchestrator/src/types/monitor.ts` — `WorkerHandler` type changes to `(item: QueueItem) => Promise<WorkerResult>`.
4. **FR-003 — worker/dispatcher wiring.**
   - `phase-loop.ts` — `pausePreMergeConflict` (and any other site that awaits `deps.labelManager.on*`) catches `TerminalLabelOpError`, and returns a new `PhaseLoopResult` shape variant `{ status: 'failed-terminal'; failureMetadata }`. The existing `PhaseLoopResult` interface grows a discriminated `status` field (default `'completed'`).
   - `claude-cli-worker.ts` — `processItem`'s outer `try/catch` block gains an `else if (isTerminalLabelOpError(error) || loopResult.status === 'failed-terminal')` branch that returns `{ status: 'failed-terminal', failureMetadata }` instead of re-throwing. Every other return path returns `{ status: 'completed' }`. Non-label errors continue to re-throw (unchanged release behavior).
   - `worker-dispatcher.ts` — `runWorker` awaits `this.handler(item)` and branches on the returned `WorkerResult`:
     - `status === 'completed'` → `queue.complete(...)` (unchanged).
     - `status === 'failed-terminal'` → best-effort `LabelManager.onError` (via injected label-op-cleanup fn or new callback), then `stageCommentManager.postFailureAlert(...)` with `stage: 'label-op'` and `evidence` built from `failureMetadata`, then `queue.complete(...)`. Every step wrapped in `try/catch`; failures logged at `warn`/`error` per Q3→B. **Never re-throw, never release** on this branch.
     - Generic `catch` on the outer try (unhandled throw from handler) → `queue.release(...)` (unchanged).
5. **FR-004 — alert comment.**
   - `stage-comment-manager.ts` — extend the `FailureAlertData.stage` union with `'label-op'` (or the equivalent string literal — verify the current `types.ts` FailureAlertData shape). `renderFailureAlert`'s summary line for `stage: 'label-op'` reads: `` ❌ **label operation failed** — `<labelOp>` at site `<site>` (exited 1). ``. Reuses the existing `<details><summary>stderr…` block with `evidence.stderrTail = ghStderr`. Marker uses stage `label-op` and a fresh `runId = crypto.randomUUID()` minted at the dispatcher call site.
6. **FR-005 — regression test for pre-existing-repo pause.** Extend `phase-loop.merge.test.ts` with a fixture: `github.listLabels` returns a set *without* `waiting-for:merge-conflicts`, then `addLabels` for `[waiting-for:merge-conflicts, agent:paused]` is asserted to succeed because the ensure-pass created it just before. Test asserts the sequence: `listLabels` → `createLabel('waiting-for:merge-conflicts', ...)` → `addLabels([...])`, all within one `onGateHit` call.
7. **FR-006 — regression test for terminal fail path.** New `packages/orchestrator/src/services/__tests__/worker-dispatcher.terminal.test.ts`. Mocks a handler that returns `{ status: 'failed-terminal', failureMetadata: { site: 'gate-hit', labelOp: 'addLabels(waiting-for:merge-conflicts)', ghStderr: 'label not found' } }`. Asserts (a) `queue.complete` called, (b) `queue.release` NOT called, (c) `stageCommentManager.postFailureAlert` called with `stage: 'label-op'`, (d) `LabelManager.onError` invoked best-effort, (e) worker continues to next item after failure (no unhandled throw escapes).
8. **FR-007 — hybrid audit test.** New `packages/orchestrator/src/__tests__/label-protocol-audit.test.ts`:
   - **Load-bearing static scan**: recursively `readdir` `packages/orchestrator/src/` and `packages/workflow-engine/src/`, filter to `*.ts` excluding `**/__tests__/**` and `**/*.test.ts`, `readFile` each, regex-match `/(['"`])(phase|completed|waiting-for|failed|agent):[a-z0-9-]+\1/g`. Union all matches, subtract `WORKFLOW_LABELS.map(l => l.name)`; assert the difference is empty.
   - **Secondary runtime-registry probe**: instantiate `LabelManager` with a mock `GitHubClient` that captures every `addLabels` call. Drive representative flows: `onGateHit(<each WorkflowPhase>, 'waiting-for:merge-conflicts')`, `onPhaseStart(<each phase>)`, `onPhaseComplete(<each phase>)`, `onError(<each phase>)`, `onResumeStart()`, `onWorkflowComplete()`. Assert every captured label symbol is in `WORKFLOW_LABELS`, AND assert the memoized `ensureRepoLabelsExist` was called exactly once across the sequence (proves the memoization from FR-002).
9. **FR-008 — non-regression.** All existing `label-manager.test.ts` and `phase-loop.merge.test.ts` cases pass unchanged. The one behavioral surface that changes on failure paths (throw → return-typed result) is caught by targeted new tests; every happy-path assertion is untouched.

## Contracts

- `contracts/worker-result.md` — the `WorkerResult` discriminated union spec.
- `contracts/terminal-label-op-error.md` — `TerminalLabelOpError` fields, propagation rules, and the four `site` values.
- `contracts/failure-alert-label-op.md` — additive extension to the #865 failure-alert-comment contract for `stage: 'label-op'`.

## Data Model

See `data-model.md`.

## Risks & Non-Risks

- **Non-risk — memoization staleness.** The per-process cache is intentional: if a repo drifts (someone deletes `waiting-for:merge-conflicts` mid-flight), the next process restart re-runs the ensure-pass. The reactive on-boundary `retryWithBackoff` still retries the `addLabels` up to 3 times, so a transient drift within a single process either self-heals via retry or falls through to the FR-003 terminal path — no crash-loop either way.
- **Non-risk — WorkerHandler contract change.** Every existing production caller of `WorkerHandler` returns the implicit `{ status: 'completed' }` on success via a small adapter in `claude-cli-worker.ts`. External consumers (if any) can be located via `git grep 'WorkerHandler'`; the widened return type is TypeScript-enforced.
- **Non-risk — memoization across `LabelManager` instances.** Class-level `Set` shared across per-issue instances in the same process avoids re-running the ensure-pass for every issue in the same repo. Multi-worker containers each have their own process → their own cache → their own single ensure-pass at boot — expected.
- **Risk (mitigated) — `createLabel` race between concurrent workers on the same repo.** `gh label create` on an already-existing label fails with an exit code; we mitigate by pre-checking via `listLabels` and swallowing `Error: already exists` (`already exists` substring in stderr) at the `createLabel` call site. Not sufficient? Fall back to `gh label create --force` (idempotent per assumptions §Assumptions). The FR-002 test does not need to cover this because within a single process the memoization prevents re-entry; cross-process races are extraordinarily rare (both would have to hit the ensure-pass in the same ~100ms window on a repo whose labels drifted).
- **Risk (mitigated) — audit test false positives.** The regex `/^(phase|completed|waiting-for|failed|agent):[a-z0-9-]+$/` intentionally *does not* match arbitrary strings — the trailing character class rejects capital letters, whitespace, and punctuation, which excludes the vast majority of accidental matches. A curated `AUDIT_EXCLUSIONS: Set<string>` at the top of the test file handles the small number of legitimate exceptions if any surface (e.g., a doc-string prefix that happens to include a `waiting-for:*` example); today none are needed.

## Next Step

Run `/speckit:tasks` to generate the task list.

# Implementation Plan: Failure evidence posts a fresh bottom-of-thread comment

**Feature**: On the transition into `status: 'error'` for a terminal failure, post a NEW bottom-of-thread comment on the GitHub issue (not an in-place edit) carrying a summary line + collapsible `<details>` block with the `#847` evidence payload. Fires a real GitHub notification instead of shipping the evidence silently.
**Branch**: `865-found-during-cockpit-v1`
**Date**: 2026-07-08
**Spec**: [spec.md](./spec.md)
**Clarifications**: [clarifications.md](./clarifications.md)
**Status**: Complete

## Summary

`#847` landed the failure-evidence block — the failing command, exit descriptor, and bounded stderr tail now render at the bottom of the stage comment on every `status: 'error'` transition. **But the stage comment was posted at workflow start, hours before the failure.** The evidence write is done via `github.updateComment` — an in-place edit that generates zero GitHub notification and no new timeline activity. On `christrudelpw/sniplink#3` (2026-07-08T20:59Z), the fully-rendered evidence sat eleven comments up-thread while the on-call developer went to container logs to diagnose. Shipped-but-buried is operationally the same as missing.

**Fix** (per clarifications Q1→A, Q2→A, Q3→C, Q4→A, Q5→C): on the transition into `status: 'error'` for a *terminal* failure (would land the workflow in `waiting-for:developer`), post a **new** comment at the bottom of the thread via `github.addIssueComment`. The new comment carries:
- A summary line naming the failing phase, failing command, and exit descriptor (email/mobile notification preview shows the diagnosis without a click).
- A collapsible `<details>` block containing the verbatim `buildErrorEvidence` output from `#847` — no re-derivation.
- An HTML marker `<!-- generacy:failure-alert:<stage>:<runId> -->` where `<runId>` is a stable per-`runPhaseLoop`-invocation token.

Dedup is by GitHub marker search (mirror of `findOrCreateStageComment`'s `STAGE_MARKERS` lookup) — one `getIssueComments` call per error transition, state lives on GitHub, survives worker restarts, no new Redis key (aligned with `#862`'s move away from `phase-tracker:*` history-keyed dedupe).

Terminal vs. intermediate: intermediate `implement` retries that the worker will self-heal within `maxImplementRetries` stay silent (they're not actionable). Only the terminal failure at the last retry alerts. The `phase-loop.ts:~278` no-progress site currently *fails* without emitting `errorEvidence` (see the code path — the `updateStageComment({ status: 'error', ..., prUrl })` call at line 278 has no `errorEvidence` argument). FR-007 closes that gap so the alert always has diagnostic content in its `<details>` block.

The canonical stage comment continues to render the evidence in place — the alert is a second consumer of the same `buildErrorEvidence` output, not a replacement. Zero re-derivation of evidence content.

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js ≥22 (per orchestrator package).
**Primary Dependencies**: `zod` (unchanged — no config surface added), `pino` (Logger), `vitest` for tests, existing `GitHubClient` (`addIssueComment`, `getIssueComments`), existing `PhaseResult.error` shape. Reuses `#847`'s `boundStderrTail` and `buildErrorEvidence` (private helper on `PhaseLoop`) verbatim — no new evidence derivation.
**Storage**: N/A — alert state lives on GitHub as the marker on the posted comment. No new Redis keys, no new schema-persisted state.
**Testing**: `vitest`. Affected suites:
- `packages/orchestrator/src/worker/__tests__/phase-loop.test.ts` — extend for `runId` minting on entry, `errorEvidence` at the no-progress site, terminal-vs-intermediate alert gating, and dedup on repeated error transitions.
- `packages/orchestrator/src/worker/__tests__/stage-comment-manager.test.ts` — extend for new `postFailureAlert` API (summary-line format, `<details>` block, marker rendering), and dedup path (marker present → no duplicate post).
- One or two focused product-code additions: a marker constant + a `runId`-mint helper, both unit-tested.
**Target Platform**: Node worker inside cluster orchestrator container. No shell / spawner path changes — this is purely GitHub-API surface.
**Project Type**: Monorepo package (`packages/orchestrator`). Zero docs touchpoints — the alert marker is an internal identifier for future cockpit consumption; user-facing behavior change is the notification itself, not a doc-visible surface.
**Performance Goals**: N/A. One additional `getIssueComments` + one `addIssueComment` per terminal-failure occurrence (rare: per `runPhaseLoop`, not per poll). Additive cost ≤ 2 API calls per error transition, executed on an already-cold path (the workflow is about to pause for developer intervention).
**Constraints**:
- Zero new dependencies.
- `PhaseResult` interface unchanged (evidence remains threaded via `StageCommentData` from `#847`).
- `StageCommentData` unchanged for the canonical stage-comment surface (FR-008 — evidence still renders in-place).
- No new Redis / `phase-tracker:*` keys (per Q2/A; consistent with `#862`).
- No new relay events, no new SSE frames — the surface is the GitHub issue thread only.
- The `<runId>` MUST be stable for the full `runPhaseLoop` invocation. Multi-phase failures within one invocation share the same `runId` and therefore the same marker → dedup suppresses the second alert.
- The alert comment MUST fire `github.addIssueComment` (creates a new comment → notification), NEVER `github.updateComment` (silent edit).
- Rendered alert body MUST be bounded — reuses `#847`'s ≤ 4 KiB `boundStderrTail` cap; total alert body ≤ 6 KiB worst case (well under GitHub's 65 KiB comment cap).
**Scale/Scope**: 3 source files modified (`phase-loop.ts`, `stage-comment-manager.ts`, `types.ts`), 0 new production files, 2 test files extended. ~80 LOC production, ~140 LOC tests.

## Constitution Check

*GATE: no constitution file at `.specify/memory/constitution.md`. Repository-wide invariants from `CLAUDE.md`, this feature's clarifications, and the adjacent completed `#847` epic:*

| Gate | Result | Note |
|------|--------|------|
| No premature abstractions / no half-finished implementations | PASS | Alert-posting is one new method on the existing `StageCommentManager` (`postFailureAlert`) plus one field-thread on `StageCommentData` (the `runId`). The `runId` mint is a single `crypto.randomUUID()` call at `executeLoop` entry — no new module, no new type indirection. |
| Match spec Q&A intent, not just the letter | PASS | Q1→A (per `runPhaseLoop` invocation → single `runId` per invocation), Q2→A (GitHub marker search, mirror of `findOrCreateStageComment`), Q3→C (summary line + `<details>` block with verbatim `#847` evidence), Q4→A (`<!-- generacy:failure-alert:<stage>:<runId> -->` marker), Q5→C (terminal only + close no-progress evidence gap in same PR). All five answers observable in test assertions. |
| No backwards-compat shims for removed code | PASS | Nothing removed. Stage-comment rendering unchanged (FR-008). Existing three `updateStageComment({ status: 'error' })` sites keep their `errorEvidence` argument from `#847`. The new alert call is *additional*, not a replacement. |
| Tests hit real behavior, not mocks-of-mocks | PASS | `stage-comment-manager.test.ts` asserts on exact rendered markdown byte strings for the alert body (summary line, `<details>` structure, marker line). Dedup test uses a real `getIssueComments` stub returning a body containing the same marker — asserts no `addIssueComment` call is made. `phase-loop.test.ts` asserts `runId` uniqueness across two independent `executeLoop` invocations and stability within one. |
| Structured logging conventions | PASS | One new log line: `logger.info({ stage, runId, commentId }, 'Posted failure alert comment')` on successful post, `logger.info({ stage, runId, existingCommentId }, 'Failure alert already exists — suppressing duplicate post')` on dedup hit. Both follow the existing `pino` object-first pattern used elsewhere in the file. |
| Don't add features beyond what the task requires | PASS | Out of scope (explicit): (a) intermediate-retry alerts (Q5→C), (b) cockpit-side UI for consuming the `generacy:failure-alert:*` marker (marker is defined here for future use — no cockpit changes required by this spec), (c) success / gate-transition alerts (failure-only surface), (d) migrating existing `phase-tracker:*` dedupe keys (deferred to `#862`). |

Post-Phase-1 re-check: no violations introduced.

## Project Structure

### Documentation (this feature)

```text
specs/865-found-during-cockpit-v1/
├── spec.md              # (present, unchanged by /plan)
├── clarifications.md    # (present, unchanged by /plan)
├── plan.md              # THIS FILE
├── research.md          # Phase 0 output — decisions + rejected alternatives
├── data-model.md        # Phase 1 output — runId threading, marker format, no new persisted types
├── quickstart.md        # Phase 1 output — repro the buried-evidence bug + verify the notification end-to-end
├── contracts/
│   └── failure-alert-comment.md   # Alert-comment rendering + dedup contract (FR-001..FR-008)
└── checklists/          # (empty)
```

### Source Code (repository root)

```text
packages/orchestrator/src/worker/
├── phase-loop.ts                    # MODIFIED — mint runId at executeLoop entry; thread runId + call postFailureAlert() at each terminal-error site (FR-001, FR-003, FR-005, FR-006); add errorEvidence at the no-progress site line ~278 (FR-007)
├── stage-comment-manager.ts         # MODIFIED — add postFailureAlert(stage, runId, evidence) API; render summary line + <details> block + marker; dedup via getIssueComments marker scan (FR-002, FR-003, FR-004)
├── types.ts                         # MODIFIED — export FAILURE_ALERT_MARKER_PREFIX constant; add FailureAlertData type for postFailureAlert input
└── __tests__/
    ├── phase-loop.test.ts               # MODIFIED — assert runId minting/stability, postFailureAlert called on terminal errors, NOT called on intermediate retries, evidence present at no-progress site
    └── stage-comment-manager.test.ts    # MODIFIED — assert alert body layout, marker format, dedup on repeat post
```

Out of repo (referenced only, not modified by this PR):

```text
packages/cockpit/…               # Future consumer of the FAILURE_ALERT_MARKER_PREFIX — no changes required by this spec
```

**Structure Decision**: Single-package modification inside `packages/orchestrator/src/worker/`. The alert-posting method sits on the existing `StageCommentManager` — it already owns the `GitHubClient`, the `owner`/`repo`/`issueNumber` context, and the marker-scan pattern (`findOrCreateStageComment`). Adding a sibling method reuses all four; introducing a new class would duplicate them for a single new operation. The `runId` is minted at `PhaseLoop.executeLoop` entry (existing entry-point, no new invocation seam) and threaded to `buildErrorEvidence`-adjacent call sites as a plain string parameter — no context object, no new type on `WorkerContext`.

## Design Overview

### Runtime flow at a terminal-error site

**Before (post-`#847`)**:
```ts
// phase-loop.ts, inside executeLoop, at each of ~4 terminal-error sites
await stageCommentManager.updateStageComment({
  stage,
  status: 'error',
  phases: ...,
  startedAt: ...,
  errorEvidence: this.buildErrorEvidence(command, result, timeout),
});
return { results, completed: false, lastPhase: phase, gateHit: false };
```

**After**:
```ts
// runId is minted once at executeLoop entry:
//   const runId = crypto.randomUUID();
// threaded down to each error site as a local variable (no context/state changes)

const evidence = this.buildErrorEvidence(command, result, timeout);

// (1) Existing: update the canonical stage comment (in-place edit) — unchanged
await stageCommentManager.updateStageComment({
  stage,
  status: 'error',
  phases: ...,
  startedAt: ...,
  errorEvidence: evidence,
});

// (2) New: post a bottom-of-thread alert comment (fires notification)
await stageCommentManager.postFailureAlert({
  stage,
  runId,
  phase,
  command,
  evidence,
});

return { results, completed: false, lastPhase: phase, gateHit: false };
```

The two calls remain adjacent — one edits the canonical comment (unchanged from `#847`), one posts the notification-triggering alert (new). Order does not matter for correctness; the alert-post is second so a failure in the alert path does not corrupt the canonical stage comment.

### `runId` minting and threading

At `PhaseLoop.executeLoop` entry:
```ts
const runId = crypto.randomUUID();
this.logger.info({ startPhase: context.startPhase, runId, ... }, 'Starting phase loop');
```

`runId` is a plain `string` local variable inside `executeLoop`. It is captured by closure at each of the terminal-error sites and passed as an argument to `stageCommentManager.postFailureAlert`. It is NOT added to `WorkerContext` (which would leak the identifier across method boundaries it doesn't cross), NOT added to `PhaseResult` (evidence data model is unchanged per FR-008), and NOT persisted to Redis or the workflow store.

**Restart semantics**: a worker restart mid-`executeLoop` mints a new `runId` on the next invocation. If the retry then reaches a terminal-error site, the marker will differ (`<stage>:<newRunId>` vs. `<stage>:<oldRunId>`), and a fresh alert will be posted. This is acceptable per Q4/A — the phase genuinely re-ran, and the developer should get a fresh notification.

### `postFailureAlert` on `StageCommentManager`

**New method** (`stage-comment-manager.ts`):
```ts
async postFailureAlert(data: FailureAlertData): Promise<void> {
  const marker = `<!-- generacy:failure-alert:${data.stage}:${data.runId} -->`;

  // Dedup: scan existing issue comments for this exact marker
  const comments = await this.github.getIssueComments(
    this.owner, this.repo, this.issueNumber,
  );
  const existing = comments.find((c) => c.body.includes(marker));
  if (existing) {
    this.logger.info(
      { stage: data.stage, runId: data.runId, existingCommentId: existing.id },
      'Failure alert already exists — suppressing duplicate post',
    );
    return;
  }

  const body = this.renderFailureAlert(marker, data);
  const created = await this.github.addIssueComment(
    this.owner, this.repo, this.issueNumber, body,
  );
  this.logger.info(
    { stage: data.stage, runId: data.runId, commentId: created.id },
    'Posted failure alert comment',
  );
}

private renderFailureAlert(marker: string, data: FailureAlertData): string {
  const evidence = data.evidence;
  const lineCount = evidence.stderrTail.split('\n').length;
  // Reuse #847's triple-backtick neutralization (u200b ZWSP between first two)
  const safeStderr = evidence.stderrTail.replace(/```/g, '`​``');
  return [
    marker,
    `❌ **${data.phase} failed** — \`${evidence.command}\` ${evidence.exitDescriptor}.`,
    '',
    `<details><summary>stderr (last ${lineCount} lines)</summary>`,
    '',
    '```text',
    safeStderr,
    '```',
    '',
    '</details>',
  ].join('\n');
}
```

The dedup call (`getIssueComments`) is a straight mirror of `findOrCreateStageComment`'s existing pattern — same API, same response shape, same `body.includes(marker)` check. No new API surface on `GitHubClient`.

### The no-progress site (FR-007)

`phase-loop.ts:~278` (current):
```ts
if (lastTasksRemaining !== undefined && tasksRemaining >= lastTasksRemaining) {
  await labelManager.onError(phase);
  await stageCommentManager.updateStageComment({
    stage,
    status: 'error',
    phases: ...,
    startedAt: ...,
    prUrl: context.prUrl,           // ← NOTE: no errorEvidence
  });
  result.success = false;
  result.error = { message: 'Implement increment made no progress ...', stderr: '', phase };
  return { results, completed: false, lastPhase: phase, gateHit: false };
}
```

Post-fix: the `errorEvidence` argument is added by first setting `result.error` (so `buildErrorEvidence` has data to read), then computing evidence, then passing it to both `updateStageComment` and `postFailureAlert`:

```ts
if (lastTasksRemaining !== undefined && tasksRemaining >= lastTasksRemaining) {
  result.success = false;
  result.error = {
    message: 'Implement increment made no progress — aborting to prevent infinite loop',
    stderr: `no progress: tasks_remaining stayed at ${tasksRemaining} across two increments`,
    phase,
  };
  const evidence = this.buildErrorEvidence(phase, result);
  await labelManager.onError(phase);
  await stageCommentManager.updateStageComment({
    stage,
    status: 'error',
    phases: ...,
    startedAt: ...,
    prUrl: context.prUrl,
    errorEvidence: evidence,
  });
  await stageCommentManager.postFailureAlert({
    stage, runId, phase, command: `implement (no-progress guard)`, evidence,
  });
  return { results, completed: false, lastPhase: phase, gateHit: false };
}
```

The synthesized `stderr` string is short and descriptive — it names the guard that fired and the observation (`tasks_remaining` stuck), which is exactly the diagnostic the developer needs. It flows through `buildErrorEvidence` → `boundStderrTail` unchanged (well under 30 lines / 4 KiB), so no new rendering behavior.

### Terminal-vs-intermediate gating (FR-006)

The intermediate `implement`-retry path already lives inside the phase failure branch (`~331–351`). It calls `updateStageComment({ status: 'in_progress', ... })` on retry, NOT `updateStageComment({ status: 'error', ... })`. Since `postFailureAlert` is called only adjacent to `status: 'error'` updates, intermediate retries are silent *by construction* — no explicit gate needed. Test asserts this: a mocked failing→passing implement sequence must produce zero `postFailureAlert` calls.

Terminal `maxImplementRetries` exhaustion falls through to the main `status: 'error'` branch at line ~354, which gets both calls.

### Non-changes (deliberate)

- **Stage-comment body** — unchanged (FR-008). The `#847` evidence block continues to render in-place in the canonical comment. Cockpit `failed:*` classifier and existing `stage-comment-manager.test.ts` "happy path" byte-diff assertions are unaffected.
- **`PhaseResult`** — unchanged. Evidence stays a rendering-input concern.
- **`WorkerContext`** — unchanged. `runId` is a `PhaseLoop`-local variable, not part of the cross-method worker context.
- **`GitHubClient` interface** — unchanged. Reuses existing `getIssueComments` and `addIssueComment` methods.
- **No new Redis keys** — dedup is GitHub-side per Q2/A. Consistent with `#862`'s direction of travel away from `phase-tracker:*` history-keyed dedupe.
- **No new relay events / SSE frames** — the surface is the GitHub thread only.
- **No new HTML comment on success or gate transitions** — failure-only surface (Q5/C).

## Complexity Tracking

*Constitution Check passed; no violations.*

- 0 new production files (all changes fit into 3 existing files inside `packages/orchestrator/src/worker/`).
- 1 new public method on `StageCommentManager` (`postFailureAlert`).
- 1 new interface (`FailureAlertData` in `types.ts`) — plain object shape, not persisted, not on the wire.
- 1 new constant (`FAILURE_ALERT_MARKER_PREFIX` in `types.ts`) — used by both the manager (rendering) and future cockpit consumers (parsing).
- No new dependencies. No new schema-persisted state. No new relay changes.

## Risk / Rollback

- **Risk 1**: `getIssueComments` could paginate under a very long issue thread and miss a marker on a page beyond the fetch. **Mitigation**: this reuses the same API and same fetch shape as `findOrCreateStageComment`, which today assumes the current implementation returns all comments (verify against `GitHubClient.getIssueComments`); if pagination is an issue, it's a pre-existing bug and the fix applies to both call sites uniformly. If verification reveals a page limit, add a `TODO(#pagination)` in the same location `findOrCreateStageComment` uses. Not a blocker for `#865` because the failure path already lives on a mostly-fresh thread (developer engagement, not months of chatter).
- **Risk 2**: two concurrent workers racing on the same `runPhaseLoop` invocation could both scan-then-post and post two duplicate alerts. **Mitigation**: this is architecturally impossible per the assumption in the spec — one `runId` corresponds to one `runPhaseLoop` invocation, which is single-writer by design. A worker restart mints a new `runId`, so restart-then-race produces two *distinct* markers, which is the intended behavior (each `runId` gets its own alert).
- **Risk 3**: the summary line format (`❌ **<phase> failed** — \`<command>\` <exitDescriptor>.`) could be too long for email/mobile notification previews and get truncated mid-command. **Mitigation**: the pre-command prefix is ~35 bytes; the average failing command is ~60 bytes (`pnpm test && pnpm run build`); most preview windows keep the first ~120 bytes, so the exit descriptor is at risk on long commands. Acceptable because the phase name (the most important word) is at byte 0 of the summary; the developer can click through if the descriptor is truncated.
- **Risk 4**: cockpit UI or third parties could start relying on the marker format before it's cockpit-stable. **Mitigation**: the marker format is documented in `contracts/failure-alert-comment.md`; changes require an explicit contract-file edit. Cockpit changes are explicitly out of scope for this spec (Out of Scope section) and gated on a separate issue.
- **Rollback**: revert the 3 modified source files. Zero data migration, zero schema change, zero relay-payload change. Existing failure-alert comments remain on issues (they're plain GitHub comments); they render fine, they're just no longer refreshed. Their markers remain valid identifiers for post-hoc cockpit tooling that lands later.

---

*Generated by speckit — plan phase*

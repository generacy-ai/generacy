# Implementation Plan: Fresh single-package repos survive validate; failed phases post their evidence to the issue

**Feature**: Auto-degrade the monorepo-shaped `preValidateCommand` on non-monorepo repos, and append a bounded failure-evidence block (failing command + exit descriptor + stderr tail) to the stage comment on every `status: 'error'` transition.
**Branch**: `847-found-during-cockpit-v1`
**Date**: 2026-07-08
**Spec**: [spec.md](./spec.md)
**Clarifications**: [clarifications.md](./clarifications.md)
**Status**: Complete

## Summary

Two orthogonal gaps co-manifested on every fresh single-package project in the cockpit v1 smoke test.

**Gap A — preValidate kills single-package repos.**
`WorkerConfigSchema.preValidateCommand` (`packages/orchestrator/src/worker/config.ts:59`) defaults to `pnpm install && pnpm -r --filter './packages/*' build`. On a scaffolded Next.js / Astro / Vite repo (no `packages/` directory, no `pnpm-workspace.yaml`), the second half exits non-zero, `phase-loop.ts:161` records "Pre-validate install failed", and `runValidatePhase` never runs. The per-repo override in `.generacy/config.yaml` is honored (`applyRepoValidateOverrides`, `config.ts:98`) but staging-created projects arrive with a bare config — nothing populates it.

**Fix (Gap A)**: replace the string default with a **shell-level detection** — the command runs `pnpm install`, then runs the `pnpm -r --filter` half only when BOTH `pnpm-workspace.yaml` and at least one `packages/*/package.json` exist (per clarifications Q3→D). The two fs checks are inlined in the shell command so the CLI spawner path is untouched. Per-repo overrides continue to replace the whole string.

**Gap B — `failed:<phase>` posts no diagnostic evidence.**
`phase-loop.ts` calls `stageCommentManager.updateStageComment({ status: 'error', ... })` on failure. `StageCommentManager.renderStageComment` (`stage-comment-manager.ts:119`) renders the phase table and a `❌ Error` line but drops `PhaseResult.error.{message, stderr}` and `PhaseResult.exitCode` — the data is already captured in `cli-spawner.ts:247`, just never rendered. Developers reviewing the failed issue see only "validate ❌ error" and must `docker exec` into a worker container.

**Fix (Gap B)**: extend `StageCommentData` with an optional `errorEvidence?: { command, exitDescriptor, stderrTail }` field; thread `PhaseResult.error` + `result.exitCode` + the failing command string from the three `status: 'error'` sites in `phase-loop.ts` into it; render a fenced block appended after the phase table. Stderr tail is bounded per clarifications Q4→A (last 30 lines, then truncate-from-start to 4 KiB with a `… truncated (kept last N lines / M bytes) …` marker). Timeouts/aborts get a synthesized exit descriptor (`killed (SIGTERM) after Nms` / `aborted`) per Q5→A, and empty stderr renders as the literal `(stderr empty)`.

Both fixes are scoped to `packages/orchestrator/src/worker/` and one docs file. No new dependencies, no schema-persisted state, no relay changes. FR-009 (staging emits template-appropriate `orchestrator` blocks) is a companion `generacy-cloud` issue and is intentionally out of this PR.

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js ≥22 (per orchestrator package).
**Primary Dependencies**: `zod` (WorkerConfigSchema), `pino` (Logger), `vitest` for tests. Existing `PhaseResult.error` shape (`cli-spawner.ts:247`) is the sole upstream data source.
**Storage**: N/A — evidence is rendered into a GitHub comment via existing `StageCommentManager.updateStageComment`.
**Testing**: `vitest`. Affected suites:
- `packages/orchestrator/src/worker/__tests__/config.test.ts` — extend for the new default shape + degrade behavior on-disk fixtures.
- `packages/orchestrator/src/worker/__tests__/phase-loop.test.ts` — extend for evidence-block threading on each of the three `status: 'error'` sites.
- `packages/orchestrator/src/worker/__tests__/stage-comment-manager.test.ts` — new tests for evidence-block rendering, stderr-tail bounding, and truncation-marker text.
- One new pure-function test file `stderr-tail.test.ts` covering the 30-lines-then-4KiB bounding under adversarial input (SC-004).
**Target Platform**: Node worker inside cluster orchestrator container. Shell command executes inside the worker's `sh -c` layer via `CliSpawner.runPreValidateInstall`.
**Project Type**: Monorepo package (`packages/orchestrator`) with one docs touchpoint (`docs/docs/getting-started/configuration.md`).
**Performance Goals**: N/A. The two fs checks in the degrade command add a single-digit-ms `test -f` per validate phase — negligible against the 5-minute install timeout.
**Constraints**:
- Zero new dependencies.
- `PhaseResult` interface (types.ts:122) unchanged — evidence is threaded through `StageCommentData`, not `PhaseResult`.
- `applyRepoValidateOverrides` (`config.ts:98`) unchanged — the fix lives in the default *string*, and per-repo overrides continue to replace it wholesale.
- Explicit-empty `preValidateCommand` behavior (`config.ts:110-115`) preserved (means "skip install").
- Cockpit `failed:*` classifier reads the same stage comment surface — no new comments, no new HTML markers (per Q2→A).
- Rendered evidence block MUST be bounded ≤ 4 KiB per FR-004 / SC-004 — no path where a multi-MB stderr reaches `github.updateComment`.
**Scale/Scope**: 4 source files modified (`config.ts`, `phase-loop.ts`, `stage-comment-manager.ts`, `types.ts`), 1 new file (`stderr-tail.ts`), 3 test files modified/extended, 1 new test file, 1 docs file updated. ~120 LOC production, ~180 LOC tests.

## Constitution Check

*GATE: no constitution file at `.specify/memory/constitution.md`. Repository-wide invariants from `CLAUDE.md`, clarifications, and adjacent completed epics (#822, #841, #845):*

| Gate | Result | Note |
|------|--------|------|
| No premature abstractions / no half-finished implementations | PASS | Evidence rendering is one function on the existing `StageCommentManager`. The stderr-tail bounder is a single pure function used by exactly one caller. No plugin hooks, no config surfaces beyond the FR-004 bounds. |
| Match spec Q&A intent, not just the letter | PASS | Q1→A (keep `pnpm install`), Q2→A (same stage comment), Q3→D (both `pnpm-workspace.yaml` **and** `packages/*/package.json`), Q4→A with B's marker text (30 lines → 4 KiB → truncate-from-start), Q5→A (uniform full block for timeouts/aborts with synthesized descriptor and `(stderr empty)` literal) — all honored. |
| No backwards-compat shims for removed code | PASS | Nothing removed. The default string changes shape; per-repo overrides continue to work byte-identically. |
| Tests hit real behavior, not mocks-of-mocks | PASS | Config test writes real fixture directories (`packages/`, `pnpm-workspace.yaml`) and asserts on the resolved shell command string. `stage-comment-manager.test.ts` asserts on rendered markdown byte-strings. `stderr-tail.test.ts` fuzzes with 100 MB inputs (SC-004). |
| Structured logging conventions | PASS | No new log lines beyond the existing `Pre-validate install failed` (`phase-loop.ts:162`). Evidence rendering is a rendering concern, not a logging concern. |
| Don't add features beyond what the task requires | PASS | FR-009 (staging emits template-appropriate blocks) is explicitly out of scope and tracked as a companion cloud issue. No package-manager detection (npm/yarn/bun). No cockpit UI rendering changes. No new per-phase timeouts. |

Post-Phase-1 re-check: no violations introduced.

## Project Structure

### Documentation (this feature)

```text
specs/847-found-during-cockpit-v1/
├── spec.md              # (present, unchanged by /plan)
├── clarifications.md    # (present, unchanged by /plan)
├── plan.md              # THIS FILE
├── research.md          # Phase 0 output — decisions + rejected alternatives
├── data-model.md        # Phase 1 output — StageCommentData extension, evidence shape
├── quickstart.md        # Phase 1 output — repro Gap A, verify Gap B end-to-end
├── contracts/
│   ├── pre-validate-degrade.md   # Shell command contract + fs-check semantics (FR-001, FR-002)
│   └── failure-evidence-block.md # Stage-comment evidence rendering contract (FR-003, FR-004, FR-005, FR-007)
└── checklists/          # (empty)
```

### Source Code (repository root)

```text
packages/orchestrator/src/worker/
├── config.ts                        # MODIFIED — replace preValidateCommand default with degrade-aware shell command (FR-001, FR-002)
├── phase-loop.ts                    # MODIFIED — thread errorEvidence into 3 status:'error' updateStageComment sites (FR-003, FR-005)
├── stage-comment-manager.ts         # MODIFIED — extend renderStageComment to append evidence block on status:'error' only (FR-003, FR-007)
├── stderr-tail.ts                   # NEW — pure function: bound to last 30 lines then 4 KiB with marker (FR-004)
├── types.ts                         # MODIFIED — extend StageCommentData with optional errorEvidence field
└── __tests__/
    ├── config.test.ts               # MODIFIED — assert new default + fs-check behavior; regression on applyRepoValidateOverrides
    ├── phase-loop.test.ts           # MODIFIED — assert errorEvidence passed to updateStageComment on each error site
    ├── stage-comment-manager.test.ts # MODIFIED — assert evidence block rendering on error, absence on complete
    └── stderr-tail.test.ts          # NEW — adversarial 100 MB fuzz + boundary cases

docs/docs/getting-started/configuration.md   # MODIFIED — call out degrade behavior + per-repo override precedence (FR-008)
```

Out of repo (referenced only, not modified by this PR):

```text
generacy-cloud/…                     # FR-009 companion: staging emits template-appropriate .generacy/config.yaml orchestrator block
```

**Structure Decision**: Single-package modification inside `packages/orchestrator/src/worker/`. The evidence-block plumbing sits in the same 3-object triangle (`phase-loop.ts` → `stage-comment-manager.ts` → `types.ts`) that already renders the phase table. Splitting `stderr-tail.ts` into its own file is *not* a premature abstraction — it's the single test-boundary for SC-004 (adversarial 100 MB input), and it stays pure so the fuzz test runs at full speed without a fake worker.

## Design Overview

### Gap A — Degrade the default `preValidateCommand`

**Before** (`config.ts:59`):
```ts
preValidateCommand: z.string().default("pnpm install && pnpm -r --filter './packages/*' build"),
```

**After**:
```ts
preValidateCommand: z.string().default(
  "pnpm install && " +
  "if [ -f pnpm-workspace.yaml ] && ls packages/*/package.json >/dev/null 2>&1; then " +
    "pnpm -r --filter './packages/*' build; " +
  "fi"
),
```

- The `pnpm install` half **always** runs (Q1→A). Single-package repos still get `node_modules` for their own `pnpm test && pnpm build`.
- The `-r --filter` build half runs **only** when BOTH `pnpm-workspace.yaml` exists at the workspace root **AND** at least one `packages/*/package.json` exists (Q3→D). The `ls packages/*/package.json` glob returns non-zero on zero matches, which the surrounding `if` swallows — no failure signal escapes.
- The command runs as-is via `CliSpawner.runPreValidateInstall` (which already uses `sh -c` via `ShellIntent`, see `cli-spawner.ts:96, 126`). No changes to the spawner path.
- `applyRepoValidateOverrides` (`config.ts:98`) is unchanged. A per-repo `orchestrator.preValidateCommand` continues to replace the default wholesale. An explicit empty string continues to skip install (FR-002).

### Gap B — Failure evidence block in the stage comment

**Types (`types.ts`)** — extend `StageCommentData`:
```ts
export interface StageCommentData {
  // ... existing fields ...
  /** When status === 'error', evidence rendered inside the comment. Omitted on success. */
  errorEvidence?: {
    /** The failing command string (e.g., "pnpm install && pnpm -r …" or "npm test && npm run build") */
    command: string;
    /** Resolved exit descriptor: numeric exit code, `killed (SIGTERM) after Nms`, or `aborted` (FR-005, Q5→A) */
    exitDescriptor: string;
    /** Bounded stderr tail (already truncated per FR-004 by the caller). Literal `(stderr empty)` when empty. */
    stderrTail: string;
  };
}
```

**Phase-loop wiring (`phase-loop.ts`)** — three `status: 'error'` sites need to thread evidence:

1. Pre-validate install failure (line ~168) — command = `config.preValidateCommand`, error = `installResult.error`, exit = `installResult.exitCode`.
2. Unexpected spawn error catch (line ~217) — synthetic `errorEvidence` with `command = <phase name>`, exit = `aborted`, stderr = `String(error)`.
3. Post-phase failure sites (~336, ~373, ~394) — command comes from `phase === 'validate' ? config.validateCommand : <cli command line>`, error = `result.error`, exit = `result.exitCode`.

A private helper `buildErrorEvidence(phase, cmd, result)` on `phase-loop.ts` composes the `errorEvidence` object:
```ts
private buildErrorEvidence(
  command: string,
  result: PhaseResult,
): StageCommentData['errorEvidence'] {
  const exitDescriptor =
    result.error?.message.includes('timed out')  ? `killed (SIGTERM) after ${resolvedTimeoutMs}ms`
  : result.error?.message.includes('was aborted') ? 'aborted'
  : `exit ${result.exitCode}`;
  const stderrTail = boundStderrTail(result.error?.stderr ?? '');
  return { command, exitDescriptor, stderrTail };
}
```
The timeout/abort detection reads `result.error.message` (already tagged in `cli-spawner.ts:242–244`) rather than adding new fields to `PhaseResult` — the data is present, just needs a stable read path. For timeouts, `resolvedTimeoutMs` is available in scope at the phase-loop callsite (from `resolvePhaseTimeoutMs` or `DEFAULT_VALIDATE_TIMEOUT_MS`) — no need to re-derive.

**Bounding helper (`stderr-tail.ts`)** — pure function (Q4→A + B's marker):
```ts
export function boundStderrTail(raw: string): string {
  if (raw.length === 0) return '(stderr empty)';
  const lines = raw.split('\n');
  const last30 = lines.slice(-30).join('\n');
  const MAX = 4096;
  if (Buffer.byteLength(last30, 'utf-8') <= MAX) return last30;
  // Truncate from start, keep newest bytes
  const buf = Buffer.from(last30, 'utf-8');
  const trimmed = buf.subarray(buf.length - MAX).toString('utf-8');
  const keptLines = trimmed.split('\n').length;
  const marker = `… truncated (kept last ${keptLines} lines / ${MAX} bytes) …`;
  return `${marker}\n${trimmed}`;
}
```
- Byte-cap is applied on the last-30-lines slice (Q4→A ordering), not on raw stderr — this preserves line boundaries in the input.
- Truncation marker matches Q4's chosen wording with byte-and-line counts.
- Empty stderr returns `(stderr empty)` — the literal used by the renderer (Q5→A).

**Rendering (`stage-comment-manager.ts`)** — extend `renderStageComment`:
- After the existing `**PR**` line (line 152), if `data.status === 'error'` AND `data.errorEvidence` is set, append:
  ```
  ---
  **Failed command**: `<command>`
  **Exit**: <exitDescriptor>

  <details><summary>stderr (last <N> lines)</summary>

  ```text
  <stderrTail>
  ```

  </details>
  ```
- The `<details>` collapse keeps the comment visually compact when stderr is long. The fenced code block preserves newlines.
- No evidence block on `status: 'in_progress'` or `status: 'complete'` (FR-007 — successful phases unchanged).

### Non-changes (deliberate)

- **`PhaseResult`** — no new fields. Everything the block needs is already in `error.{message, stderr}` and `exitCode`. Adding a `timedOut`/`aborted` flag would duplicate signal that's already parseable from `error.message`.
- **`applyRepoValidateOverrides`** — the fix is in the default *string*, not the merge function. Per-repo `preValidateCommand` continues to override; an explicit empty string continues to skip.
- **Cockpit classifier surface** — same stage comment, same HTML marker, same `❌ Error` sentinel. Zero change required to `packages/cockpit` (FR-006).
- **No new relay events** — this is a GitHub-visible surface, not a cloud-relay one.
- **No new `PhaseResult.command`** — the command string is available at the phase-loop callsite (`config.validateCommand` / `config.preValidateCommand` / the resolved CLI phase). Threading it into `PhaseResult` would be a wider blast radius than the render needs.

## Complexity Tracking

*Constitution Check passed; no violations.*

- 1 new file (`stderr-tail.ts`) — justified by SC-004's 100 MB fuzz test needing a pure boundary.
- 1 new interface field (`StageCommentData.errorEvidence`) — optional, absent on happy path.
- No new dependencies. No new schema-persisted state. No new HTML markers. No relay changes.

## Risk / Rollback

- **Risk 1** (Gap A): a repo with `pnpm-workspace.yaml` but `packages/*/package.json` living under a nested workspace name (`apps/*`, `libs/*`) would NOT trigger the build half. **Mitigation**: this is intentional — the FR-001 requirement keys explicitly on `packages/*`, and monorepos with non-`packages/*` layouts already require a per-repo override (unchanged). SC-003 monorepo regression case uses the `packages/*` shape.
- **Risk 2** (Gap A): the shell command uses `ls packages/*/package.json >/dev/null 2>&1`, which under some restricted shells may behave differently. **Mitigation**: `sh -c` on all supported worker containers is `dash` or `bash` — `ls` + glob is portable. Verified against the cluster-base container's `/bin/sh`.
- **Risk 3** (Gap B): if `PhaseResult.error.message` wording ever changes in `cli-spawner.ts:240–244`, the timeout/abort detection breaks silently and every failure renders as `exit N`. **Mitigation**: a `stage-comment-manager.test.ts` case asserts specifically on the descriptor strings; a `cli-spawner.test.ts` case asserts on the exact `message` field; if either drifts, one of the two tests fails first.
- **Risk 4** (Gap B): the appended evidence block could push the stage comment past GitHub's 65 KiB comment cap when combined with a very long phase progress table. **Mitigation**: the 4 KiB stderr bound + fixed ~150-byte prelude keeps the block ≤ 4.5 KiB. The phase table is O(1) per phase (max 6 phases → ≤ 1 KiB). Total worst-case comment size: ≤ 6 KiB, well under GitHub's cap.
- **Rollback**: revert the 4 modified source files, remove `stderr-tail.ts`, revert the docs page. Zero data migration, zero schema change, zero relay-payload change. Existing stage comments are re-rendered on the next update.

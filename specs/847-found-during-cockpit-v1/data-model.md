# Data Model: preValidate degrade + failure evidence (#847)

This change adds **one new optional field** to an existing rendering-input interface and **no new persisted state**, no new relay payloads, no new schema-migration surface. The default value of a Zod field changes shape (string → longer string) — this is a value change, not a schema change; the `preValidateCommand` field remains `z.string()`.

## Modified type

### `StageCommentData.errorEvidence` (`packages/orchestrator/src/worker/types.ts`)

**New optional field** on the existing `StageCommentData` interface (line ~187):

```ts
export interface StageCommentData {
  stage: StageType;
  status: 'in_progress' | 'complete' | 'error';
  phases: {
    phase: WorkflowPhase;
    status: 'pending' | 'in_progress' | 'complete' | 'error';
    startedAt?: string;
    completedAt?: string;
  }[];
  startedAt: string;
  completedAt?: string;
  prUrl?: string;
  /**
   * Rendered inside the comment when status === 'error'. Omitted on
   * successful phases (FR-007). Populated by phase-loop.ts at each of the
   * three `updateStageComment({ status: 'error' })` call sites; consumed by
   * StageCommentManager.renderStageComment.
   */
  errorEvidence?: {
    /** The failing command string as it was passed to the spawner. */
    command: string;
    /** Resolved exit descriptor: `exit <N>`, `killed (SIGTERM) after <Nms>`, or `aborted` (FR-005, Q5→A). */
    exitDescriptor: string;
    /** Bounded stderr tail (last 30 lines → 4 KiB cap, truncation marker prepended when applicable). Literal `(stderr empty)` when empty. */
    stderrTail: string;
  };
}
```

**Contract**:
- MUST be set (all three sub-fields non-empty) whenever `status === 'error'`. Test coverage in `phase-loop.test.ts` at each of the three error sites.
- MUST NOT be set when `status === 'in_progress'` or `status === 'complete'` (FR-007). Renderer defensively ignores the field on non-error status.
- `stderrTail` is *already bounded* by the caller (via `boundStderrTail` in `stderr-tail.ts`). The renderer does NOT re-bound; it interpolates the string as-is inside a fenced code block.

## Unchanged types (referenced only)

### `PhaseResult` (`packages/orchestrator/src/worker/types.ts:122`)

**Deliberately unchanged.** All fields the evidence block needs are already present:

```ts
export interface PhaseResult {
  phase: WorkflowPhase;
  success: boolean;
  exitCode: number;         // → sourced for exit descriptor when NOT timeout/abort
  durationMs: number;
  output: OutputChunk[];
  sessionId?: string;
  gateHit?: { gateLabel: string; reason: string };
  error?: {
    message: string;        // → parsed for timeout/abort detection
    stderr: string;         // → passed to boundStderrTail
    phase: WorkflowPhase;
  };
  implementResult?: ImplementPartialResult;
}
```

- `error.message` string patterns are set in `cli-spawner.ts:240–244`:
  - Numeric-failure: `Phase "<phase>" failed with exit code <N>`
  - Timeout: `Phase "<phase>" timed out after <Nms>`
  - Abort: `Phase "<phase>" was aborted`
- These strings are the *sole* signal for the timeout/abort branch of `exitDescriptor`. `cli-spawner.test.ts` locks their exact wording; `stage-comment-manager.test.ts` locks the descriptor produced from them.

### `WorkerConfig.preValidateCommand` (`packages/orchestrator/src/worker/config.ts:59`)

**Field unchanged; default value changes.**

Before:
```ts
preValidateCommand: z.string().default("pnpm install && pnpm -r --filter './packages/*' build"),
```

After:
```ts
preValidateCommand: z.string().default(
  "pnpm install && " +
  "if [ -f pnpm-workspace.yaml ] && ls packages/*/package.json >/dev/null 2>&1; then " +
    "pnpm -r --filter './packages/*' build; " +
  "fi"
),
```

**Semantics** (behavioral, executed by `sh -c` inside `CliSpawner.runPreValidateInstall`):
1. Always run `pnpm install`. If it fails, the outer `&&` chain exits non-zero → FR-003 evidence block fires.
2. Then, iff BOTH conditions hold:
   - `[ -f pnpm-workspace.yaml ]` — regular file exists at the checkout root.
   - `ls packages/*/package.json >/dev/null 2>&1` — glob expands to ≥ 1 file.

   … run `pnpm -r --filter './packages/*' build`. If it fails, the `&&` inside the `if` exits non-zero → FR-003 evidence block fires (this is the intended monorepo failure surface, unchanged from today).
3. Otherwise, silently skip the build half. The pre-validate step exits 0 and `runValidatePhase` proceeds.

**Note on `applyRepoValidateOverrides`**: still applies wholesale replacement of the default when `.generacy/config.yaml` sets `orchestrator.preValidateCommand`. Explicit empty string → skip install entirely (unchanged, FR-002). This means a per-repo override can *opt out* of the degrade if the repo author wants a different install strategy.

## New pure-function boundary

### `boundStderrTail(raw: string): string` (`packages/orchestrator/src/worker/stderr-tail.ts`)

Pure function. Not a type; documented here because it defines the exact byte layout of `errorEvidence.stderrTail`.

**Signature**:
```ts
export function boundStderrTail(raw: string): string;
```

**Contract** (all covered in `stderr-tail.test.ts`):
- Empty input → returns literal `(stderr empty)`.
- Non-empty input ≤ 4096 bytes after taking last 30 lines → returned unchanged (no marker).
- Non-empty input > 4096 bytes after taking last 30 lines → returns:
  ```
  … truncated (kept last <N> lines / 4096 bytes) …
  <last 4096 bytes of last-30-lines slice>
  ```
  where `<N>` is the line count of the returned slice (after byte-cap, before the marker).
- MUST NOT emit the marker when no truncation occurred.
- MUST NOT split UTF-8 multi-byte sequences at the cut point (implementation MAY resync at the next `\n` boundary; test asserts the returned string decodes cleanly).
- MUST hold ≤ 4 KiB + marker (≈ 4200 bytes) on any input up to 100 MB (SC-004 fuzz).

## Label-pair / relay invariants (behavioral, unchanged)

- **Cockpit `failed:*` classification** — reads the same stage comment surface. The added block is inside the comment; the HTML marker (`STAGE_MARKERS[stage]`) and the `❌ Error` sentinel are byte-stable. No classifier change (FR-006).
- **PhaseResult sessionId propagation** — the fix does not touch session-id capture (`phase-loop.ts:242–246`). Resumed phases behave identically.
- **Job event emission** — no new events. `jobEventEmitter?.('job:phase_changed', …)` fires at the same moments.

## Side-effect ordering (behavioral)

Before this change, the `status: 'error'` code path in `phase-loop.ts` for pre-validate failure:
1. Log `Pre-validate install failed`.
2. `results.push(installResult)`.
3. `labelManager.onError(phase)`.
4. `stageCommentManager.updateStageComment({ status: 'error', phases, startedAt })`.
5. `return { results, completed: false, lastPhase: phase, gateHit: false }`.

After this change:
1. Log `Pre-validate install failed`.
2. `results.push(installResult)`.
3. `labelManager.onError(phase)`.
4. `stageCommentManager.updateStageComment({ status: 'error', phases, startedAt, errorEvidence: buildErrorEvidence(config.preValidateCommand, installResult) })`. **← new argument only**
5. `return { results, completed: false, lastPhase: phase, gateHit: false }`.

No new steps. No reordering. Same for the other two error sites (`~217`: unexpected spawn error catch; `~336/~373/~394`: post-phase failure sites) — each `updateStageComment({ status: 'error', … })` call gains an `errorEvidence` argument.

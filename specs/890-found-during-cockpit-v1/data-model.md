# Data Model: outputTail rename + merged capture (#890)

This change renames two internal type fields, replaces the shell-path stderr-only accumulator with a bounded ring buffer over merged stdout+stderr, and adds one pure function that synthesizes a tail from `OutputChunk[]`. **No new persisted state, no relay payloads, no schema-migration surface.**

## Renamed types

### `CommandExitEvidence.stderrTail` → `outputTail`

Location: `packages/orchestrator/src/worker/types.ts:237` (inside the `errorEvidence` discriminated-union first variant).

**Before**:
```ts
errorEvidence?:
  | {
      command: string;
      exitDescriptor: string;
      /** Bounded stderr tail (last 30 lines → 4 KiB cap, truncation marker prepended when applicable). Literal `(stderr empty)` when empty. */
      stderrTail: string;
    }
  | { mergeConflict: { … } };
```

**After**:
```ts
errorEvidence?:
  | {
      command: string;
      exitDescriptor: string;
      /**
       * Bounded merged tail — stdout and stderr chunks in Node `data`-event
       * arrival order (best-effort per FR-004, Q5→A). Last 30 lines then 4 KiB
       * cap, truncation marker prepended when applicable. Literal
       * `(no output on either stream)` when both streams were empty. Never
       * renders as `(empty)` when either stream produced any output (FR-003).
       *
       * Populated by phase-loop.ts via `buildErrorEvidence`, which:
       * - For shell phases (validate, pre-validate): reads `result.error.output`
       *   (the merged ring-buffer tail from manageProcess) and passes through
       *   `boundOutputTail`.
       * - For CLI phases: synthesizes from `result.output`'s `type: 'text'`
       *   chunks via `synthesizeOutputTail` (also bounder-capped).
       */
      outputTail: string;
    }
  | { mergeConflict: { … } };
```

**Contract**:
- MUST be set whenever `status === 'error'`. Test coverage inherited from #847 (`phase-loop.test.ts` at each of the 6 error sites), with every assertion updated from `.stderrTail` to `.outputTail`.
- MUST NOT be set when `status === 'in_progress'` or `status === 'complete'` (FR-007). Renderer defensively ignores the field on non-error status.
- MUST be a single string, ≤ 4 KiB after last-30-lines slicing. The renderer does NOT re-bound; it interpolates as-is inside a fenced code block.
- MUST NOT contain the substring `(empty)` when the process produced any output on either stream (SC-003 test scan).
- MUST equal literal `(no output on either stream)` when both streams were empty (FR-007 / Q2→A / SC-003).

**Derived type**: `CommandExitEvidence` (`types.ts:256`) uses `Extract<…, { command: string }>` — the extraction discriminator is `command`, not `stderrTail`, so the derived type name and shape update automatically when the field renames.

### `PhaseResult.error.stderr` → `output`

Location: `packages/orchestrator/src/worker/types.ts:155`.

**Before**:
```ts
error?: {
  message: string;
  stderr: string;
  phase: WorkflowPhase;
};
```

**After**:
```ts
error?: {
  message: string;
  /**
   * Merged stdout+stderr tail from the failed subprocess. Populated:
   * - Shell paths (runValidatePhase, runPreValidateInstall): populated from
   *   the ring buffer in manageProcess (bounded ~8 KiB, arrival-order
   *   best-effort per Q5→A).
   * - CLI paths (spawnPhase): empty string. Evidence is synthesized from
   *   `PhaseResult.output` (parsed `type: 'text'` chunks) at evidence-build
   *   time via `synthesizeOutputTail`.
   * - Synthesized results (no-progress guard, product-diff detection failure,
   *   empty-product-diff failure, unexpected-spawn catch): set by the caller
   *   to a controlled diagnostic string.
   */
  output: string;
  phase: WorkflowPhase;
};
```

**Contract**:
- Populated at process exit in `cli-spawner.ts` `manageProcess` (line ~249).
- For shell paths: `outputRing.toString('utf8')` — the last-8-KiB ring buffer contents.
- For CLI paths: empty string `''`. `PhaseResult.output` (the parsed `OutputChunk[]`) is the CLI-path diagnostic source.
- For synthesized `PhaseResult`s in phase-loop.ts (4 sites): the caller sets `output` directly to a controlled string. Those callers are updated to write `output:` instead of `stderr:` in the same object literal (mechanical rename).

## Unchanged types (referenced only)

### `PhaseResult` (`packages/orchestrator/src/worker/types.ts:134`)

**Deliberately unchanged.** The rename lands inside `error.{stderr → output}`. Every other field — including `PhaseResult.output: OutputChunk[]` — stays as-is. Overloading names between `error.output` (merged human text tail) and `output` (parsed transcript events) is intentional: `error.output` is under a discriminated `error` object; `output` is a peer. Reader clarity is preserved by the shape.

### `OutputChunk` (`packages/orchestrator/src/worker/types.ts:165`)

**Unchanged**. `synthesizeOutputTail` reads `chunk.type === 'text'` and `chunk.data.text` from the existing shape.

### `errorEvidence` second variant (`{ mergeConflict: … }`)

**Unchanged**. The rename only touches the `{ command, exitDescriptor, X }` variant.

## New pure-function boundary

### `boundOutputTail(raw: string): string` (`packages/orchestrator/src/worker/output-tail.ts`)

Renamed from `boundStderrTail`. Same file, same test suite (renamed to `output-tail.test.ts`).

**Signature**:
```ts
export function boundOutputTail(raw: string): string;
```

**Contract** (unchanged from `boundStderrTail` except the empty literal):
- Empty input → returns literal `(no output on either stream)`. **(Changed from `(stderr empty)`.)**
- Non-empty input ≤ 4096 bytes after taking last 30 lines → returned unchanged (no marker).
- Non-empty input > 4096 bytes after taking last 30 lines → returns:
  ```
  … truncated (kept last <N> lines / 4096 bytes) …
  <last 4096 bytes of last-30-lines slice>
  ```
  where `<N>` is the line count of the returned slice (after byte-cap, before the marker).
- MUST NOT emit the marker when no truncation occurred.
- MUST hold ≤ 4 KiB + marker (≈ 4200 bytes) on any input up to 100 MB (SC-002).

### `synthesizeOutputTail(chunks: OutputChunk[]): string` (`packages/orchestrator/src/worker/output-tail-synthesis.ts`)

**Signature**:
```ts
export function synthesizeOutputTail(chunks: OutputChunk[]): string;
```

**Contract** (covered in `output-tail-synthesis.test.ts`):
- Reads only `chunks` whose `type === 'text'`.
- For each such chunk, reads `chunk.data.text` iff it is a string; otherwise skips.
- Joins collected texts with a single `'\n'` separator, preserving stored order.
- Passes the joined string through `boundOutputTail` before returning.
- Empty `chunks` array → returns `(no output on either stream)` (delegated to bounder).
- Non-text chunks (`init`, `tool_use`, `tool_result`, `complete`, `error`) → excluded entirely. No stringification of their `data` payload — those payloads are event JSON and would clutter the tail without diagnostic value.
- MUST hold ≤ 4 KiB + marker on any transcript size (delegates to `boundOutputTail`).

**Rationale for the split from `boundOutputTail`**:
- The bounder operates on `string` and has an existing adversarial-input fuzz test.
- The synthesizer operates on `OutputChunk[]` and has its own test surface (chunk-type filtering, missing `data.text` handling).
- Combining them into one function would require a mode flag, which is a smell.

## Ring buffer contract (`packages/orchestrator/src/worker/cli-spawner.ts`)

**Location**: inside `manageProcess`, replacing the no-op stdout listener at line ~167. The ring is a **local variable** (`let outputRing: Buffer`); it is not a class field, not a helper class — it lives for the duration of one spawn.

**Constants**:
- `RING_BYTES = 8192` — 8 KiB pre-cap ring capacity.

**Contract**:
- Attached only when `capture === undefined` (shell paths). Claude-CLI paths are unaffected.
- On each `data` event from stdout OR stderr, append the chunk (as `Buffer`) to the ring; if `ring.length > RING_BYTES`, slice from `ring.length - RING_BYTES`. `Buffer.concat` + `Buffer.subarray` (no allocation-heavy string manipulation).
- Stdout and stderr **share the same ring** — chunks are interleaved in the order Node's `data` events deliver them (FR-004 arrival-order best-effort per Q5→A).
- At process exit, `outputRing.toString('utf8')` is written to `result.error.output`. If truncation happened at the ring boundary, a UTF-8 code unit MAY be split — the subsequent `boundOutputTail` last-30-lines slice trims the leading (potentially garbled) partial line anyway, so no explicit resync is needed.
- Memory ceiling: ≤ 8 KiB per active spawn. One active spawn per worker → total added RSS ≤ 8 KiB. No leak across spawns (the ring is a closed-over local).

**Non-goals** of the ring:
- No chunk boundaries preserved (bytes only).
- No per-chunk timestamps.
- No stream-of-origin tagging (a byte in the ring doesn't remember whether it came from stdout or stderr).
- No content-type awareness (bytes are bytes).

## Renderer invariants (both call sites in `stage-comment-manager.ts`)

**Affected sites**:
1. `appendEvidenceBlock` at line 193 — used inside `renderStageComment` for the on-status:error stage-comment update.
2. `renderFailureAlert` at line 295 — used inside `postFailureAlert` for the bottom-of-thread failure alert (#865).

**Both sites**:
- Read `evidence.outputTail` (was `evidence.stderrTail`).
- Compute `lineCount = evidence.outputTail.split('\n').length` (unchanged logic; new field name).
- Apply the same triple-backtick ZWSP substitution: `evidence.outputTail.replace(/```/g, '`​``')` (unchanged; new field name).
- Emit `<details><summary>output (last N lines)</summary>` (was `<summary>stderr (last N lines)</summary>`).
- Interior fenced block unchanged: ` ```text\n<safeOutput>\n``` `.

**Invariants**:
1. Bytes above the horizontal-rule separator (`---`) MUST render byte-identical to the pre-fix output. Only the two lines that were `<summary>stderr (last N lines)</summary>` change to `<summary>output (last N lines)</summary>`. Below the summary, the fenced block content is whatever `outputTail` contains.
2. On `status: 'complete'` or `status: 'in_progress'`, no evidence block appears. Renderer defensively ignores `errorEvidence` on non-error status (inherited from #847).
3. Both empty streams → the fenced block contains the literal `(no output on either stream)`. No secondary block. No `(empty)` marker.
4. The `<details>` collapse MUST render on GitHub without escaping. Adversarial triple-backtick sequences in `outputTail` are still neutralized by the ZWSP substitution.

## Cockpit-classifier invariance

The cockpit `failed:*` classifier reads the stage comment via GitHub API and detects the error state from the `❌ Error` status line. Post-fix:

- The `**Status**: ❌ Error` line is byte-identical to pre-fix.
- The classifier does not read the `<details>` block body today; the summary rename (`stderr` → `output`) is invisible to it.
- No cockpit changes needed (regression asserted by the unchanged `packages/cockpit/**/__tests__/*.test.ts` suite).

## Side-effect ordering (behavioral)

**Shell path (`runValidatePhase`, `runPreValidateInstall`)** — no reordering, only the ring buffer is added at the `data` listener attachment step:

1. `child.stdout.on('data', appendRing)` (new — replaces the no-op).
2. `child.stderr.on('data', appendRing)` (new — was `stderrBuffer +=`).
3. Timeout timer, abort signal, exit wait — unchanged.
4. `result.error = { message, output: outputRing.toString('utf8'), phase }` (was `stderr: stderrBuffer`).

**CLI path (`spawnPhase`)** — no code change to `manageProcess` for this path. `capture.processChunk` remains the sole stdout consumer; stderr's `data` listener still writes to a local buffer (the non-`capture` branch of the stderr listener is now inert / not applicable). `result.error.output = ''` on failure — the diagnostic surface is `PhaseResult.output` (the retained `OutputChunk[]`).

## Test-suite touchpoints

| Test file | Change type | What changes |
|-----------|-------------|--------------|
| `stderr-tail.test.ts` → `output-tail.test.ts` | RENAMED | Function-name assertion (`boundStderrTail` → `boundOutputTail`); empty-input assertion (`(stderr empty)` → `(no output on either stream)`). Fuzz cases unchanged. |
| `phase-loop.test.ts` | MODIFIED | Every `.stderrTail` field assertion → `.outputTail`; every `error: { stderr: … }` synthetic → `error: { output: … }`. New fixture: CLI-phase failure with `output: [{ type: 'text', data: { text: '…' } }]` chunks + `error.output: ''` → asserts synthesized outputTail contains the joined text. |
| `stage-comment-manager.test.ts` | MODIFIED | Every `.stderrTail` fixture field → `.outputTail`; every `stderr (last` string assertion → `output (last`. New both-empty fixture: `outputTail: '(no output on either stream)'` → renders under one shared summary. Backtick-poisoned fixture assertion unchanged. |
| `cli-spawner.test.ts` | MODIFIED | New fixture: `sh -c 'echo "stdout content"; exit 1'` via a real `runValidatePhase` → asserts `result.error.output` contains `stdout content` and `result.error.stderr` no longer exists. |
| `output-tail-synthesis.test.ts` | NEW | Coverage per synthesizer contract above: text-chunk join order, non-text chunks skipped, missing `data.text` skipped, empty input → `(no output on either stream)`, byte-cap delegated. |

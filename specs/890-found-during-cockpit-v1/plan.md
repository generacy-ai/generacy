# Implementation Plan: Evidence block captures stdout alongside stderr

**Feature**: Widen the failure-evidence tail from stderr-only to a single interleaved stdout+stderr capture so Node-toolchain failures (Next.js `next build`, vitest, npm) — which write most detail to **stdout** — actually appear in the alert. Rename `stderrTail` → `outputTail` internally, add a bounded ring buffer at the shell-path spawn site, and synthesize the CLI-phase tail from existing `type: 'text'` output chunks.
**Branch**: `890-found-during-cockpit-v1`
**Date**: 2026-07-09
**Spec**: [spec.md](./spec.md)
**Clarifications**: [clarifications.md](./clarifications.md)
**Status**: Complete

## Summary

Follow-up to #847 (evidence-block introduction) and #865 (failure-alert composer). The observed defect: `christrudelpw/sniplink#6/#7/#8` all failed validate with alerts reading `stderr: (empty)` while the real error (`next build`'s `Type error: Cannot find module '@/components/CopyButton'`) sat on stdout. Every mainstream Node toolchain — Next.js, vitest, npm — writes most failure detail to stdout, so `boundStderrTail(PhaseResult.error.stderr)` empties out on the most common failure shape. The evidence surface that #847 built to prevent `docker exec`-to-diagnose fails on its most common case.

**Two intertwined gaps, both fixed here:**

**Gap A — shell paths discard stdout.** `CliSpawner.runValidatePhase` and `runPreValidateInstall` (`cli-spawner.ts:104,134`) pass `undefined` for `OutputCapture`, and `manageProcess` (`cli-spawner.ts:167`) attaches a no-op stdout listener that drops every chunk on the floor. The spec's original assumption ("chunks are stored in `PhaseResult.output`") is **wrong** for exactly the case that motivates the bug — `PhaseResult.output` is empty for shell phases because `capture` is `undefined`.

**Fix (Gap A)**: attach a bounded ring buffer (~8 KiB, `Buffer.concat`+slice-tail idiom) that accumulates both stdout and stderr chunks **in arrival order** into a single string (per clarifications Q1→A: single interleaved tail; Q5→A: arrival-order best-effort). At exit, populate `PhaseResult.error.output` from the ring. Memory cost is O(1) regardless of total output volume.

**Gap B — Claude-CLI paths have JSON transcripts, not human text.** `spawnPhase` pipes stdout through `OutputCapture`, which parses each newline-delimited JSON event into `OutputChunk[]` and retains it in `PhaseResult.output`. The **raw bytes** are consumed by the JSON parser and never retained — but the parsed `type: 'text'` chunks carry the human-readable text the model emitted. On CLI phase failure, an operator's diagnostic surface is that stream.

**Fix (Gap B)**: `buildErrorEvidence` synthesizes the tail for CLI phases from `PhaseResult.output` by joining the `data.text` of every chunk with `type === 'text'`, in stored order, then running the same `boundOutputTail` bounder. No duplicate raw buffering; no multi-MB JSON transcript held in RAM.

**Rename**: `CommandExitEvidence.stderrTail` → `outputTail`, `PhaseResult.error.stderr` → `output`, `boundStderrTail` → `boundOutputTail`, empty literal `(stderr empty)` → `(no output on either stream)`. Renderers (`stage-comment-manager.ts:appendEvidenceBlock`, `renderFailureAlert`) render the block under `<summary>output (last N lines)</summary>`. Both surfaces (#847 stage-comment block, #865 bottom-of-thread alert) update in lockstep.

Scoped entirely to `packages/orchestrator/src/worker/`. No new dependencies. No schema-persisted state. No relay-payload change. No cockpit-classifier change. No changes above the horizontal-rule separator in the rendered stage comment.

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js ≥22 (per orchestrator package).
**Primary Dependencies**: `node:buffer` (for byte-length + subarray in the ring buffer and the bounder), `pino` (Logger), `vitest` for tests. Zero new runtime deps.
**Storage**: N/A — evidence is rendered into a GitHub comment via existing `StageCommentManager.updateStageComment` + `StageCommentManager.postFailureAlert`. No persistence layer touched.
**Testing**: `vitest`. Affected suites:
- `packages/orchestrator/src/worker/__tests__/stderr-tail.test.ts` — renamed to `output-tail.test.ts`; fuzz/boundary suite for `boundOutputTail`. Empty-input assertion updated to `(no output on either stream)`.
- `packages/orchestrator/src/worker/__tests__/phase-loop.test.ts` — every fixture asserting `errorCall.errorEvidence.stderrTail` rewrites to `.outputTail`. New coverage: stdout-only failure (SC-001 fixture, Next.js `Type error:` synthetic).
- `packages/orchestrator/src/worker/__tests__/stage-comment-manager.test.ts` — every fixture asserting on the rendered `stderr (last N lines)` summary rewrites to `output (last N lines)`; new fixture asserts the both-empty case renders `(no output on either stream)` (not `(empty)`).
- `packages/orchestrator/src/worker/__tests__/cli-spawner.test.ts` — new fixture: shell path with stdout-only output → resulting `PhaseResult.error.output` contains that stdout tail (SC-004 reproduction).
- One new pure-function test file `output-tail-synthesis.test.ts` covering CLI-phase tail synthesis from `OutputChunk[]` (`type === 'text'` chunk joining, bounder application).
**Target Platform**: Node worker inside cluster orchestrator container. Shell command executes inside the worker's `sh -c` layer via `CliSpawner.runValidatePhase` / `runPreValidateInstall`.
**Project Type**: Monorepo package (`packages/orchestrator`) modification. No cross-package impact.
**Performance Goals**: The ring buffer stays O(1) in memory regardless of output volume — a fixed 8192-byte `Buffer` slice-tail on each `data` event. CPU cost is one `Buffer.concat`+`subarray` per chunk (~micro-µs). CLI-phase tail synthesis walks `PhaseResult.output` once at exit (O(N) chunks) and delegates the byte cap to the same bounder.
**Constraints**:
- Zero new dependencies.
- Total evidence-block bytes MUST stay within the #847 4 KiB bound after last-30-lines slicing (FR-002). One string, one cap — no inter-stream allocation.
- Ring buffer memory ceiling: 8 KiB per active spawn, one at a time per worker. Total added RSS: negligible.
- `CommandExitEvidence` type shape stays a `{ command, exitDescriptor, X }` triple; only the third field name changes. Discriminated-union tag remains `command: string` (the merge-conflict variant is untouched).
- The two `<details>` renderers (`appendEvidenceBlock` at `stage-comment-manager.ts:193`; `renderFailureAlert` at `stage-comment-manager.ts:295`) MUST update in lockstep — a rename in one but not the other leaves one surface saying "stderr" and the other saying "output".
- `PhaseResult.output` (`OutputChunk[]`) is deliberately NOT renamed. It's the parsed-JSON transcript surface, semantically distinct from `error.output` (the human-readable merged tail); overloading the name would confuse readers.
- Existing test snapshots that lock the exact rendered markdown (there are several inline `.toContain('stderr (last')` assertions) MUST be updated in the same change — this is an internal rename, not backwards-compatible aliasing.
**Scale/Scope**: 5 source files modified (`cli-spawner.ts`, `stderr-tail.ts` → `output-tail.ts`, `phase-loop.ts`, `stage-comment-manager.ts`, `types.ts`), 1 new file (`output-tail-synthesis.ts` — pure joiner for `OutputChunk[]`), 4 test files updated/extended, 1 new test file. ~120 LOC production, ~200 LOC tests.

## Constitution Check

*GATE: no constitution file at `.specify/memory/constitution.md`. Repository-wide invariants sourced from `CLAUDE.md`, this spec's clarifications, and the two directly-adjacent completed epics (#847, #865):*

| Gate | Result | Note |
|------|--------|------|
| No premature abstractions / no half-finished implementations | PASS | One new file (`output-tail-synthesis.ts`) — the pure joiner from `OutputChunk[]` — separated only because it has its own test-boundary distinct from the byte-cap bounder. Ring buffer is inline in `manageProcess`; no separate ring class introduced. No new plugin hooks, no config surface. |
| Match spec Q&A intent, not just the letter | PASS | Q1→A (single interleaved tail, rename to `outputTail`), Q2→A (omit empty stream entirely; both-empty case renders `(no output on either stream)`), Q3→C (shell paths ring-buffered; CLI paths synthesize from `type: 'text'` chunks), Q4→N/A (one string, one cap), Q5→A (arrival-order best-effort, no timestamps, no PTY). All five decisions honored. |
| No backwards-compat shims for removed code | PASS | The rename is a coordinated internal edit. No aliasing `stderrTail`, no dual-write of both fields, no removed-comment stubs. Every reader is updated in the same change; the type is internal to `packages/orchestrator/src/worker/`. |
| Tests hit real behavior, not mocks-of-mocks | PASS | The `cli-spawner.test.ts` addition drives a real `sh -c 'echo …; exit 1'` subprocess and asserts on the resulting `PhaseResult.error.output` string. The bounder test drives 100 MB fuzz inputs. The renderer tests assert on exact rendered markdown byte-strings. |
| Structured logging conventions | PASS | No new log lines. The existing `Phase process exited` / `Pre-validate install failed` log lines are unchanged. The ring-buffer is silent by design. |
| Don't add features beyond what the task requires | PASS | Structured error-parsing (extracting `Type error:` specifically), streaming/live-tail, ANSI stripping, PTY-backed capture, per-line stream prefixes, and non-command-exit failure paths (merge-conflict variant) are all explicitly out of scope per the spec. This PR widens the capture surface only. |

Post-Phase-1 re-check: no violations introduced.

## Project Structure

### Documentation (this feature)

```text
specs/890-found-during-cockpit-v1/
├── spec.md              # (present, unchanged by /plan)
├── clarifications.md    # (present, unchanged by /plan)
├── plan.md              # THIS FILE
├── research.md          # Phase 0 output — decisions + rejected alternatives (rename rationale, ring vs. array, CLI synthesis)
├── data-model.md        # Phase 1 output — CommandExitEvidence rename, PhaseResult.error.output rename, ring buffer contract
├── quickstart.md        # Phase 1 output — repro the stdout-only failure, verify the alert now carries the error text
├── contracts/
│   └── output-tail-evidence-block.md  # Updated rendering contract: single output block, empty-both wording, byte layout
└── checklists/          # (empty)
```

### Source Code (repository root)

```text
packages/orchestrator/src/worker/
├── cli-spawner.ts                    # MODIFIED — replace no-op stdout listener with ring buffer (FR-005 shell path); populate result.error.output from ring; interleave stderr into the same ring
├── stderr-tail.ts → output-tail.ts   # RENAMED + MODIFIED — export `boundOutputTail`; empty-input literal changes to `(no output on either stream)`; add-a-marker semantics unchanged (FR-002)
├── output-tail-synthesis.ts          # NEW — pure function: `synthesizeOutputTail(chunks: OutputChunk[]): string`. Joins `type: 'text'` chunks' `data.text` in stored order, feeds through `boundOutputTail`. Used by CLI-phase branch of buildErrorEvidence (FR-005 CLI path).
├── phase-loop.ts                     # MODIFIED — `buildErrorEvidence` splits on `result.output.length === 0` (shell path uses `result.error?.output`) vs. CLI path (synthesizes from `result.output`); rename field to `outputTail`. All 6 buildErrorEvidence call sites unchanged (they pass `command` + `result`, no per-site logic change).
├── stage-comment-manager.ts          # MODIFIED — `appendEvidenceBlock` and `renderFailureAlert` both change `stderr` → `output` in the `<summary>` text, read `evidence.outputTail` (was `stderrTail`). ZWSP substitution unchanged.
├── types.ts                          # MODIFIED — `CommandExitEvidence.stderrTail` → `outputTail`; `PhaseResult.error.stderr` → `output`; JSDoc updated to describe the merged nature; `CommandExitEvidence` derivation type unchanged (Extract still keys on `command`).
└── __tests__/
    ├── stderr-tail.test.ts → output-tail.test.ts   # RENAMED — assertions updated for the new empty literal and function name; boundary/fuzz cases unchanged
    ├── output-tail-synthesis.test.ts               # NEW — text-chunk joining, non-text chunks skipped, empty chunks list → empty string (bounder handles the empty literal), byte-cap delegated to boundOutputTail
    ├── cli-spawner.test.ts                         # MODIFIED — new fixture: shell subprocess writes only to stdout, exits 1 → PhaseResult.error.output contains that stdout (SC-004 reproduction against real spawn)
    ├── phase-loop.test.ts                          # MODIFIED — every `.stderrTail` assertion → `.outputTail`; new fixture: CLI-phase synthetic result with `type: 'text'` chunks + no `error.output` → outputTail contains the joined text
    └── stage-comment-manager.test.ts               # MODIFIED — every `.stderrTail` fixture field → `.outputTail`; summary assertions `stderr (last` → `output (last`; new both-empty fixture asserts `(no output on either stream)` (not `(empty)`)
```

**Structure Decision**: Single-package modification inside `packages/orchestrator/src/worker/`. The change touches exactly the three-object triangle #847 introduced (`phase-loop.ts` → `stage-comment-manager.ts` → `types.ts`) plus the spawner (`cli-spawner.ts`) where the ring buffer lives. Splitting `output-tail-synthesis.ts` from `output-tail.ts` is not a premature abstraction — they test independently and one operates on `OutputChunk[]` while the other operates on `string`, so combining them would just add a mode flag. Inlining the 6-line ring buffer inside `manageProcess` (vs. a separate `RingBuffer` class) is deliberate: it's used in exactly one place and adds no test surface beyond the spawner integration test.

## Design Overview

### Type rename (Phase 1)

`packages/orchestrator/src/worker/types.ts`:

```ts
// Before
error?: {
  message: string;
  stderr: string;       // ← renamed
  phase: WorkflowPhase;
};

// After
error?: {
  message: string;
  /**
   * Merged interleaved stdout+stderr tail from the failed process (shell paths),
   * OR empty for CLI phases (which synthesize the tail from `output: OutputChunk[]` at
   * evidence-build time via `synthesizeOutputTail`). Ring-buffer bounded (~8 KiB) at
   * capture time in `manageProcess`.
   */
  output: string;
  phase: WorkflowPhase;
};
```

```ts
// Before
errorEvidence?:
  | {
      command: string;
      exitDescriptor: string;
      stderrTail: string;   // ← renamed
    }
  | { mergeConflict: { … } };

// After
errorEvidence?:
  | {
      command: string;
      exitDescriptor: string;
      /**
       * Merged stdout+stderr tail (arrival-order best-effort). Bounded to
       * ≤ 4 KiB via boundOutputTail. Literal `(no output on either stream)`
       * when both streams were empty. Never rendered as `(empty)` when either
       * stream produced any output (FR-003).
       */
      outputTail: string;
    }
  | { mergeConflict: { … } };
```

The `CommandExitEvidence` derived type (line 256) still extracts on the `command: string` shape — the rename doesn't affect the discriminator.

### Shell path: ring buffer at `manageProcess` (Gap A fix)

`packages/orchestrator/src/worker/cli-spawner.ts`, replacing the no-op stdout listener at line ~167:

```ts
// ---- Merged stdout+stderr ring buffer (shell paths only) ----
// Populated when capture is undefined. Chunks are appended in Node
// `data`-event arrival order (best-effort per FR-004, Q5→A) into one Buffer.
// The buffer holds at most RING_BYTES = 8192 bytes — older bytes are sliced off.
const RING_BYTES = 8192;
let outputRing = Buffer.alloc(0);
const appendRing = (data: Buffer | string): void => {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  outputRing = Buffer.concat([outputRing, buf]);
  if (outputRing.length > RING_BYTES) {
    outputRing = outputRing.subarray(outputRing.length - RING_BYTES);
  }
};

// ---- stdout ----
if (child.stdout && capture) {
  child.stdout.on('data', (data: Buffer | string) => {
    capture.processChunk(typeof data === 'string' ? data : data.toString('utf-8'));
  });
}
if (child.stdout && !capture) {
  child.stdout.on('data', appendRing);   // ← was: no-op listener
}

// ---- stderr ----
if (child.stderr) {
  child.stderr.on('data', (data: Buffer | string) => {
    if (!capture) {
      appendRing(data);                    // ← shell path: interleave into ring
    } else {
      // CLI path: no ring; stderr tail is not populated for CLI phases.
      // Their diagnostic surface is `PhaseResult.output` (parsed JSON events),
      // from which `buildErrorEvidence` synthesizes `outputTail` via
      // `synthesizeOutputTail` at evidence-build time.
    }
  });
}
```

At exit, when populating `result.error`:

```ts
result.error = {
  message,
  output: capture ? '' : outputRing.toString('utf8'),  // ← was: `stderr: stderrBuffer`
  phase,
};
```

The stderr-only accumulator (`stderrBuffer`) is deleted. CLI phases carry `output: ''` on the error record because their diagnostic surface is `PhaseResult.output` (the parsed `OutputChunk[]`), which `synthesizeOutputTail` consumes at evidence-build time.

### CLI path: synthesize from `type: 'text'` chunks (Gap B fix)

`packages/orchestrator/src/worker/output-tail-synthesis.ts` (new file):

```ts
import type { OutputChunk } from './types.js';
import { boundOutputTail } from './output-tail.js';

/**
 * Synthesize a bounded output tail for a CLI phase's PhaseResult from its
 * parsed OutputChunk[] transcript.
 *
 * Joins the `data.text` string of every chunk with `type === 'text'` in stored
 * order (Claude CLI emits these in write order via `processChunk`), separated
 * by newlines, then feeds through `boundOutputTail` for the 4 KiB cap.
 *
 * Non-text chunks (`init`, `tool_use`, `tool_result`, `complete`, `error`) are
 * skipped — their content is either structural or already-summarized event JSON,
 * which would clutter the tail without adding diagnostic value.
 */
export function synthesizeOutputTail(chunks: OutputChunk[]): string {
  const texts: string[] = [];
  for (const chunk of chunks) {
    if (chunk.type !== 'text') continue;
    const data = chunk.data as { text?: unknown } | null | undefined;
    if (data && typeof data.text === 'string') texts.push(data.text);
  }
  return boundOutputTail(texts.join('\n'));
}
```

### `buildErrorEvidence` becomes shape-aware

`packages/orchestrator/src/worker/phase-loop.ts`, replacing the current implementation at line ~842:

```ts
private buildErrorEvidence(
  command: string,
  result: PhaseResult,
  resolvedTimeoutMs?: number,
): CommandExitEvidence {
  const message = result.error?.message ?? '';
  const exitDescriptor =
    message.includes('timed out') && resolvedTimeoutMs !== undefined
      ? `killed (SIGTERM) after ${resolvedTimeoutMs}ms`
      : message.includes('was aborted')
      ? 'aborted'
      : `exit ${result.exitCode}`;

  // Shell path (validate/pre-validate): `error.output` is already the merged
  // ring-buffer tail from manageProcess. CLI path: `error.output` is empty;
  // synthesize the tail from the retained `type: 'text'` chunks in output[].
  // For synthetic PhaseResults (no-progress guard, product-diff failures, catch
  // block): `error.output` is set directly by the caller (still merged-shape).
  const rawOutput = result.error?.output ?? '';
  const outputTail = rawOutput.length > 0
    ? boundOutputTail(rawOutput)
    : synthesizeOutputTail(result.output);

  return { command, exitDescriptor, outputTail };
}
```

All 6 existing call sites (`phase-loop.ts:220, 300, 355, 430, 482, 512`) are unchanged — they already pass `command` + `result`. The 4 sites that synthesize a `PhaseResult` (unexpected-spawn catch at ~298, no-progress guard at ~350, product-diff detection failure at ~477, empty-product-diff at ~504) write the diagnostic string into `error.output` instead of `error.stderr` — a mechanical rename inside the same object literal. Same for `cli-spawner.ts:249`.

### `boundOutputTail` (renamed bounder)

`packages/orchestrator/src/worker/output-tail.ts` — `boundStderrTail` renamed to `boundOutputTail`. The only functional change is the empty-input literal:

```ts
const EMPTY_LITERAL = '(no output on either stream)';   // ← was: '(stderr empty)'
```

Truncation-marker text, 4 KiB cap, last-30-lines slicing rule — all unchanged.

### Renderer updates

`packages/orchestrator/src/worker/stage-comment-manager.ts:193` (`appendEvidenceBlock`) and `stage-comment-manager.ts:295` (`renderFailureAlert`): both change `stderrTail` field reads to `outputTail` and update the `<summary>` copy from `stderr (last N lines)` → `output (last N lines)`. The ZWSP triple-backtick substitution is unchanged. Line count computation (`.split('\n').length`) is unchanged.

For the both-empty case (FR-007 / Q2→A), the renderer still emits the `<details>` block — the body just contains the literal `(no output on either stream)` instead of a code snippet. This is a single marker inside one shared header, not two "empty" markers.

### Non-changes (deliberate)

- **`PhaseResult.output: OutputChunk[]`** — untouched. This is the parsed-transcript surface used by cockpit/SSE renderers and stays semantically distinct from `error.output`.
- **6 `buildErrorEvidence` call sites in `phase-loop.ts`** — the helper's signature is unchanged (`command`, `result`, optional `resolvedTimeoutMs`). Sites don't know or care about the shell/CLI split.
- **`OutputCapture`** — the Claude-CLI stdout parser is unchanged. It already retains `type: 'text'` chunks (`output-capture.ts:135, 151`). The synthesis reads what's already there.
- **Merge-conflict evidence variant (#864)** — the discriminated-union second variant (`{ mergeConflict: … }`) is untouched. Only the `command`-variant's third field renames.
- **Cockpit `failed:*` classifier** — reads the stage comment via GitHub API. The `❌ Error` sentinel and HTML markers are byte-stable. The renamed `<summary>output (last N lines)</summary>` inside the `<details>` block is invisible to the classifier.
- **Ring buffer size (8 KiB)** — deliberately larger than the 4 KiB post-cap bound. The pre-cap ring captures more raw bytes than we render, so `boundOutputTail`'s last-30-lines slicing has real data to work with (a 4 KiB ring holding the last 4096 bytes might not span 30 lines if lines are long; 8 KiB gives comfortable headroom).
- **Arrival-order fidelity (Q5→A)** — no `performance.now()` timestamps on chunks. Node's `data` event ordering across two streams is best-effort; the spec accepts this and documents it as approximate. Chasing chronological fidelity via PTY (Q5→C) or high-res timestamps (Q5→B) is out of proportion to a log tail.

## Complexity Tracking

*Constitution Check passed; no violations.*

- 1 new file (`output-tail-synthesis.ts`) — justified by its own test surface (pure joiner over `OutputChunk[]`) and its testable independence from the byte-cap bounder.
- 1 renamed file (`stderr-tail.ts` → `output-tail.ts`) — the rename tracks the internal type field rename, not backwards-compatible aliasing.
- 1 renamed interface field (`stderrTail` → `outputTail`) on `CommandExitEvidence`, and 1 renamed field (`stderr` → `output`) on `PhaseResult.error`. Both internal to the worker package; no consumers outside `packages/orchestrator/src/worker/`.
- No new dependencies. No new persisted state. No new HTML markers. No new relay events. No new config surface.

## Risk / Rollback

- **Risk 1 (ring-buffer memory)**: an adversarial subprocess writing tens of MB of stdout could cause `Buffer.concat` allocation churn (each `data` event allocates a fresh buffer of length `outputRing.length + chunk.length` before slicing). **Mitigation**: the slice-tail keeps steady-state at 8 KiB. For a 10 MB burst arriving in ~64 KiB chunks (Node's default `highWaterMark`), the loop performs ~160 concat-and-slice cycles — well below 1 second CPU. If chunks arrive smaller, the churn scales linearly with chunk count, still negligible against the 5-minute install / 10-minute validate timeouts.
- **Risk 2 (ordering fidelity)**: Node's stdout and stderr `data` events fire independently through the event loop; near-simultaneous writes from the child may deliver in `[out, err, out]` order when the child wrote `[out, out, err]`. **Mitigation**: documented as arrival-order best-effort (FR-004, Q5→A). In practice error-tail readers care about the *content*, not exact interleaving.
- **Risk 3 (CLI synthesis missing content)**: `synthesizeOutputTail` only reads `type === 'text'` chunks; if a failure's diagnostic content lives in a `type === 'error'` chunk (e.g., an error event JSON with a `message` field), it won't appear in the tail. **Mitigation**: the spec's motivating fixture is stdout-only shell failure, not CLI. `type === 'error'` chunks in Claude CLI's JSON stream indicate protocol errors, not command-under-test errors; their `data` is already stringified in `result.error.message` via the Claude CLI runtime. If field-level diagnostics prove valuable later, extend `synthesizeOutputTail` to also join `type === 'error'` chunks' `data.message` — additive, no compat impact.
- **Risk 4 (rename churn in downstream code)**: any external consumer reading `errorEvidence.stderrTail` breaks silently at TypeScript compile time (type error). **Mitigation**: `CommandExitEvidence` is a worker-internal type, not exported from `packages/orchestrator`'s public entry. `grep -r stderrTail packages/orchestrator/src` before merge should return zero non-test hits. Test files list is exhaustive (see Project Structure §Source Code).
- **Risk 5 (regression of #847's 4 KiB bound)**: if `synthesizeOutputTail` returns a > 4 KiB string when `PhaseResult.output` is very large, the alert grows. **Mitigation**: the function delegates to `boundOutputTail` before returning; the byte cap is enforced at synthesis time. Test asserts this on a 100 MB synthetic transcript.
- **Rollback**: `git revert` the 5 modified source files + delete the new synthesis file + rename `output-tail.ts` back to `stderr-tail.ts`. Zero data migration, zero schema change, zero relay-payload change. Existing stage comments are re-rendered on the next update (they'll go back to reading "stderr (last N lines)"). All in-flight `PhaseResult`s are ephemeral; nothing to migrate.

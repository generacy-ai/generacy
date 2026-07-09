# Research: Evidence block captures stdout alongside stderr (#890)

## Problem Restatement

#847 introduced a per-error `<details><summary>stderr (last N lines)</summary>` block on the stage comment and #865 mirrored it into a bottom-of-thread failure alert. Both surface the *bounded stderr tail* from `PhaseResult.error.stderr`, populated by `manageProcess` (`cli-spawner.ts:167`) via a `stderrBuffer` accumulator. The alert was intended to eliminate `docker exec`-to-diagnose during triage.

On `christrudelpw/sniplink#6/#7/#8` the alerts read:

```
❌ validate failed — `npm test && npm run build` exit 1
stderr: (empty)
```

The actual error — `Type error: Cannot find module '@/components/CopyButton'` — went to stdout. Next.js' `next build` writes type-check output to stdout; so does `vitest`; so does `npm` for install errors. The evidence surface built to prevent triage misses on its most common failure shape.

Secondary: #6's original failure is now *unreproducible* (branch tip and merge-preview both pass today). The persisted evidence should have preserved the error text for post-hoc reading; because it captured only the empty stream, the failure is now undiagnosable.

## Evidence

### Observed failure

- `sniplink#6/#7/#8` failed `validate` with alerts reading `stderr: (empty)`.
- The failing command was `npm test && npm run build` — `npm run build` calls `next build`, which produces its type-check failure on **stdout**, not stderr.
- The stage comment's `<details><summary>stderr (last N lines)</summary>` block rendered `(stderr empty)` — the literal from `boundStderrTail`'s empty-input path.
- Diagnosis required cloning the branch and re-running the command inside a container.

### Source verification (2026-07-09)

- **Shell-path spawn**: `CliSpawner.runValidatePhase` (`cli-spawner.ts:83`) and `runPreValidateInstall` (`cli-spawner.ts:113`) pass `undefined` as the `capture` argument to `manageProcess`. In `manageProcess` (`cli-spawner.ts:148`), the `if (child.stdout && !capture)` branch attaches an **intentionally empty** `.on('data', () => { /* intentionally empty */ })` listener at line 167. Every stdout byte is dropped on the floor.
- **CLI-path spawn**: `CliSpawner.spawnPhase` passes an `OutputCapture` instance. `OutputCapture.processChunk` (`output-capture.ts:70`) parses newline-delimited JSON events into `OutputChunk[]` stored on `PhaseResult.output`. `type: 'text'` chunks (`output-capture.ts:135, 151`) carry the human-readable text the model emitted. The raw stdout bytes are consumed by the JSON parser and never retained as a raw string.
- **`stderrBuffer`**: populated in `cli-spawner.ts:174–178` for both paths (its listener attaches unconditionally when `child.stderr` exists). This is the sole data source for `PhaseResult.error.stderr` at `cli-spawner.ts:249`.
- **6 evidence-build sites** in `phase-loop.ts` (lines 220, 300, 355, 430, 482, 512) all call `this.buildErrorEvidence(command, result, [timeoutMs?])` which reads `result.error?.stderr` and passes it through `boundStderrTail`. 4 of these sites synthesize a `PhaseResult` with a diagnostic string in `error.stderr` (unexpected-spawn catch, no-progress guard, product-diff-detect failure, empty-product-diff failure) — for these, `error.stderr` is a controlled string, not the buffer.
- **2 renderer sites** in `stage-comment-manager.ts` — `appendEvidenceBlock` (line 193) for the stage comment and `renderFailureAlert` (line 295) for the bottom-of-thread alert. Both read `evidence.stderrTail` and both emit `<summary>stderr (last N lines)</summary>`.
- **Existing bounder**: `boundStderrTail` in `stderr-tail.ts` — pure function, 4 KiB cap after last-30-lines slicing, `(stderr empty)` literal on empty input.

### Assumption verification

The spec's original Assumption block claimed "chunks are stored in `PhaseResult.output`". This is **verified false** for the exact case that motivates the bug: shell-path spawns pass `capture: undefined`, so no `OutputCapture` runs, so `PhaseResult.output` is `[]`. The output-capture chain runs only for Claude CLI phases. The clarifications' Q3 rewrites this assumption.

## Decision 1 — Rendering shape (Q1): single interleaved tail vs. two labeled tails

**Chosen**: single interleaved `outputTail`. `CommandExitEvidence.stderrTail` renamed to `outputTail`. Spawn layer merges stdout+stderr chunks in arrival order into one buffer; renderer emits one `<details><summary>output (last N lines)</summary>` block.

**Rationale**:
- The operator's question during triage is "what did the command print." A terminal answers that with one merged stream — the local `npm test && npm run build` run mixes both streams into the terminal's PTY. Matching that mental model wins over stream-preservation fidelity.
- Two labeled blocks (option B) doubles the visual real-estate for the common case (one stream has all the content, the other is empty or noise). Combined with FR-003's requirement that the empty stream not read as `(empty)`, option B forces per-stream conditional rendering — more moving parts than option A.
- Per-line stream prefixes (option C) preserve attribution at ~6 bytes/line overhead on the byte budget. Attribution rarely changes diagnosis; the byte tax hits every line.

**Rejected**:
- **Q1→B (two labeled tails)**: preserves stream fidelity at the cost of a two-block layout in the both-stream case. `npm` log-level differences across streams matter for *reading* the log; they matter less for reading a *tail* during triage.
- **Q1→C (prefixed interleave)**: the ~6 bytes/line prefix taxes the 4 KiB budget on every line, reducing operator-visible content. The single-stream common case pays the tax for nothing.

## Decision 2 — Empty-stream rendering (Q2)

**Chosen**: omit the empty stream entirely. Given Q1→A there is only one block; this reduces to the both-empty case, which renders one shared `output` header containing the body `(no output on either stream)`.

**Rationale**:
- The whole finding is that `(empty)` stole the reader's attention from the real evidence. Rendering a "diet version" of it (option B: one-line inline note; option C: collapsed empty `<details>`) keeps the same failure mode in a smaller font.
- The both-empty case is real (a timeout on a silent subprocess produces no output either stream) — that case gets one clear "no output on either stream" marker inside the same block shape as every other failure. No structural difference.

**Rejected**:
- **Q2→B (inline metadata note)**: reintroduces a smaller version of the `(empty)` distraction.
- **Q2→C (collapsed empty details)**: symmetric structure but still puts an "empty" signal in the alert. Contradicts the intent of the fix.

## Decision 3 — Spawn-layer plumbing scope (Q3)

**Chosen**: shell paths gain a bounded ring buffer (~8 KiB, O(1) memory) inside `manageProcess`; CLI phases synthesize the tail from `type: 'text'` chunks already retained in `PhaseResult.output`. No duplicate raw buffering.

**Rationale**:
- Shell paths are where the observed bug lives — `PhaseResult.output` is empty for them (no `OutputCapture`), so a raw buffer is the only source of a tail.
- Claude-CLI phases have parsed text chunks already available (`OutputCapture.processChunk` stores every `type: 'text'` chunk in the shared `buffer`). Buffering the raw JSON stdout in parallel would hold multi-MB transcripts in RAM per phase — the JSON transcripts can run to tens of MB on long implement runs. Synthesis at exit-time is O(chunks) walk, delegates to `boundOutputTail` for the byte cap.
- The **memory contract** (ring at 8 KiB, one active per worker) moots the "large phase RAM" objection that would apply to option B. Ring keeps the last ~4 KB worth of lines available for the last-30-lines slicing rule, with headroom for long lines.

**Rejected**:
- **Q3→A (shell-only, no CLI)**: leaves CLI-phase failures with the same `(stderr empty)` problem when a CLI phase writes its diagnostic to a `text` chunk instead of stderr. The bug would recur one abstraction layer over.
- **Q3→B (raw stdout everywhere, no ring)**: unbounded RAM per phase. A 100 MB Claude CLI transcript sits in RAM for 5–10 minutes of implement. The ring solves the memory issue on shell paths; CLI paths already have parsed chunks that solve it a different way.

## Decision 4 — Byte-budget allocation between streams (Q4)

**Chosen**: N/A. With Q1→A (single merged tail), one string is bounded once by `boundOutputTail` at 4 KiB after last-30-lines slicing. No inter-stream allocation rule needed.

**Rationale**: Q4 only bites if the rendering keeps two streams separate. Q1→A collapses them, so there's nothing to allocate. Documented explicitly to make it obvious to future readers that no allocation logic exists (they might otherwise search for one).

## Decision 5 — Chunk-ordering fidelity (Q5)

**Chosen**: arrival-order best-effort. Chunks concatenated in the order Node's `data` events deliver them; documented as approximate. No timestamps, no re-sort, no PTY.

**Rationale**:
- Node's `stdout.on('data', …)` and `stderr.on('data', …)` are two independent event streams that share the event loop. Their arrival order is the order Node's underlying pipe reader interleaves them — not necessarily the child's write order (pipe buffering inside the child may reorder near-simultaneous writes across streams).
- **Timestamps (option B)** record *arrival* time in the parent, which is the same information a concat already carries. Re-sorting by arrival time yields the same string. False precision at real cost.
- **PTY (option C)** merges streams inside the kernel — the highest fidelity, requiring `node-pty` (new dep), plus complicating timeout/kill semantics (PTY sessions have their own controlling-terminal lifecycle). Out of proportion for a log tail.
- For triage: the multi-second gap between a build's success lines and its type-error line is much larger than any pipe-buffering reorder window. Operators reading the tail see the error text intact.

**Rejected**:
- **Q5→B (timestamped, re-sorted)**: no fidelity improvement, added complexity.
- **Q5→C (PTY)**: too heavy for a tail.

## Ring buffer sizing rationale

**8 KiB pre-cap ring vs. 4 KiB post-cap bound**:

- The post-cap bound is 4 KiB after last-30-lines slicing.
- The last-30-lines slice, from a stream of long lines (Next.js type errors sometimes exceed 200 bytes each), needs to span 30 lines from a raw stream that could exceed 4 KiB.
- A 4 KiB ring might discard bytes that fall into the last-30-lines window — the ring holds *last-4096-bytes*, which for very long lines is fewer than 30 lines.
- **8 KiB doubles the headroom** — enough for 30 lines of 250-byte content, or 60 lines of 130-byte content. This matches the profile of real Next.js/vitest failure output.
- Larger rings (16 KiB, 32 KiB) would waste RSS on the common case and offer marginal fidelity gains.

Trade-off documented in `data-model.md §Ring buffer contract`.

## Naming / rename discipline

The rename `stderr` → `output` propagates across four sites:

1. `CommandExitEvidence.stderrTail` → `outputTail` (rendered field).
2. `PhaseResult.error.stderr` → `output` (raw merged tail source).
3. `boundStderrTail` → `boundOutputTail` (pure bounder).
4. `stderr (last N lines)` → `output (last N lines)` (rendered summary text on both #847 stage-comment block and #865 failure-alert).

All four in the same PR. The internal-type discipline in `packages/orchestrator/src/worker/` doesn't require a backwards-compatibility shim (worker-internal types have zero external consumers).

The parsed-transcript surface `PhaseResult.output: OutputChunk[]` is deliberately **not** renamed. It's a different concept (per-event parsed JSON) that lives on `PhaseResult` as a peer of `error`. Renaming it would overload names and confuse readers.

## Alternatives considered and rejected

- **PTY-backed spawn** (kernel-merged streams): highest fidelity, wrong tool. Adds `node-pty` dependency, changes `sh -c` semantics, complicates SIGTERM/grace-period logic. See Q5→C.
- **Timestamped chunks with sort at bound time**: no accuracy gain (arrival time = arrival time), added CPU and complexity. See Q5→B.
- **Structured error parsing** (extract `Type error:` lines): valuable for post-processing but out of scope. Widen capture first; parse later if the widened capture proves valuable.
- **Streaming/live-tail of output** (SSE): post-hoc tail is what the alert surface needs; live streaming is a different product surface (cockpit UI). Out of scope per spec.
- **Renaming `PhaseResult.output: OutputChunk[]`**: rejected. Two different concepts should have two different names.
- **Deleting `boundStderrTail` and inlining the bounder**: rejected. The pure function has an existing fuzz test (`stderr-tail.test.ts`) validating 100 MB inputs; keeping the boundary preserves that safety.

## Open questions (none)

All five spec Clarification questions have documented answers. No new questions surfaced during research.

## Key sources / references

- `specs/847-found-during-cockpit-v1/plan.md` — introduces the evidence block and the 4 KiB bound.
- `specs/847-found-during-cockpit-v1/contracts/failure-evidence-block.md` — original stage-comment rendering contract.
- `specs/865-found-during-cockpit-v1/contracts/failure-alert-comment.md` — bottom-of-thread alert rendering contract.
- `packages/orchestrator/src/worker/cli-spawner.ts` — the `manageProcess` spawn lifecycle.
- `packages/orchestrator/src/worker/output-capture.ts` — the CLI stdout JSON parser and `type: 'text'` chunk retention.
- `packages/orchestrator/src/worker/stderr-tail.ts` — the existing bounder to be renamed.
- Reproduction cases: `christrudelpw/sniplink#6/#7/#8`.

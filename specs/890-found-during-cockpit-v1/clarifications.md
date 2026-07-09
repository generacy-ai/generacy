# Clarifications: Evidence block captures stdout alongside stderr

**Issue**: [generacy-ai/generacy#890](https://github.com/generacy-ai/generacy/issues/890)
**Branch**: `890-found-during-cockpit-v1`

---

## Batch 1 — 2026-07-09

### Q1: Rendering shape — combined vs. separately-labeled tails
**Context**: FR-004 explicitly defers this decision to /clarify: "Preferred: a single chronologically-interleaved tail. Fallback: separately-labeled stdout and stderr tails." The choice cascades: it decides the shape of `CommandExitEvidence` (`stderrTail` gets renamed vs. augmented), whether `PhaseResult.error` needs a `stdout` string or a merged buffer, whether the spawn layer must timestamp chunks (Q3), and how the byte budget is allocated (Q4). It also decides what operators read in the alert on the vast majority of failures (single stream) vs. the rare both-stream case.
**Question**: How does the evidence block render output when a phase fails?
**Options**:
- A: **Single interleaved tail.** Spawn layer merges stdout+stderr chunks in arrival order into one buffer; `buildErrorEvidence` produces one `outputTail` shown under one `<details><summary>output (last N lines)</summary>` block. `stderrTail` field is renamed `outputTail` (breaking rename inside the discriminated union). Reader sees one stream of text that looks like local terminal output.
- B: **Two separately-labeled tails, non-empty first.** Spawn layer buffers each stream independently. `CommandExitEvidence` gains `stdoutTail` alongside `stderrTail`. Renderer emits whichever is non-empty first under its own `<details>` block; the empty one is handled per Q2. Preserves stream fidelity (npm log-levels differ across streams) at the cost of two blocks in the both-stream case.
- C: **Single interleaved tail with per-line stream prefix** (e.g., `[out] …` / `[err] …`). Same plumbing as A but every rendered line carries a tag. Preserves attribution inside one block; adds ~6 bytes per line to the 4 KiB budget and clutters the common single-stream case.

**Answer**: *Pending*

---

### Q2: Empty-stream rendering shape
**Context**: FR-003 says the empty stream MUST NOT render as a bare `(empty)` line "that competes for reader attention" — but doesn't say what it should render as instead. Current renderer (`stage-comment-manager.ts:207`) unconditionally emits `<details><summary>stderr (last N lines)</summary>` followed by `(stderr empty)` when stderr was empty. Downstream #865 failure-alert composer reuses that same block verbatim; both need to behave identically under the new shape. This question is orthogonal to Q1: it applies to option B directly, and to option A/C when the (rare) empty-both-streams case (FR-007) fires.
**Question**: When only one stream produced output (or neither did), how does the empty stream appear in the rendered block?
**Options**:
- A: **Omit entirely.** No header, no `(empty)` marker for the empty stream. Only the non-empty stream renders. Empty-both case (FR-007) collapses to a single `(no output on either stream)` line under one shared header.
- B: **Small inline note in the metadata section, not a `<details>` block.** `**stderr**: (no output)` appears as a one-liner above the `<details>` of the non-empty stream. Preserves the "stream X was checked and was empty" signal without giving it a full collapsible section.
- C: **Keep both `<details>` blocks; make the empty one collapsed and terse.** `<details><summary>stderr (empty)</summary></details>` — visually deprioritized (no body, no `(empty)` inside a code fence) but structurally symmetric.

**Answer**: *Pending*

---

### Q3: Spawn-layer plumbing scope (FR-005)
**Context**: The spec's Assumption block says "chunks are stored in `PhaseResult.output`" — this is **incorrect for the exact case that motivates the bug**. `runValidatePhase` and `runPreValidateInstall` (cli-spawner.ts:104,134) pass `undefined` for `OutputCapture`, and `manageProcess` (cli-spawner.ts:167) attaches a no-op stdout listener that discards every chunk. `spawnPhase` (Claude CLI) does pipe stdout through `OutputCapture`, but that captures **parsed JSON events**, not raw text — the raw bytes are consumed by the parser and never retained. So the fix must add raw-stdout buffering *somewhere*; the question is where.
**Question**: Which spawn paths gain raw-stdout buffering?
**Options**:
- A: **Shell paths only** (`runValidatePhase`, `runPreValidateInstall`). Add a `stdoutBuffer += chunk` accumulator alongside the existing `stderrBuffer` inside `manageProcess`, populated only when `capture` is `undefined`. Claude CLI phases are unchanged — their failure evidence continues to come from `stderrBuffer` (their raw stdout is JSON, not human-readable errors). Smallest surface, targets the observed bug directly.
- B: **All paths.** Buffer raw stdout for every phase, in parallel with any `OutputCapture` present. Claude CLI phases get a raw-stdout tail too. Memory cost: potentially large JSON transcripts held in RAM for the whole phase. Consistent behavior across phases; over-serves the bug.
- C: **Shell paths raw; Claude-CLI paths derive from `OutputChunk[]` text events.** For CLI phases, `buildErrorEvidence` synthesizes a text tail by concatenating `type: 'text'` chunks from `PhaseResult.output`. Same failure ergonomics for both worlds without duplicating capture in memory.

**Answer**: *Pending*

---

### Q4: Byte-budget allocation between streams
**Context**: FR-002 mandates the total combined evidence stay within the #847 4 KiB bound. `boundStderrTail` today applies "last 30 lines then cap 4096 bytes" to one string. With two streams (or one merged), the same rule needs a decision for how the budget divides. Wrong choice #1: 8 KiB total (bound doubles). Wrong choice #2: one stream starves the other whenever it exceeds 4 KiB. This question only bites if Q1=B (two labeled tails); for Q1=A/C the interleaved tail is one string capped once.
**Question**: How does the 4 KiB byte bound allocate between stdout and stderr in the two-stream (Q1=B) case?
**Options**:
- A: **Equal split — 2 KiB each.** Each stream independently sliced to last-30-lines then capped at 2048 bytes. Total ≤ 4 KiB + two truncation markers. Simple, predictable, halves resolution when only one stream exists (regression for stderr-only failures).
- B: **Full 4 KiB per stream, cap the combined output at 4 KiB by dropping older lines from the larger tail first.** Preserves per-stream last-lines fidelity in the common single-stream case; both-stream case shrinks the larger tail until the sum fits. Requires a second pass after per-stream bounding.
- C: **Reserve the full 4 KiB budget for whichever stream is non-empty; when both non-empty, allocate proportionally by raw byte length.** stdout-only failure gets the full 4 KiB tail (matches today's stderr-only behavior). Both-stream case tails each stream to its share of the budget. Predictable in the common (single-stream) case, proportional in the rare (both-stream) case.

**Answer**: *Pending*

---

### Q5: Chunk-ordering guarantee for the interleaved tail
**Context**: This question only bites if Q1=A or Q1=C. Node's child-process pipes deliver stdout and stderr chunks independently through the event loop; a `stdout.on('data', …)` and a `stderr.on('data', …)` firing in the same tick do not guarantee arrival order matches the child's actual write order (pipe buffering, macro-task scheduling). "Chronologically interleaved" in FR-004 could mean either faithful child-write order (requires PTY, or per-chunk high-res timestamps taken as close to `data` as possible then re-sorted) or arrival order (simpler; may reorder around scheduler boundaries but is stable enough for operator triage).
**Question**: What ordering fidelity does the interleaved tail guarantee?
**Options**:
- A: **Arrival-order best-effort.** Chunks concatenated in the order Node delivers them. Documented as "approximate — pipe buffering may reorder near-simultaneous writes." Zero clock reads, no re-sort. Sufficient for triage in every real-world case (multi-second gap between phases and error text).
- B: **Timestamped chunks, re-sorted at bound time.** Each `data` event records `performance.now()`; `boundOutputTail` sorts before slicing. Adds N clock reads per phase (cheap) and a stable sort. Fidelity improves marginally; still lossy under pipe buffering inside the child.
- C: **PTY-backed capture for shell phases** (spawn under a pseudo-terminal so both streams merge in the kernel). Highest fidelity; adds a PTY dependency (`node-pty`) and complicates timeout/kill semantics. Out of proportion to the fix.

**Answer**: *Pending*

---

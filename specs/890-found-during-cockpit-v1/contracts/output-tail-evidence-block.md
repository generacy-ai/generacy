# Contract: outputTail evidence block (#890 — supersedes #847's stderr-only surface)

**Scope**: FR-001, FR-002, FR-003, FR-004, FR-006, FR-007. Rendering contract for the merged-output evidence appended to `StageCommentManager`'s stage-comment output on `status: 'error'` **and** to the bottom-of-thread failure alert from `postFailureAlert` (#865).

This contract supersedes `specs/847-found-during-cockpit-v1/contracts/failure-evidence-block.md`. The block layout is byte-identical to #847's except that the `<summary>` text changes from `stderr (last N lines)` to `output (last N lines)`.

## When the block is rendered

Unchanged from #847:

1. `StageCommentData.status === 'error'`, AND
2. `StageCommentData.errorEvidence` is present with all three sub-fields set (`command`, `exitDescriptor`, `outputTail`).

The block MUST NOT render when `status === 'in_progress'` or `status === 'complete'`. Defensive path (errorEvidence absent on error status) still logs a warning and omits the block.

## Placement (stage comment)

Unchanged from #847. Below the summary metadata, insert a horizontal rule `---`, then the block.

**Byte layout** (post-#890):

```markdown
---
**Failed command**: `<command>`
**Exit**: <exitDescriptor>

<details><summary>output (last <N> lines)</summary>

```text
<outputTail>
```

</details>
```

Where `<N>` is the count of `\n`-separated lines in `outputTail` (after bounding). The fenced block uses `text` language for syntax-highlighting suppression.

**Delta vs. #847**: the `<summary>` text changes from `stderr (last <N> lines)` to `output (last <N> lines)`. Every other byte in the block is identical.

## Placement (failure alert, #865)

Unchanged structural layout; the `<summary>` text change propagates identically.

```markdown
<!-- generacy:failure-alert:<stage>:<runId> -->
❌ **<phase> failed** — `<command>` <exitDescriptor>.

<details><summary>output (last <N> lines)</summary>

```text
<outputTail>
```

</details>
```

**Delta vs. #865**: the `<summary>` text changes from `stderr (last <N> lines)` to `output (last <N> lines)`.

## Field derivations from `PhaseResult`

`phase-loop.ts` calls `buildErrorEvidence(command, result, [resolvedTimeoutMs?])` at 6 sites. The helper's post-#890 shape:

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

  // Shell path: `error.output` is the ring-buffer tail (already merged).
  // CLI path: `error.output` is empty; synthesize from parsed `type: 'text'` chunks.
  const rawOutput = result.error?.output ?? '';
  const outputTail = rawOutput.length > 0
    ? boundOutputTail(rawOutput)
    : synthesizeOutputTail(result.output);

  return { command, exitDescriptor, outputTail };
}
```

The exit-descriptor logic is byte-identical to #847. The output-tail logic changes:
- **Non-empty `result.error.output`** → bound via `boundOutputTail` (shell paths, synthesized results).
- **Empty `result.error.output`** → synthesize via `synthesizeOutputTail(result.output)` (CLI paths).
- Both branches respect the 4 KiB post-bounding cap (FR-002).

### The 6 call sites and their `command` sources (unchanged from #847)

| Site | `command` source | `result` source |
|------|------------------|-----------------|
| Pre-validate install failure (~line 220) | `config.preValidateCommand` | `installResult` from `runPreValidateInstall` (shell path) |
| Unexpected spawn error catch (~line 300) | `phase === 'validate' ? config.validateCommand : phase` | synthetic `PhaseResult` with `error: { message, output: '', phase }` (shell path shape; empty output falls through to synthesis, which finds no text chunks and returns the empty literal) |
| No-progress guard (~line 355) | `'implement (no-progress guard)'` | mutated `result` with `error: { message, output: 'no progress: tasks_remaining stayed at N across two increments', phase }` (synthesized diagnostic string in `output`) |
| Post-phase failure (~line 430) | `phase === 'validate' ? config.validateCommand : phase` | `result` from spawner (validate=shell, other=CLI) |
| Product-diff detection failure (~line 482) | `phase === 'validate' ? config.validateCommand : phase` | mutated `result` with `error: { message, output: '', phase }` (empty → synthesizer, which reads the CLI transcript chunks) |
| Empty-product-diff failure (~line 512) | `phase === 'validate' ? config.validateCommand : phase` | mutated `result` with `error: { message, output: '', phase }` (empty → synthesizer over CLI transcript) |

Only the object-literal keys change (`stderr:` → `output:`); no site changes its wiring or its arguments.

## `outputTail` bounding contract

Delegated to `boundOutputTail(raw: string)` from `packages/orchestrator/src/worker/output-tail.ts`. Full contract in `data-model.md`. Summary:

- Empty input → `(no output on either stream)`.
- ≤ 4 KiB after last-30-lines slice → returned unchanged.
- > 4 KiB after last-30-lines slice → truncate-from-start to 4096 bytes, prepend marker `… truncated (kept last <N> lines / 4096 bytes) …\n`.

For CLI paths, `synthesizeOutputTail` joins `type: 'text'` chunks with `\n` before delegating to `boundOutputTail`.

## Renderer invariants (both surfaces)

1. **The block MUST NOT alter any bytes above the horizontal-rule separator on the stage comment.** Same as #847. Test asserts on a stringwise diff.
2. **The block MUST be omitted entirely on `status: 'complete'` or `status: 'in_progress'`.** Successful-status output is byte-identical to pre-#890 (which was byte-identical to pre-#847).
3. **`<summary>` text change is the sole rendered delta from #847** in both surfaces. `stage-comment-manager.test.ts` and any snapshot fixture covering the summary line updates in lockstep.
4. **Rendered comment size MUST NOT exceed 6 KiB** even under adversarial output (bounded by 4 KiB tail cap + ~1.5 KiB metadata + ~200 bytes prelude). Test asserts on comment size with a 100 MB synthetic transcript.
5. **The `<details>` collapse MUST render on GitHub without escaping.** Triple-backtick sequences in `outputTail` are still neutralized by the ZWSP substitution.
6. **The rendered alert MUST NOT contain the substring `(empty)`** when the process produced any output on either stream (SC-003 scan).
7. **The both-empty case renders as `(no output on either stream)` inside the fenced block**, not `(empty)` and not a bare summary line (FR-007 / Q2→A).

## Cockpit classifier invariance (unchanged from #847)

The cockpit `failed:*` classifier reads the `❌ Error` sentinel line, which is byte-identical to pre-#890. The classifier does not read below the horizontal-rule separator, so the `<summary>` text rename is invisible. Regression asserted by the unchanged `packages/cockpit/**/__tests__/*.test.ts` suite (no cockpit changes needed).

## Test fixtures

### `stage-comment-manager.test.ts` (updates + one new)

Minimum coverage after #890:

1. **Happy path unchanged**: `status: 'complete'` with a PR URL renders the same bytes as today. No evidence block.
2. **Numeric-exit failure with stdout content**: `outputTail: 'Type error: Cannot find module …'` (from a Next.js fixture), `exitDescriptor: 'exit 1'` → asserts the summary reads `output (last N lines)` and the fenced block contains the type-error text.
3. **Timeout failure**: `exitDescriptor: 'killed (SIGTERM) after 300000ms'` → descriptor renders verbatim. (Unchanged from #847.)
4. **Abort failure with empty output**: `outputTail: '(no output on either stream)'` → asserts the empty literal renders inside the fenced block. **(Copy change vs. #847 — old fixture said `(stderr empty)`.)**
5. **Truncated output**: `outputTail` starts with the truncation marker → asserts the marker line renders as the first line of the fenced block.
6. **Backtick-poisoned output**: `outputTail` contains ` ``` ` → asserts the ZWSP substitution keeps the fenced block closed by its own 3 backticks.
7. **Missing errorEvidence on error status**: renderer omits the block + logs a warning (defensive path, inherited from #847).
8. **NEW — Both-empty case explicitly**: `outputTail: '(no output on either stream)'` → the fenced block body reads exactly that literal, and the outer alert body contains **no** substring `(empty)` (SC-003 scan).

### `phase-loop.test.ts` (updates + one new)

Every fixture asserting `errorCall.errorEvidence.stderrTail` → `.outputTail`. Every synthetic `error: { stderr: … }` → `error: { output: … }`.

**NEW — CLI-phase text-chunk synthesis fixture**: build a `PhaseResult` with `output: [{ type: 'text', data: { text: 'line1' } }, { type: 'text', data: { text: 'line2' } }]` and `error.output: ''`. Assert `errorEvidence.outputTail` equals `line1\nline2` (bounder returns it unchanged since under 4 KiB).

### `output-tail.test.ts` (renamed from `stderr-tail.test.ts`)

Every assertion of `boundStderrTail` renames to `boundOutputTail`. Empty-input assertion updates from `(stderr empty)` to `(no output on either stream)`. All fuzz/boundary cases (100 MB inputs, UTF-8 splits, exact-4096 boundaries) run against the renamed function.

### `output-tail-synthesis.test.ts` (NEW)

1. Empty chunks → `(no output on either stream)` (delegated to bounder).
2. Single `type: 'text'` chunk → returns `chunk.data.text` unchanged (under bound).
3. Mixed chunks (`init`, `text`, `tool_use`, `text`, `complete`) → returns only the two `text` chunks joined by `\n`, in stored order.
4. `type: 'text'` chunk with non-string `data.text` (or missing `data`) → skipped without error.
5. Adversarial: 10 000 text chunks, each 500 bytes → output is bounded to 4 KiB with the truncation marker (SC-002).

### `cli-spawner.test.ts` (NEW fixture)

**Real subprocess integration test**:
1. Run `runValidatePhase` against `sh -c 'echo "stdout error text"; exit 1'`.
2. Assert `result.success === false`, `result.exitCode === 1`.
3. Assert `result.error?.output` contains the substring `stdout error text` (SC-004 reproduction — the failure that was silently dropped before #890 is now captured).
4. Additional fixture: `sh -c 'echo "stdout"; echo "stderr" >&2; exit 1'` → `result.error?.output` contains both `stdout` and `stderr` substrings.

## Non-goals

- No JSON-encoded evidence (out of scope: cockpit UI rendering changes).
- No ANSI-stripping / no color-code normalization in `outputTail` (out of scope per spec).
- No differentiation between shell-level and CLI-level failures at the rendered surface — both flow through one `outputTail`.
- No cross-tool output normalization (Next.js vs. vitest vs. npm format differences).
- No structured error parsing (e.g., extracting `Type error:` lines specifically).
- No live-stream / SSE surface for output — post-hoc tail only.

# Contract: Failure-evidence block in the stage comment

**Scope**: FR-003, FR-004, FR-005, FR-007. Rendering contract for the evidence appended to `StageCommentManager`'s output on `status: 'error'`.

## When the block is rendered

The evidence block MUST be appended to the stage comment body iff:
1. `StageCommentData.status === 'error'`, AND
2. `StageCommentData.errorEvidence` is present with all three sub-fields set.

The block MUST NOT be rendered when `status === 'in_progress'` or `status === 'complete'` (FR-007). If `errorEvidence` is absent while `status === 'error'` (defensive path — should not occur if `phase-loop.ts` is correctly wired), the renderer omits the block and logs a warning.

## Placement

Inside the same stage comment (`StageCommentManager.updateStageComment` target), after the existing summary metadata block (`**Status**`, `**Started**`, optional `**Completed**`, optional `**PR**`). Below the last metadata line, insert a horizontal rule `---`, then the evidence block.

Byte layout (the exact template, `<...>` = interpolation slots):

```markdown
---
**Failed command**: `<command>`
**Exit**: <exitDescriptor>

<details><summary>stderr (last <N> lines)</summary>

```text
<stderrTail>
```

</details>
```

Where `<N>` is the count of `\n`-separated lines in `stderrTail` (after bounding), and the fenced block uses `text` language for syntax-highlighting suppression (stack traces / build errors are not JS/TS-shaped).

**Note**: the fenced block inside `<details>` must be preceded and followed by a blank line for GitHub's markdown parser to render it as a code block rather than inlining.

## Field derivations from `PhaseResult`

For each of the three `updateStageComment({ status: 'error' })` call sites in `phase-loop.ts`, `phase-loop.ts` composes `errorEvidence` via a private helper `buildErrorEvidence(command, result)`:

| Site | `command` source | `result` source |
|------|------------------|-----------------|
| Pre-validate install failure (line ~168) | `config.preValidateCommand` | `installResult` (returned by `runPreValidateInstall`) |
| Unexpected spawn error catch (line ~217) | `phase === 'validate' ? config.validateCommand : phase` (the string phase name for CLI phases) | synthetic `PhaseResult` from the caught error: `{ error: { message: String(error), stderr: '', phase }, exitCode: 1, success: false }` |
| Post-phase failure sites (~336, ~373, ~394) | `phase === 'validate' ? config.validateCommand : phase` | `result` (the returned `PhaseResult`) |

`buildErrorEvidence` derives:

```ts
{
  command,
  exitDescriptor:
       result.error?.message.includes('timed out')  ? `killed (SIGTERM) after ${resolvedTimeoutMs}ms`
     : result.error?.message.includes('was aborted') ? 'aborted'
     : `exit ${result.exitCode}`,
  stderrTail: boundStderrTail(result.error?.stderr ?? ''),
}
```

`resolvedTimeoutMs` is the timeout value in scope at the call site (`resolvePhaseTimeoutMs(config, phase)` for CLI phases, `DEFAULT_VALIDATE_TIMEOUT_MS` for validate, `DEFAULT_INSTALL_TIMEOUT_MS` for pre-validate). It is the same value passed to the spawner, so the descriptor's `Nms` matches the actual timeout used.

## `stderrTail` bounding contract

Delegated to `boundStderrTail(raw: string)` from `packages/orchestrator/src/worker/stderr-tail.ts`. Full contract in `data-model.md`. Summary:

- Empty input → `(stderr empty)`.
- ≤ 4 KiB after last-30-lines slice → returned unchanged.
- > 4 KiB after last-30-lines slice → truncate-from-start to 4096 bytes, prepend marker `… truncated (kept last <N> lines / 4096 bytes) …\n`.

## Renderer invariants

1. **The evidence block MUST NOT alter any bytes above the horizontal-rule separator.** The existing phase table, status line, timestamps, and PR line render byte-identically to the pre-fix output when `errorEvidence` is present. Test asserts on a stringwise diff.
2. **The evidence block MUST be omitted entirely on `status: 'complete'` or `status: 'in_progress'`.** Test asserts that successful stage-comment output equals its pre-fix output byte-for-byte.
3. **The HTML marker (`STAGE_MARKERS[stage]`) MUST remain the first line of the comment body**, byte-stable. The evidence block adds only lines *after* the existing content.
4. **Rendered comment size MUST NOT exceed 6 KiB** even under adversarial stderr (bounded by 4 KiB stderr cap + ~1.5 KiB metadata + ~200 bytes evidence prelude). Test asserts on comment size for a 100 MB synthetic stderr input.
5. **The `<details>` collapse MUST render on GitHub without escaping.** No user-supplied bytes in `command` or `stderrTail` may break out of the fenced code block. Test with adversarial inputs containing ``` ``` ``` and `</details>` — the fenced block uses 3 backticks; a 3-backtick sequence in stderr would close the block early. **Mitigation**: escape or replace triple-backtick sequences in `stderrTail` with a zero-width space between them (`` `​`` ) before rendering. Test asserts this substitution.

## Cockpit classifier invariance

The cockpit `failed:*` classifier (`packages/cockpit/...`) reads the stage comment via GitHub API and detects the error state from the `❌ Error` status line. Post-fix:

- The `**Status**: ❌ Error` line is byte-identical to pre-fix.
- The classifier does not read below the horizontal-rule separator today; the new block is invisible to it.
- Regression asserted by an unchanged `packages/cockpit/**/__tests__/*.test.ts` suite (no cockpit changes needed).

## Test fixtures (`stage-comment-manager.test.ts`)

Minimum coverage:

1. **Happy path unchanged**: `status: 'complete'` with a PR URL renders the same bytes as today. No evidence block.
2. **Numeric-exit failure**: `status: 'error'` + evidence with `exitDescriptor: 'exit 1'`, `stderrTail: 'ELIFECYCLE Command failed with exit code 1'` → asserts on exact rendered markdown.
3. **Timeout failure**: `exitDescriptor: 'killed (SIGTERM) after 300000ms'` → asserts the descriptor renders verbatim.
4. **Abort failure**: `exitDescriptor: 'aborted'`, `stderrTail: '(stderr empty)'` → asserts the empty-stderr literal renders inside the fenced block.
5. **Truncated stderr**: `stderrTail` starts with `… truncated (kept last 30 lines / 4096 bytes) …\n` → asserts the marker line renders as the first line of the fenced block.
6. **Backtick-poisoned stderr**: `stderrTail` contains ` ``` ` → asserts the substitution keeps the fenced block closed by *its own* 3 backticks.
7. **Missing errorEvidence on error status**: asserts renderer omits the block + logs a warning (defensive path).

## Non-goals

- No JSON-encoded evidence (out of scope: cockpit UI rendering changes).
- No ANSI-stripping / no color code normalization in `stderrTail` (out of scope per spec).
- No differentiation between shell-level and CLI-level failures — both flow through the same evidence-block shape.

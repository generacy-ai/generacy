# Contract: Failure evidence reason block (#915)

**Scope**: FR-002, FR-003, FR-004, FR-005, FR-006, FR-007. Rendering contract for the classifier `reason` line added to `StageCommentManager`'s stage-comment output on `status: 'error'` **and** to the bottom-of-thread failure alert from `postFailureAlert` (#865).

Composes with (does not supersede) `specs/890-found-during-cockpit-v1/contracts/output-tail-evidence-block.md`. The reason block is inserted **above** the outputTail block; the outputTail block layout is byte-identical to #890.

## When the reason block is rendered

The reason block is rendered when **both** hold:

1. `StageCommentData.status === 'error'` (stage comment) OR the caller invoked `postFailureAlert` (failure alert), AND
2. `StageCommentData.errorEvidence.reason` is present with a non-empty string value.

The reason block MUST NOT render when `evidence.reason` is `undefined` or empty. The remaining evidence (`command`, `exitDescriptor`, `outputTail`) renders unchanged.

Defensive path (reason present but `status !== 'error'`) inherits the existing #847 defensive: log a debug line and omit the whole error-evidence block.

## Placement (stage comment)

Below the `**Exit**` line, above the blank line preceding the `<details>` wrapper. Byte layout (post-#915):

**Single-line reason**:

````markdown
---
**Failed command**: `<command>`
**Exit**: <exitDescriptor>
**Reason**: <safeReason>

<details><summary>output (last <N> lines)</summary>

```text
<outputTail>
```

</details>
````

**Multi-line reason**:

````markdown
---
**Failed command**: `<command>`
**Exit**: <exitDescriptor>
**Reason**:

```text
<safeReason (capped 1 KiB, `…` on truncate)>
```

<details><summary>output (last <N> lines)</summary>

```text
<outputTail>
```

</details>
````

## Placement (failure alert, #865)

Below the summary line, above the blank line preceding the `<details>` wrapper. Byte layout (post-#915):

**Single-line reason**:

````markdown
<!-- generacy:failure-alert:<stage>:<runId> -->
❌ **<phase> failed** — `<command>` <exitDescriptor>.
**Reason**: <safeReason>

<details><summary>output (last <N> lines)</summary>

```text
<outputTail>
```

</details>
````

**Multi-line reason**:

````markdown
<!-- generacy:failure-alert:<stage>:<runId> -->
❌ **<phase> failed** — `<command>` <exitDescriptor>.
**Reason**:

```text
<safeReason (capped 1 KiB, `…` on truncate)>
```

<details><summary>output (last <N> lines)</summary>

```text
<outputTail>
```

</details>
````

## Field derivations from `PhaseResult`

`phase-loop.ts` calls `buildErrorEvidence(command, result, [resolvedTimeoutMs?], [classifier?])` at 6 sites.

### `exitDescriptor`

- When `classifier` argument is a non-empty string:
  ```
  failed post-exit: <classifier> (process exit <result.exitCode>)
  ```
- When `classifier` argument is `undefined` (process paths):
  - Unchanged three-way branch (timeout / abort / exit N from #890).

### `reason`

- When `classifier` argument is a non-empty string:
  ```
  reason = result.error?.message ?? ''
  ```
  Empty-string message is normalized to omission (renderer treats empty as absent).
- When `classifier` argument is `undefined`:
  - Field omitted entirely from the returned object.

### `outputTail`

Unchanged from #890. Reason presence does not affect output-tail derivation.

## Rendering normalization

Both `appendEvidenceBlock` and `renderFailureAlert` apply identical rules:

1. **Skip on absence**: `if (!evidence.reason) return;` — no block emitted.
2. **Backtick sanitization** (Q4→B): `` safeReason = evidence.reason.replace(/`/g, '`​') `` — insert ZWSP after every single backtick.
3. **Multi-line detection**: `isMultiLine = safeReason.includes('\n')`.
4. **1 KiB cap** (multi-line only): if `Buffer.byteLength(safeReason) > 1024`:
   - Slice to 1024 bytes.
   - Append `…` (U+2026) followed by newline.
   - Result: block trailing `\n…\n\`\`\`\n`.
   - Single-line reasons are not capped at the render layer — production classifiers emit < 300 chars.
5. **Emit** at the position defined in "Placement" above.

## Classifier vocabulary (fixed)

| Classifier | Callsite | Exit descriptor |
|------------|----------|-----------------|
| `no-progress` | `phase-loop.ts:429` | `failed post-exit: no-progress (process exit <N>)` |
| `no-product-code-changes` | `phase-loop.ts:630` | `failed post-exit: no-product-code-changes (process exit <N>)` |
| `spawn-error` | `phase-loop.ts:373` | `failed post-exit: spawn-error (process exit <N>)` |
| `product-diff-error` | `phase-loop.ts:600` | `failed post-exit: product-diff-error (process exit <N>)` |
| `undefined` | `phase-loop.ts:294, 548` | Unchanged from #890 (`exit <N>` / `killed …` / `aborted`). |

## Invariants

1. **Byte identity above the reason line**: the marker, `<!-- generacy:… -->`, summary line, `**Failed command**`, and `**Exit**` bytes are unchanged from #890 on both surfaces. The only pre-`<details>` insertion is the reason block.
2. **Single-source truth for sanitization**: `reason` and `outputTail` share the ZWSP backtick-escape idiom (`s.replace(/`/g, '`​')`). No renderer applies additional sanitization to `reason` beyond this + the multi-line-fence cap.
3. **Both renderers update in lockstep**: `appendEvidenceBlock` and `renderFailureAlert` render the reason block with byte-identical layout. A regression fixture asserts this by rendering the same `CommandExitEvidence` through both surfaces and diffing the reason-block substrings.
4. **Absent reason = pre-#915 output**: when `evidence.reason` is `undefined`, both surfaces produce byte-identical output to their #890 pre-fix shapes. This invariant is asserted by the two process-path regression fixtures (`:294`, `:548`).
5. **Exit descriptor honesty**: for every callsite where the process exited `0` and was failed post-exit by a classifier, `exitDescriptor` MUST NOT read the bare literal `exit 0`. This invariant is asserted directly by the FR-008 fixtures for `no-product-code-changes` and `no-progress` (both fail with exit code 0 in the observed cases).

## Referenced contracts

- `specs/847-found-during-cockpit-v1/contracts/failure-evidence-block.md` — original evidence block layout.
- `specs/865-found-during-cockpit-v1/contracts/failure-alert-comment.md` — failure alert composer.
- `specs/890-found-during-cockpit-v1/contracts/output-tail-evidence-block.md` — merged output-tail rename; the reason block sits above the outputTail block defined there.

# Data Model: Failure evidence reason field (#915)

Phase 1 output. Defines the type-level changes, validation rules, and downstream relationships that flow from adding the `reason` field to `CommandExitEvidence`.

## Core Types

### `CommandExitEvidence` (extended)

Location: `packages/orchestrator/src/worker/types.ts:302–305` (derived via `Extract`) and its source union at `types.ts:250–294`.

**Before (#890 shape)**:
```ts
type CommandExitEvidence = {
  command: string;
  exitDescriptor: string;
  outputTail: string;
};
```

**After (#915 shape)**:
```ts
type CommandExitEvidence = {
  command: string;
  exitDescriptor: string;
  outputTail: string;
  reason?: string;
};
```

**Field contracts**:

| Field | Type | Optional | Contract |
|-------|------|----------|----------|
| `command` | `string` | required | Failing command string as passed to the spawner. Unchanged from #847. |
| `exitDescriptor` | `string` | required | Post-#915: on synthetic paths, `failed post-exit: <classifier> (process exit <N>)`. On process paths, unchanged (`exit <N>` \| `killed (SIGTERM) after <Nms>` \| `aborted`). |
| `outputTail` | `string` | required | Bounded merged tail — stdout+stderr in arrival order, last 30 lines then 4 KiB cap, `(no output on either stream)` literal on both-empty. Unchanged from #890. |
| `reason` | `string` | **optional (new)** | Raw classifier message from `result.error.message` when the caller passed an explicit `classifier` argument. Absent on process-failure paths. Multi-line permitted. No caller-side trimming (rendering applies cap + escape). |

### `buildErrorEvidence` (signature extension)

Location: `packages/orchestrator/src/worker/phase-loop.ts:989`.

**Before**:
```ts
private buildErrorEvidence(
  command: string,
  result: PhaseResult,
  resolvedTimeoutMs?: number,
): CommandExitEvidence
```

**After**:
```ts
private buildErrorEvidence(
  command: string,
  result: PhaseResult,
  resolvedTimeoutMs?: number,
  classifier?: string,
): CommandExitEvidence
```

**Behavioral contract**:

- When `classifier === undefined`:
  - `exitDescriptor` uses the existing three-way branch (timeout / abort / exit N).
  - `reason` is omitted from the returned object.
  - Output-tail derivation unchanged from #890.
- When `classifier` is a non-empty string:
  - `exitDescriptor` = `` `failed post-exit: ${classifier} (process exit ${result.exitCode})` ``.
  - `reason` = `result.error?.message ?? ''` (raw string, not capped, not escaped — rendering applies both).
  - Output-tail derivation unchanged (may be empty or non-empty depending on the callsite's `error.output` population).

**Validation**:
- `classifier` values are string literals at callsites (see Classifier Vocabulary below). No runtime validation — TypeScript's structural typing gates the vocabulary at compile time via callsite string literals; deviation would still typecheck but would be caught in fixture assertions.

### Classifier Vocabulary

Fixed set of four values at production callsites in `phase-loop.ts`:

| Value | Callsite (~line) | Semantics |
|-------|------------------|-----------|
| `'no-progress'` | 429 | Implement-increment guard: `tasks_remaining` did not decrease across two increments. |
| `'no-product-code-changes'` | 630 | Product-diff guard from specs/820: all changed files under `EXCLUDED_PATH_PREFIXES`. |
| `'spawn-error'` | 373 | Unexpected error caught during phase spawn (before/around `spawnPhase`/`runValidatePhase`). |
| `'product-diff-error'` | 600 | `resolveBaseRef`/`computeProductDiff` threw during the product-diff detection step. |
| `undefined` | 294, 548 | Process-failure paths: pre-validate install failed, or post-phase `result.success === false` from a real non-zero exit. Renders the pre-#915 evidence shape. |

The set is closed at merge time. Adding a new classifier is a coordinated change: pick a name, add the callsite, add the fixture.

## Rendering Data Flow

### Reason format contract (rendering-time)

Location: `packages/orchestrator/src/worker/stage-comment-manager.ts:appendEvidenceBlock` and `renderFailureAlert`.

Both renderers apply the same reason normalization:

1. **Presence check**: skip the block if `evidence.reason` is `undefined` or empty string.
2. **Sanitize**: `safeReason = evidence.reason.replace(/`/g, '`​')` (ZWSP after every backtick).
3. **Multi-line detection**: `isMultiLine = safeReason.includes('\n')`.
4. **Length cap** (only applied on multi-line): if `Buffer.byteLength(safeReason) > 1024`, slice to 1024 bytes and append `…` marker. Single-line reasons are not capped at the render layer — the raw `error.message` from the four classifier sites is always < 300 chars.
5. **Emit**:
   - Single-line: `**Reason**: <safeReason>` inserted between the `**Exit**` line and the `<details>` block (in `appendEvidenceBlock`) or between the summary line and the `<details>` wrapper (in `renderFailureAlert`).
   - Multi-line: `**Reason**:` on its own line, blank line, ` ```text ` fence, capped/escaped reason, ` ``` `, blank line — same block position as single-line.

### Byte layout position

The reason block sits **above** the outputTail `<details>` block and **below** the `**Exit**` line (stage comment) or summary line (failure alert). See `contracts/failure-reason-block.md` for exact byte layout.

## Relationships

```
LabelMonitorService → WorkerDispatcher → PhaseLoop.executeLoop
                                              │
                                              ├─ buildErrorEvidence(cmd, result, ?timeoutMs, ?classifier)
                                              │        │
                                              │        └─ returns CommandExitEvidence {
                                              │              command,
                                              │              exitDescriptor,      // reworded when classifier set
                                              │              outputTail,          // unchanged from #890
                                              │              reason?,             // NEW: from result.error.message when classifier set
                                              │           }
                                              │
                                              ├─ stageCommentManager.updateStageComment({ errorEvidence })
                                              │        │
                                              │        └─ appendEvidenceBlock renders reason above outputTail
                                              │
                                              └─ stageCommentManager.postFailureAlert({ evidence })
                                                       │
                                                       └─ renderFailureAlert renders reason above outputTail
```

**Invariant**: both `appendEvidenceBlock` and `renderFailureAlert` render the reason with byte-identical layout rules. A test in `stage-comment-manager.test.ts` asserts this by feeding the same `CommandExitEvidence` through both surfaces and comparing the reason-block substrings.

## Serialization / Persistence

- `errorEvidence` is embedded in the stage-comment marker's JSON blob (invariant from #847). Adding `reason?` is forward-compatible: pre-fix blobs deserialize as `{ command, exitDescriptor, outputTail }` (no `reason`), post-fix reads accept both.
- No storage schema change: the persistence layer is a GitHub comment body — no migration.
- No cockpit-side change: the stage-comment reader is markdown-tolerant and does not deserialize the JSON blob today. If a future cockpit read consumes `reason`, it's an additive read.

## Validation Rules

| Rule | Enforced by | Failure mode |
|------|-------------|--------------|
| `classifier` argument in the fixed vocabulary | Callsite string literals (compile-time) | Unknown string still typechecks; caught by FR-008 fixture assertions. |
| Reason absent when `classifier === undefined` | `buildErrorEvidence` implementation | Regression fixture at `:294` / `:548` asserts `reason === undefined`. |
| Single-line reason renders inline | `stage-comment-manager` reason helper | Fixture asserts rendered substring `\n**Reason**: <text>\n` (no fence). |
| Multi-line reason renders fenced with 1 KiB cap + `…` on truncate | `stage-comment-manager` reason helper | Fixture drives a 2 KiB multi-line reason, asserts trailing `…\n\`\`\`\n`. |
| Backticks in reason ZWSP-escaped | `stage-comment-manager` reason helper | Fixture drives ``the ` backtick in the message``, asserts `` ` ​ `` appears in the rendered output. |
| Exit descriptor reworded when classifier set | `buildErrorEvidence` implementation | Fixture asserts `failed post-exit: no-product-code-changes (process exit 0)` on the specs/820 guard site. |

## Migration Notes

None required. The change is additive at every layer:

- Type: `reason?` is optional.
- Renderer: skips block when reason absent.
- Persistence: markdown embed; no schema.
- Consumers: cockpit reads markdown, not the JSON blob.

Post-merge, any stage-comment JSON blob written pre-fix continues to deserialize; any read post-fix that observes an absent `reason` renders the pre-#915 byte-identical shape.

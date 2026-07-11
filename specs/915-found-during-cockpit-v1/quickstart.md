# Quickstart: Verify the classifier reason surfaces in failure evidence (#915)

## Prerequisites

- Local checkout of `generacy-ai/generacy` on branch `915-found-during-cockpit-v1`.
- `pnpm install` completed.
- Node ≥22.

## Repro the pre-fix defect (baseline)

The observed defect in tetrad-development#92 finding #55: an implement phase failed by the specs/820 `no-product-code-changes` guard posts an alert reading:

> ❌ implement failed — `implement` exit 0. (no output on either stream)

The `reason` (the guard's message: `Phase "implement" produced no product-code changes — all changed files are under excluded prefixes [specs/]. Implement must modify at least one non-excluded file.`) is dropped by `buildErrorEvidence` because it only uses `error.message` to sniff timeout/abort wording.

## Verify the fix

### 1. Run the extended `buildErrorEvidence` fixtures

```bash
pnpm --filter @generacy-ai/orchestrator test src/worker/__tests__/phase-loop.test.ts
```

Assertions land on four new fixtures, one per classifier value:

- **product-diff guard** (`classifier: 'no-product-code-changes'`, `exitCode: 0`):
  - `evidence.exitDescriptor === 'failed post-exit: no-product-code-changes (process exit 0)'`
  - `evidence.reason` contains `'excluded prefixes [specs/]'`
  - `evidence.outputTail === '(no output on either stream)'`
- **no-progress guard** (`classifier: 'no-progress'`, `exitCode: 0`):
  - `evidence.exitDescriptor === 'failed post-exit: no-progress (process exit 0)'`
  - `evidence.reason === 'Implement increment made no progress — aborting to prevent infinite loop'`
  - `evidence.outputTail` contains `'tasks_remaining stayed at'` (unchanged — the counter text still lives in `error.output`).
- **spawn-error catch** (`classifier: 'spawn-error'`):
  - `evidence.exitDescriptor` starts with `'failed post-exit: spawn-error'`.
  - `evidence.reason` contains `String(error)`.
- **product-diff-error catch** (`classifier: 'product-diff-error'`):
  - `evidence.exitDescriptor` starts with `'failed post-exit: product-diff-error'`.
  - `evidence.reason` contains `'product-diff detection failed'`.

Two regression fixtures assert the process-path invariance:

- pre-validate install failure (`:294`, `classifier: undefined`) → `evidence.reason` is `undefined`, descriptor is `exit <N>`.
- post-phase real failure (`:548`, `classifier: undefined`) → same.

### 2. Run the extended renderer fixtures

```bash
pnpm --filter @generacy-ai/orchestrator test src/worker/__tests__/stage-comment-manager.test.ts
```

Assertions:

- **Single-line reason** renders as `**Reason**: <text>` inline between `**Exit**` and the `<details>` wrapper.
- **Multi-line reason** renders as `**Reason**:` on its own line, followed by a ` ```text ` fence containing the verbatim message.
- **2 KiB multi-line reason** gets sliced to 1 KiB and rendered with `…` before the closing fence.
- **Backtick in reason** (`` "the ` character in message" ``) gets ZWSP-escaped in the rendered output.
- **Absent reason** → no `**Reason**` substring anywhere in the rendered block; output byte-identical to #890.
- **Symmetry**: the same `CommandExitEvidence` fed through `appendEvidenceBlock` and `renderFailureAlert` produces byte-identical reason-block substrings.

### 3. Live end-to-end verification

The four classifier sites can be repro'd locally by driving an issue through the phase loop with a synthetic failure. The simplest reproduction is the product-diff guard:

1. Start a fresh cluster + issue on this branch.
2. Push a commit that touches only `specs/**` files under the issue's branch.
3. Trigger the `implement` phase.
4. Observe the posted failure alert on the issue.

**Expected post-fix alert body**:

```markdown
❌ **implement failed** — `implement` failed post-exit: no-product-code-changes (process exit 0).
**Reason**: Phase "implement" produced no product-code changes — all changed files are under excluded prefixes [specs/]. Implement must modify at least one non-excluded file.

<details><summary>output (last 1 lines)</summary>

```text
(no output on either stream)
```

</details>
```

The operator + auto session see the classifier name in the summary + the guard's explanation in-line, so no requeue is needed — the corrective action ("implement must modify a non-excluded file") is visible from the alert body alone.

## Troubleshooting

- **Alert still reads `exit 0. (no output on either stream)`**: check that all six `buildErrorEvidence` callsites in `phase-loop.ts` pass the `classifier` argument explicitly. Confirm the classifier at the failing site is not empty-string (which the renderer normalizes to absent).
- **Reason line missing from stage comment but present in failure alert (or vice versa)**: the two renderers must update in lockstep (Invariant 3 in `contracts/failure-reason-block.md`). Grep for `**Reason**` in `stage-comment-manager.ts`; both `appendEvidenceBlock` and `renderFailureAlert` should emit it.
- **Backticks in reason break markdown**: confirm the ZWSP substitution runs before rendering (`safeReason = reason.replace(/`/g, '`​')`). If the substitution is missing on multi-line paths, the fence still contains it — the escape is defense-in-depth for the single-line inline path.
- **Multi-line reason exceeds comment**: 1 KiB cap on multi-line reasons applies at the render layer. If a caller passes a 100 KiB `String(error)`, the cap slices to 1024 bytes + `…` marker. Confirm the cap check uses `Buffer.byteLength`, not `.length` (which counts UTF-16 code units, not bytes).

## Available commands

- `pnpm --filter @generacy-ai/orchestrator test` — full orchestrator test suite.
- `pnpm --filter @generacy-ai/orchestrator test src/worker/__tests__/phase-loop.test.ts` — `buildErrorEvidence` fixtures.
- `pnpm --filter @generacy-ai/orchestrator test src/worker/__tests__/stage-comment-manager.test.ts` — renderer fixtures.
- `pnpm changeset` — add the `.changeset/` entry describing the additive field.

## Next step

Run `/speckit:tasks` on this branch to generate the task list from `plan.md`.

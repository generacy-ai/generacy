# Quickstart: Verify the stdout-alongside-stderr evidence surface (#890)

This walk-through verifies both halves of the fix — the shell-path ring buffer capturing stdout, and the renamed renderer emitting `output (last N lines)` instead of `stderr (last N lines)`.

## Prerequisites

- Repo checked out at `890-found-during-cockpit-v1` (or a branch containing this PR).
- Node.js ≥ 22 (per orchestrator package).
- Working `pnpm install` inside `packages/orchestrator`.

## 1. Install and build

```bash
pnpm install
pnpm --filter '@generacy-ai/orchestrator' build
```

## 2. Run the affected unit tests

```bash
pnpm --filter '@generacy-ai/orchestrator' test \
  --run \
  src/worker/__tests__/output-tail.test.ts \
  src/worker/__tests__/output-tail-synthesis.test.ts \
  src/worker/__tests__/cli-spawner.test.ts \
  src/worker/__tests__/phase-loop.test.ts \
  src/worker/__tests__/stage-comment-manager.test.ts
```

All five suites should pass. Expected changes vs. `develop`:

- `output-tail.test.ts` asserts against `boundOutputTail` (renamed) with an empty-input literal `(no output on either stream)`.
- `output-tail-synthesis.test.ts` is new — covers the `OutputChunk[]` joiner for CLI-phase tails.
- `cli-spawner.test.ts` gains a real-subprocess fixture: `sh -c 'echo "stdout error text"; exit 1'` → `result.error.output` contains `stdout error text`.
- `phase-loop.test.ts` and `stage-comment-manager.test.ts` update every `.stderrTail` reference to `.outputTail` and every `stderr (last …)` string to `output (last …)`.

## 3. Repro the observed defect against the fixed builder

The observed defect on `christrudelpw/sniplink#6/#7/#8` produced alerts reading `stderr: (empty)`. Reproduce the fixed behavior against a synthetic PhaseResult:

```bash
node --experimental-vm-modules -e "
import('./packages/orchestrator/dist/worker/phase-loop.js').then(mod => {
  // synthetic — imitates a Next.js next build failure
  const result = {
    phase: 'validate',
    success: false,
    exitCode: 1,
    durationMs: 500,
    output: [],
    error: {
      message: 'Phase \"validate\" failed with exit code 1',
      output: '.next/types/…\nType error: Cannot find module \\'@/components/CopyButton\\'.\n  at src/app/page.tsx:5:1',
      phase: 'validate',
    },
  };
  const evidence = mod._testHooks?.buildErrorEvidence?.('npm test && npm run build', result) ?? '(no test hook)';
  console.log(evidence);
});
"
```

Expected output shape:

```
{
  command: 'npm test && npm run build',
  exitDescriptor: 'exit 1',
  outputTail: '.next/types/…\nType error: Cannot find module \\'@/components/CopyButton\\'.\n  at src/app/page.tsx:5:1',
}
```

Note the field is `outputTail` (not `stderrTail`), and it contains the `Type error:` line that used to be dropped.

*(Test hook is optional — the same behavior is exercised by the `phase-loop.test.ts` new fixture.)*

## 4. Verify the rendered stage comment / alert

Render the stage comment through `stage-comment-manager.ts` in the test fixture:

```bash
pnpm --filter '@generacy-ai/orchestrator' test \
  --run \
  src/worker/__tests__/stage-comment-manager.test.ts \
  --reporter verbose
```

The updated fixture emitting an error status now shows:

```markdown
---
**Failed command**: `npm test && npm run build`
**Exit**: exit 1

<details><summary>output (last 3 lines)</summary>

```text
.next/types/…
Type error: Cannot find module '@/components/CopyButton'.
  at src/app/page.tsx:5:1
```

</details>
```

Two things to confirm visually:

1. The summary reads `output (last N lines)` — not `stderr (last N lines)`.
2. The fenced block contains real diagnostic content — not `(stderr empty)`, not `(empty)` in any form.

## 5. End-to-end smoke against a real subprocess

Optional but recommended before merging:

```bash
# Start Firebase emulators + orchestrator per DEVELOPMENT_STACK.md
/workspaces/tetrad-development/scripts/stack start
source /workspaces/tetrad-development/scripts/stack-env.sh

# Trigger a worker with a validate command that writes only to stdout
cd /path/to/a/fresh/next.js/scaffold
# … arrange a synthetic type error in src/app/page.tsx …
# push the branch and label the issue process:speckit-feature

# Wait for the validate phase to fail. Expected on the issue:
# - The stage comment's <details><summary>output (last N lines)</summary>
#   contains the Type error: message.
# - The bottom-of-thread failure-alert comment (#865) says the same thing.
# - Neither surface reads "(empty)" anywhere.
```

## 6. Success signals

- Alerts on stdout-only failures contain the actual error text (SC-001).
- Evidence block total size stays within 4 KiB across all fixture cases (SC-002).
- No alert text contains the substring `(empty)` when the process produced any output (SC-003).
- Feeding the fixed builder a canned `next build` stdout for `sniplink#6` reproduces an alert containing `Cannot find module '@/components/CopyButton'` (SC-004).

## Troubleshooting

### Test suite complains about `stderrTail` being unknown

Any remaining `.stderrTail` reference in the test suite is a leftover from the rename. `grep -rn "stderrTail" packages/orchestrator/src` should return zero non-comment hits after merge. Non-test hits are compile errors.

### `output-tail-synthesis.test.ts` returns empty despite text chunks

Confirm the chunk shape: `{ type: 'text', data: { text: '…' } }`. If `data.text` is missing or non-string, the synthesizer skips the chunk (by contract). Fixture setup bug — not a code bug.

### Ring buffer output is garbled at the leading edge

Expected: the ring may cut a UTF-8 code unit at the 8 KiB boundary, producing a byte-garbled leading line. The subsequent `boundOutputTail` last-30-lines slice discards that leading fragment (splits on `\n`, keeps the last 30 whole lines). If garbling reaches the rendered tail, either the last-30-lines slice fell short (line count < 30 among 8 KiB of content) or the fragment survived slicing — a real bug worth investigating.

### Alert still reads `stderr: (empty)` in production

Two paths to check:
1. Container is running an old orchestrator image. Re-pull / restart the cluster.
2. The failing site synthesizes a `PhaseResult` with `error: { output: '', … }` and no `output: OutputChunk[]` (e.g., a truly-silent timeout). The correct behavior is `outputTail: '(no output on either stream)'`. If it reads `(stderr empty)`, the renamer missed a call site — grep for the old literal.

## Commands recap

| Task | Command |
|------|---------|
| Build orchestrator | `pnpm --filter '@generacy-ai/orchestrator' build` |
| Run all affected tests | `pnpm --filter '@generacy-ai/orchestrator' test --run src/worker/__tests__/` |
| Grep leftover references | `grep -rn "stderrTail\|(stderr empty)\|boundStderrTail\|stderr (last" packages/orchestrator/src` |
| Grep rename completeness | `grep -rn "outputTail\|(no output on either stream)\|boundOutputTail\|output (last" packages/orchestrator/src` |

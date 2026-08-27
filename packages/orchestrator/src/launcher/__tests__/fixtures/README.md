# Golden subscription-baseline fixture

`subscription-baseline.json` is the byte-for-byte capture of the `{ command, args, env }`
triple produced by every subscription-route launch kind. The golden test
(`../golden-subscription-spawns.test.ts`) compares live launcher output against it to
prove the P1 gateway-routing work (epic #1197) leaves subscription launches unchanged —
the epic's "flag-free by construction" guarantee.

## Provenance

- **Captured from:** `ff26ee7e` ("Updated Generacy model settings") — the pre-P1
  merge-base, the single parent of #1198's landing commit `ea367b04`. Capturing from
  before any gateway code existed is what makes this a true parity baseline rather than a
  self-referential snapshot.
- **Capture date:** 2026-08-27

The `capturedAt` and `sourceSha` fields are provenance metadata only; the golden test
excludes them from comparison and asserts on the `spawns` map alone.

## Regenerating

A fixture-only diff with no launch-path change is a red flag — see
`specs/1201-context-integration-issue/contracts/golden-fixture.md`.

To regenerate against the current tree (forward-stability pin, not a fresh baseline):

```bash
cd packages/orchestrator
GOLDEN_UPDATE=1 pnpm exec vitest run golden
```

To re-capture a fresh pre-P1 baseline (only if the merge-base itself is re-established),
build a worktree at the pre-P1 SHA, build the claude-code plugin (it resolves via
`dist/index.js`), copy this harness + fixtures dir in, run the `GOLDEN_UPDATE=1` command
there, and copy the result back. Any regeneration must be justified in the PR description.

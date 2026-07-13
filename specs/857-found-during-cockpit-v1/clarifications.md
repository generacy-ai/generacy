# Clarifications: #857

## Batch 1 — 2026-07-08

### Q1: Stdout note delivery mechanism
**Context**: FR-003 mandates the vacuous-green path emit the exact line `no checks configured and none required — proceeding on completed:validate\n` to stdout, and SC-006 says the line is byte-exact so scrapers/tests can grep for it. The current `RunMergeResult` type is `{ exitCode, stdout: string }` and the CLI wrapper writes `result.stdout` at `merge.ts:189-191`. On the red path, `stdout` carries the JSON envelope; on today's green path, `stdout` is `''` and only a `logger.info({ pr }, 'PR merged')` fires. The spec does not say which mechanism produces the FR-003 note.
**Question**: How should `runMerge` deliver the FR-003 note so that FR-011's end-to-end test can assert it byte-exact?
**Options**:
- A: Append the note to `RunMergeResult.stdout` (returned to the CLI action, which writes it via the existing `process.stdout.write(result.stdout)` path). Tests assert on the return value. Preserves the pure-function shape used by the red path.
- B: Call `process.stdout.write(...)` directly inside `runMerge` before `mergePullRequest`. Tests must capture `process.stdout`. Keeps the merge return value `{ exitCode: 0, stdout: '' }` unchanged.
- C: Route the note through `logger.info` at a dedicated call (e.g. `logger.info({}, 'no checks configured…')`). Requires `logger` to be configured to write structured lines to stdout for the note case; may collide with the existing `'PR merged'` info log.

**Answer**: A — append the note to `RunMergeResult.stdout` and let the existing `process.stdout.write` path deliver it. The red path already uses exactly this shape, the function stays pure, and FR-011's byte-exact assertion runs against a return value instead of captured process streams (B) or logger formatting that was never part of the contract (C).

### Q2: `status.ts` real-error behavior after wrapper change
**Context**: After FR-001, `getPullRequestCheckRuns` returns `[]` (not throws) for the no-checks case. `status.ts:121-128` currently wraps the call in a try/catch that maps any throw to `checks = 'none'`. Post-fix, that catch only fires on genuine failures (auth, network, JSON shape). The spec is silent on whether to keep the swallow-to-`'none'` behavior for real errors. Today an operator running `cockpit status` cannot distinguish "repo has no CI" from "gh auth revoked mid-run" — both render `none`. FR-002 removes the wrapper's warn log for the no-checks case only, so real errors still log the `{ repo, prNumber, ghStderr }` warn.
**Question**: What should `status.ts` (and by symmetry `watch/poll-loop.ts`) do when `getPullRequestCheckRuns` throws a real error, now that "no checks" is no longer conflated with "error"?
**Options**:
- A: Keep current behavior — real errors are still swallowed to `checks = 'none'`. Operator relies on the wrapper's `warn` log for signal. Simplest, no visible change in the table.
- B: Bubble the throw — `runStatus` returns non-zero and emits a stderr line naming the failing repo/pr. Loud; single failing repo breaks the whole snapshot.
- C: Introduce a distinct sentinel (e.g. `checks: 'error'`) so the row renders as a visible error marker but the snapshot still completes. Requires widening the render union and touching group/render code.

**Answer**: C — a distinct `'error'` sentinel rendered visibly in the row; snapshot still completes. This fix's whole point is that `'none'` becomes legitimate data ("repo has no CI"); mapping real failures back onto it (A) recreates the exact ambiguity finding #20 exposed — a week reading blank checks columns as absent data while the fetch was failing. B fails the entire snapshot over one repo's auth blip, which is disproportionate for `status` and unacceptable for `watch`'s poll loop. Same sentinel in the watch snapshot union; `'error'` is never actionable (a `gh` failure is not a red PR), and `error↔X` diff emissions are honest noise about a real observability gap. The wrapper's structured `warn` keeps carrying the detail.

### Q3: `ChecksRollup` `'none'` variant — actionable/diff semantics
**Context**: FR-007 widens `ChecksRollup` to include `'none'` (currently `'pending' | 'success' | 'failure'` in `watch/snapshot.ts:6`). The spec says every consumer of `rollup()` "MUST accept `'none'` without falling through to the catch/degrade branch." Consumers today:
- `actionable.ts:24` treats only `checksRollup === 'failure'` as actionable → `'none'` is inherently non-actionable (matches "no CI is not red").
- `diff.ts:113` emits a `pr-checks` line on any `prev.checksRollup !== curr.checksRollup` transition → transitions to/from `'none'` (e.g. a repo adds CI mid-watch) would emit.

The spec doesn't say whether these implicit behaviors are the intended contract for `'none'`.
**Question**: For the widened `ChecksRollup` union, what is the intended behavior of `'none'` in `actionable` and `diff`?
**Options**:
- A: Implicit is intended — `'none'` is never actionable, and transitions to/from `'none'` emit a `pr-checks` line like any other rollup change. No code change beyond the type widening.
- B: Add explicit case handling — `actionable.ts` gets a `checksRollup === 'none'` short-circuit (documented "no CI"); `diff.ts` keeps `!==` semantics but the emitted line labels `'none'` distinctly (e.g. `pr-checks: none → success`).
- C: Suppress `'none'` transitions in `diff.ts` — transitions where either side is `'none'` do NOT emit a line (treat `'none'` as absence, not state). `actionable.ts` unchanged.

**Answer**: A — the implicit behaviors are the intended contract; pin them with tests rather than code. `'none'` is inherently non-actionable ("no CI is not red" is this issue's thesis), and a transition to/from `'none'` is a real observable event — a repo gaining CI mid-watch SHOULD emit, and the line naturally reads `none → success` without special labeling (B) because the union value prints. C's suppression treats `'none'` as absence and hides a genuine change. The regression tests assert both: `'none'` never actionable; none-transitions emit.

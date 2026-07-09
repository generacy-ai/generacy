# Tasks: Evidence block captures stdout alongside stderr (#890)

**Input**: Design documents from `/specs/890-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md, contracts/output-tail-evidence-block.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = operator triage, US2 = post-hoc diagnosis)

## Phase 1: Type Rename (Foundation)

The two field renames (`stderrTail` → `outputTail`, `error.stderr` → `error.output`) are the foundation every other task depends on. Do these first, in one commit, so downstream files compile against the new shape.

- [X] **T001** [US1] Rename `PhaseResult.error.stderr` → `output` and `CommandExitEvidence.stderrTail` → `outputTail` in `packages/orchestrator/src/worker/types.ts` (~line 155 and ~line 237). Update JSDoc per data-model.md §Renamed types: describe the merged nature, the shell-vs-CLI split, and the `(no output on either stream)` empty literal. Leave `PhaseResult.output: OutputChunk[]` untouched; leave the `mergeConflict` variant untouched.

## Phase 2: Bounder Rename

- [X] **T002** [US1] Rename `packages/orchestrator/src/worker/stderr-tail.ts` → `output-tail.ts`. Rename exported function `boundStderrTail` → `boundOutputTail`. Change the empty-input literal from `(stderr empty)` to `(no output on either stream)`. Keep all other logic (4 KiB cap, last-30-lines slicing, truncation marker) unchanged.

## Phase 3: CLI-Phase Tail Synthesis (New File)

- [X] **T003** [P] [US1] Create `packages/orchestrator/src/worker/output-tail-synthesis.ts` exporting `synthesizeOutputTail(chunks: OutputChunk[]): string`. Per data-model.md §New pure-function boundary: filter to `chunk.type === 'text'`, read `chunk.data.text` only when it is a string, join with `'\n'` in stored order, delegate to `boundOutputTail`. Non-text chunks (`init`, `tool_use`, `tool_result`, `complete`, `error`) are skipped.

## Phase 4: Shell-Path Ring Buffer

- [X] **T004** [US1] Add merged stdout+stderr ring buffer inside `manageProcess` in `packages/orchestrator/src/worker/cli-spawner.ts` (~line 167). Per plan.md §Shell path: declare `const RING_BYTES = 8192`, `let outputRing = Buffer.alloc(0)`, `appendRing(data)` that `Buffer.concat`+`subarray` slice-tails to the ring cap. Replace the no-op stdout listener with `child.stdout.on('data', appendRing)` when `capture === undefined`. Route stderr into the same ring when `!capture`; keep the CLI path stderr branch inert (documented no-op). Delete the `stderrBuffer` accumulator. At exit (~line 249), write `output: capture ? '' : outputRing.toString('utf8')` into `result.error` (replacing `stderr: stderrBuffer`).

## Phase 5: Evidence Builder Update

- [X] **T005** [US1] [US2] Update `buildErrorEvidence` in `packages/orchestrator/src/worker/phase-loop.ts` (~line 842). Per contracts/output-tail-evidence-block.md §Field derivations: read `result.error?.output ?? ''` as `rawOutput`; when non-empty, pass through `boundOutputTail`; when empty, call `synthesizeOutputTail(result.output)`. Return `{ command, exitDescriptor, outputTail }`. Import `synthesizeOutputTail` from `./output-tail-synthesis.js` and `boundOutputTail` from `./output-tail.js`.

- [X] **T006** [US1] Update the 4 synthesized-`PhaseResult` call sites in `packages/orchestrator/src/worker/phase-loop.ts` that write into `error.stderr`. Per plan.md §buildErrorEvidence becomes shape-aware, these are: unexpected-spawn catch (~line 298), no-progress guard (~line 350), product-diff detection failure (~line 477), empty-product-diff failure (~line 504). Mechanical rename inside each object literal: `error: { message, stderr: '…', phase }` → `error: { message, output: '…', phase }`. Same for the `cli-spawner.ts` synthesis site at ~line 249 if T004 didn't already cover it.

## Phase 6: Renderer Updates

- [X] **T007** [US1] Update both `<details>` renderers in `packages/orchestrator/src/worker/stage-comment-manager.ts`: `appendEvidenceBlock` (~line 193) and `renderFailureAlert` (~line 295). Per data-model.md §Renderer invariants: read `evidence.outputTail` (was `stderrTail`), emit `<details><summary>output (last N lines)</summary>` (was `stderr (last N lines)`). Line count computation (`.split('\n').length`), ZWSP triple-backtick substitution, and fenced-block layout unchanged. Both surfaces must update in lockstep.

## Phase 7: Test Updates

Tests can run in parallel — they live in different files and only depend on the source changes above.

- [X] **T008** [P] [US1] Rename `packages/orchestrator/src/worker/__tests__/stderr-tail.test.ts` → `output-tail.test.ts`. Per data-model.md §Test-suite touchpoints: update function-name assertions (`boundStderrTail` → `boundOutputTail`); update the empty-input assertion from `(stderr empty)` to `(no output on either stream)`. Leave all fuzz/boundary cases (100 MB inputs, UTF-8 splits, exact-4096 boundaries) unchanged.

- [X] **T009** [P] [US1] Create `packages/orchestrator/src/worker/__tests__/output-tail-synthesis.test.ts`. Per contracts/output-tail-evidence-block.md §output-tail-synthesis.test.ts: (1) empty chunks → `(no output on either stream)`; (2) single `type: 'text'` chunk → returns `chunk.data.text` unchanged; (3) mixed chunks (`init`, `text`, `tool_use`, `text`, `complete`) → only the two text chunks joined by `\n` in order; (4) `type: 'text'` chunk with non-string `data.text` (or missing `data`) → skipped without error; (5) adversarial 10 000 × 500-byte text chunks → bounded to 4 KiB with truncation marker (SC-002).

- [X] **T010** [P] [US1] [US2] Update `packages/orchestrator/src/worker/__tests__/cli-spawner.test.ts`. Add a real-subprocess fixture per contracts §cli-spawner.test.ts NEW fixture: run `runValidatePhase` against `sh -c 'echo "stdout error text"; exit 1'`, assert `result.error?.output` contains `stdout error text` (SC-004 reproduction). Add a second fixture: `sh -c 'echo "stdout"; echo "stderr" >&2; exit 1'` → `result.error?.output` contains both `stdout` and `stderr` substrings.

- [X] **T011** [P] [US1] Update `packages/orchestrator/src/worker/__tests__/phase-loop.test.ts`. Per data-model.md §Test-suite touchpoints: rewrite every `.stderrTail` assertion to `.outputTail`; rewrite every synthetic `error: { stderr: … }` to `error: { output: … }`. Add new CLI-phase fixture per contracts §phase-loop.test.ts NEW: build a `PhaseResult` with `output: [{ type: 'text', data: { text: 'line1' } }, { type: 'text', data: { text: 'line2' } }]` and `error.output: ''`, assert `errorEvidence.outputTail === 'line1\nline2'`. Add stdout-only SC-001 fixture: Next.js `Type error:` synthetic → outputTail contains the offending line.

- [X] **T012** [P] [US1] Update `packages/orchestrator/src/worker/__tests__/stage-comment-manager.test.ts`. Per data-model.md §Test-suite touchpoints and contracts §stage-comment-manager.test.ts: rewrite every `.stderrTail` fixture field → `.outputTail`; rewrite every `stderr (last` assertion → `output (last`. Update the empty fixture from `(stderr empty)` to `(no output on either stream)`. Add both-empty explicit fixture: `outputTail: '(no output on either stream)'` renders inside the fenced block; the rendered alert text contains no substring `(empty)` (SC-003 scan). Backtick-poisoned fixture assertion unchanged.

## Phase 8: Verification

- [X] **T013** [US1] [US2] Run rename-completeness greps per quickstart.md §Commands recap. `grep -rn "stderrTail\|(stderr empty)\|boundStderrTail\|stderr (last" packages/orchestrator/src` MUST return zero non-comment hits. `grep -rn "outputTail\|(no output on either stream)\|boundOutputTail\|output (last" packages/orchestrator/src` MUST cover all rename sites. Any leftover reference is a real bug — fix in this same change, not a follow-up.

- [X] **T014** [US1] [US2] Run the affected unit test suites per quickstart.md §Run the affected unit tests: `pnpm --filter '@generacy-ai/orchestrator' test --run src/worker/__tests__/output-tail.test.ts src/worker/__tests__/output-tail-synthesis.test.ts src/worker/__tests__/cli-spawner.test.ts src/worker/__tests__/phase-loop.test.ts src/worker/__tests__/stage-comment-manager.test.ts`. All five suites must pass. Also run `pnpm --filter '@generacy-ai/orchestrator' build` to verify TypeScript types across the whole worker package resolve against the renamed shape.

## Dependencies & Execution Order

**Sequential foundation** (T001 → T002 → T003 → T004 → T005 → T006 → T007):
- T001 (types.ts rename) blocks everything — no downstream file compiles until the shape lands.
- T002 (bounder rename) must precede T003 (synthesizer imports the bounder) and T005 (evidence builder imports the bounder).
- T003 (synthesizer) must precede T005 (evidence builder imports it).
- T004 (ring buffer in cli-spawner.ts) is independent of T002/T003 in principle, but it writes into `PhaseResult.error.output`, which is the T001-renamed field. Order after T001.
- T005 (evidence builder) depends on T001, T002, T003.
- T006 (synthesized-PhaseResult sites) is a mechanical rename in the same file as T005 — bundle with T005 to avoid churn.
- T007 (renderer) depends on T001 (reads `evidence.outputTail`).

**Parallel test updates** (T008, T009, T010, T011, T012):
- Once Phase 1–6 lands (source compiles cleanly), all five test-file updates are independent — they live in different files and share no state. Can run in parallel.

**Verification** (T013, T014):
- Sequential after all test updates. T013 (grep) catches missed renames; T014 (test run) proves behavior.

**Story mapping**:
- **US1 (operator triage)** touches every task — the whole rename exists to make the alert readable.
- **US2 (post-hoc diagnosis)** is served by T005 (persistence surface), T010 (real-subprocess capture proof), T011 (fixture proves capture happens at time of failure), T013–T014 (verification).

**Parallel opportunities**:
- Within Phase 7: 5 test files × 5 agents in parallel is possible if tooling supports it. In practice, one developer sequentially updates them faster than context-switching cost.

## Suggested Next Step

Run `/speckit:implement` to begin execution against this task list.

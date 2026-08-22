# Implementation Plan: Composed-loop integration coverage for review/remediate executors and gate-label resume

**Feature**: Composed-loop integration coverage that drives the *real* `ReviewExecutor` under `PhaseLoop` via a scripted spawnable agent CLI, validates gate resume through the real `LabelManager.onResumeStart`, and re-points clean-cycle / draft-ready assertions at the real executor + real poster.
**Branch**: `1168-severity-major-p2-test`
**Status**: Complete

## Summary

This is a **test-only** feature (severity major, P2). No production behavior changes ship
(spec Out of Scope; a ≤ small clearly-linked seam fix is acceptable only if a genuine
untestable seam is discovered). It closes the "seam passes, production fails" gap that let
three shipped defects escape four integration issues (#1155 phantom-clean, #1156 unwired
poster, #1154 resume label-strip) by composing the real executors and the real label-resume
path end-to-end so CI catches this defect class.

Three deliverables map to the three user stories:

- **US1 (FR-001..FR-005)** — a new integration suite composes the real `ReviewExecutor`
  inside `PhaseLoop`, driven by a **real spawnable scripted agent-CLI fixture** (a Node
  script run via `child_process.spawn(process.execPath, [fixturePath], …)`) reached through a
  lightweight *spawning* `AgentLauncher` test double. The fixture writes (or withholds) the
  review **candidate** sidecar so the engine recomputes the authoritative verdict from
  findings + `blockingSeverity` and the loop acts on the recomputed verdict — never the
  candidate's claimed one. Severity gating, finding-status lifecycle across rounds, and the
  three executor failure paths are all asserted through the composed loop.
- **US2 (FR-006/FR-007)** — verify/extend the existing
  `phase-loop.resume-gates.integration.test.ts`, which already drives the real
  `LabelManager.onResumeStart` over a label-backed fake `GitHubClient` for the
  `remediation-limit` reset/re-arm and the terminal-no-op resume. No recompose with the real
  `ReviewExecutor` is needed for the gate-resume regression (clarification Q3→A).
- **US3 (FR-008)** — re-point the single-COMMENT-per-clean-cycle and draft/ready assertions
  at the real `ReviewExecutor` (spawned via the fixture) + real `ReviewPoster` composition
  against a recording **fake** `GitHubClient` (clarification Q4→A).

Retained unchanged (FR-009/FR-010): the executor unit suites, the cap-gate label-pair tests,
and the #1132 scripted convergence/cap suites — the latter repurposed as charter-contract
tests, not loop tests.

## Technical Context

- **Language/runtime**: TypeScript (ESM), Node ≥ 22, package `@generacy-ai/orchestrator`.
- **Test framework**: Vitest. Real process spawn via `node:child_process`, real filesystem,
  real git (`execFile`) for the isolated temp checkout; `mkdtemp` per-suite temp dirs; an
  isolated `HOME` / `GIT_CONFIG_GLOBAL` following the existing real-git integration pattern.
- **System under composition**: `PhaseLoop.executeLoop(context, config, deps, sequence)` with
  `PhaseLoopDeps.reviewExecutor` = a real `ReviewExecutor` constructed with a spawning
  `AgentLauncher` double; `getPhaseSequence(workflow, true)` + `reviewPhaseEnabled: true` gate
  `review` (and the off-sequence `remediate` seam) into the effective sequence.
- **Executor spawn seam**: `ReviewExecutor` reaches the child through a single injectable
  `agentLauncher.launch({ intent: { kind: 'review' } as ReviewIntent, cwd, env, credentials,
  provider })` and reads `handle.process` (a `ChildProcessHandle`:
  `stdin/stdout/stderr/pid/kill/exitPromise`). The verdict is recomputed by the engine via
  `computeVerdict(findings, blockingSeverity)` over `readCandidateFindings(...)`; there is no
  verdict-steering stub in the write/withhold path (SC-002).
- **Candidate handoff**: the agent writes the *candidate* sidecar at
  `<checkoutPath>/.generacy/review-candidate-<sanitized-workflowId>.json`
  (`getReviewCandidatePath`), `workflowId = ${owner}/${repo}#${issueNumber}`, sanitized
  `[^a-zA-Z0-9_-] → _`. The engine writes the authoritative artifact at
  `review-findings-<sanitized>.json`.
- **GitHub boundary** (Q4→A): `context.github` stays a recording **fake** `GitHubClient`
  across all these suites; US3 assertions inspect recorded `createReview` / ready / draft
  calls. Process spawn, filesystem, and git remain real.
- **Failure-path form** (Q2→A): only the write / withhold (missing-sidecar) scenarios use the
  real spawnable fixture. The timeout (SIGTERM→SIGKILL) and non-zero-exit paths reuse a
  mocked / hanging `ChildProcessHandle` with a tiny hand-constructed `phaseTimeoutMs`
  (bypassing the Zod `.min(60_000)` floor by not calling `.parse()`), mirroring
  `phase-loop.remediate-timeout.integration.test.ts`, so a genuinely-hanging real process
  never threatens the SC-006 CI budget.
- **Changeset**: none. Every modified/added file is under
  `packages/orchestrator/src/worker/__tests__/` (test-only), which the changeset gate exempts.
  The scripted-CLI fixture is a test fixture, not `src/` product code.

## Constitution Check

No `.specify/memory/constitution.md` exists in the repo → constitution check skipped.

## Project Structure

New and modified files (all under the orchestrator package; test-only):

```
packages/orchestrator/src/worker/__tests__/
  fixtures/
    scripted-review-cli.mjs                         # NEW — real spawnable agent-CLI fixture (FR-001)
  helpers/
    spawning-agent-launcher.ts                      # NEW — spawning AgentLauncher test double (Q1→A)
    review-composition-harness.ts                   # NEW — temp checkout + recording-fake github + deps builder
  phase-loop.review-composed.integration.test.ts    # NEW — US1: verdict recompute, severity gating, lifecycle, failures (FR-002..FR-005)
  phase-loop.review-clean.integration.test.ts       # MODIFY — US3: re-point at real ReviewExecutor + real ReviewPoster (FR-008)
  phase-loop.resume-gates.integration.test.ts       # VERIFY/EXTEND — US2: real onResumeStart, monitor-shape label apply (FR-006/FR-007)
  phase-loop.review-remediate-convergence.integration.test.ts  # REPURPOSE — charter-contract test, not loop test (FR-009)
  phase-loop.remediation-cap.integration.test.ts    # REPURPOSE — charter-contract test, not loop test (FR-009)
```

Unchanged "keep" list (FR-010):
`review-executor.test.ts`, `remediate-executor.test.ts`, and the cap-gate label-pair tests.

Design references (read-only, not modified):
`packages/orchestrator/src/worker/review-executor.ts`,
`packages/orchestrator/src/worker/review-artifact.ts`,
`packages/orchestrator/src/worker/phase-loop.ts`,
`packages/orchestrator/src/worker/label-manager.ts`,
`packages/orchestrator/src/worker/review-poster.ts`,
`packages/orchestrator/src/launcher/types.ts` (`AgentLaunchPlugin` / `LaunchHandle` /
`OutputParser`), `packages/orchestrator/src/worker/types.ts` (`ChildProcessHandle`).

## Dependencies

`#1161` (sub-blocking drop / finding-id match), `#1156` (review-poster wiring), `#1154`
(resume label-strip fix) are assumed merged to `develop`. If any is not yet on the branch
base, the corresponding acceptance criterion is deferred, not reworked (spec Assumptions).

## Phased Approach

1. **Fixture + double + harness** — build the spawnable `scripted-review-cli.mjs`, the
   spawning `AgentLauncher` double, and the temp-checkout / recording-fake-github harness.
2. **US1 composed suite** — verdict recomputation (#1155 regression), severity-gating
   boundaries, finding-status lifecycle across rounds (#1161), and the three failure paths.
3. **US3 re-point** — swap `phase-loop.review-clean`'s findings-steering lever for the real
   executor + real poster; keep the recording-fake `GitHubClient` assertions.
4. **US2 verify/extend** — confirm the resume-gates suite exercises the real `onResumeStart`;
   extend it to apply `completed:*` via the monitor's exact mutation shape.
5. **FR-009 repurpose** — reframe the #1132 convergence/cap suites as charter-contract tests.
6. **Green + budget** — full `pnpm --filter @generacy-ai/orchestrator test`; confirm no CI
   wall-clock regression (SC-005/SC-006).

## Next step

`/speckit:tasks` to generate the task list.

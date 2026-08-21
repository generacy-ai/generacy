# Research: Composed-loop integration coverage (#1168)

All decisions are test-methodology decisions; no production code changes. Line refs at
develop `155b3464`.

## Decision 1 — How the scripted CLI reaches the real `ReviewExecutor`

**Chosen (clarification Q1→A)**: inject a lightweight `AgentLauncher` test double whose
`launch()` **really spawns** the fixture via
`child_process.spawn(process.execPath, [fixturePath], { cwd, env })` and returns a real
`ChildProcessHandle` (`stdin/stdout/stderr/pid/kill/exitPromise` from the spawned child).
`ReviewExecutor` and verdict recomputation stay real (SC-002).

**Rationale**: the executor reaches the child through a single injectable seam
(`agentLauncher.launch({ intent: { kind: 'review' } })`, `review-executor.ts:203`), so a
spawning double keeps the executor and `computeVerdict` fully real with the smallest surface.

**Rejected (Q1 option B)**: drive the production `AgentLauncher` + claude-code launch plugin
with the resolved provider binary redirected to the fixture. Out of scope for a test-only
feature — it would exercise the full plugin intent-resolution path we are not regressing.

**Contract**: the double must return a `LaunchHandle`-shaped object
(`{ process, outputParser, metadata }`, `launcher/types.ts:248`). The executor only reads
`handle.process`; `outputParser`/`metadata` may be minimal stubs. Details in
`contracts/spawning-agent-launcher-double.md`.

## Decision 2 — Form of the timeout and non-zero-exit failure paths

**Chosen (clarification Q2→A)**: real spawn only for the write / withhold (missing-sidecar)
scenarios. Timeout (SIGTERM→SIGKILL) and non-zero-exit reuse a mocked / hanging
`ChildProcessHandle` with a tiny hand-constructed `phaseTimeoutMs` (e.g. `20`) +
`shutdownGracePeriodMs` (e.g. `10`), matching `phase-loop.remediate-timeout.integration.test.ts`.

**Rationale**: both `phaseTimeoutMs` and the per-`review` override carry a Zod `.min(60_000)`
floor (`config.ts:154,145`), so a sub-60s timeout is only reachable by hand-constructing the
`WorkerConfig` object (bypassing `.parse()`) — which the remediate-timeout suite already does.
A genuinely-hanging real process would cost ≥ 60s and threaten the SC-006 CI budget. All three
failure paths still yield distinct asserted loop outcomes (SC-004):
- (a) **missing sidecar**: fixture exits 0 but writes no candidate → `readCandidateFindings`
  returns `null` → no-verdict round (never `clean`); executor persists nothing.
- (b) **timeout**: hanging handle → SIGTERM then SIGKILL after grace; executor returns
  `success:false, exitCode:-1`-style outcome.
- (c) **non-zero exit**: handle resolves `exitPromise` non-zero → failure gate persists
  nothing.

**Rejected (Q2 option B)**: all three via a real hanging/exiting process — CI-budget risk.

## Decision 3 — The real/mock boundary for GitHub interactions

**Chosen (clarification Q4→A)**: `context.github` stays a recording **fake** `GitHubClient`
(no live `gh`). US3 assertions inspect recorded `createReview` / ready / draft calls. Process
spawn, filesystem, and git remain real.

**Rationale**: every existing orchestrator integration suite records against a fake
`GitHubClient`. The "real poster" wiring US3/FR-008 exercises is the
`ReviewExecutor`→`ReviewPoster`→`context.github` composition, which a recording fake validates
fully without network / auth / CI-budget risk. The recording-fake shape is the `createGithubSpy`
in `phase-loop.review-clean.integration.test.ts` (returns empty `listReviews` /
`listPullRequestFiles` / `getPRReviewThreads`, captures `createReview`).

**Rejected (Q4 option B)**: real `gh` against a fixture/local repo — network/auth/budget risk,
diverges from every existing suite.

## Decision 4 — Scope of the US2 gate-resume coverage

**Chosen (clarification Q3→A)**: the existing `phase-loop.resume-gates.integration.test.ts`
already satisfies FR-006/FR-007. US2 only verifies/extends it (e.g. applying the label via the
monitor's exact mutation shape); no recompose with the real `ReviewExecutor` is required.

**Rationale**: that suite already constructs a real `LabelManager` over a label-backed fake
`GitHubClient` (shared mutable `Set`), applies `completed:remediation-limit`, calls the real
`onResumeStart()`, and asserts label survival + counter reset + terminal-no-op — precisely the
#1154 regression. Label-resume is orthogonal to executor verdict logic. Deleting the #1154
`isHumanGateCompletion` guard must make it fail (SC-003).

**Rejected (Q3 option B)**: drive the gate→pause→resume cycle end-to-end with a real
`ReviewExecutor`-driven loop — unnecessary coupling for a label-strip regression.

## Decision 5 — Repurposing the #1132 convergence/cap suites (FR-009)

**Chosen**: keep the two suites but reframe them as **charter-contract** tests — asserting the
prompt/charter shape and the merge contract (`advanceArtifact` finding carry-over / sub-blocking
drop), not loop composition. This retains their coverage without masquerading as composed-loop
coverage (which US1 now owns for real). Do not delete or rewrite them beyond this reframing
(spec Out of Scope).

## Decision 6 — Isolated real-spawn/real-git environment

**Chosen**: per-suite `mkdtemp` checkout containing `.generacy/`, an isolated `HOME` and
`GIT_CONFIG_GLOBAL` pointed at the temp dir, following the existing real-git integration-test
pattern (`review-executor.test.ts` #1131 block uses `initRepoWithCommits`). The fixture writes
to the canonical candidate path under that checkout using the same `workflowId` the executor
derives, so the engine reads what the fixture wrote.

## Open risk

If #1161/#1156/#1154 are not on the branch base at implement time, defer the dependent
acceptance criterion (sub-blocking drop; poster re-point; resume label-strip) rather than
reworking — the fixture/double/harness are dependency-agnostic and land regardless.

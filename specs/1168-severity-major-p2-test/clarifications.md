# Clarifications

## Batch 2026-08-21

### Q1: Scripted-CLI launcher wiring
**Context**: FR-001/SC-002 require the *real* `ReviewExecutor` composed with `PhaseLoop`, spawning a real fixture that writes/withholds the sidecar. `ReviewExecutor` reaches the child via an injectable `agentLauncher.launch({ intent: { kind: 'review' } })` (`review-executor.ts:203`). Assumption 4 says the launcher "can be pointed at the scripted fixture binary via existing intent/plugin wiring." There are two ways to keep `ReviewExecutor` real while spawning the fixture, and they differ a lot in effort and blast radius.
**Question**: How should the scripted CLI fixture be spawned into the real `ReviewExecutor`?
**Options**:
- A: Inject a lightweight `AgentLauncher` test double whose `launch()` **really spawns** the fixture (e.g. `child_process.spawn(process.execPath, [fixturePath], …)`) and returns a real `ChildProcessHandle`. `ReviewExecutor`/verdict logic stay real; not a verdict-steering stub (SC-002 satisfied). Simplest, smallest surface.
- B: Drive the **real production `AgentLauncher` + claude-code launch plugin**, redirecting the resolved provider binary to the fixture via env/config so the full plugin intent-resolution path is exercised too.

**Answer**: A — Inject a lightweight `AgentLauncher` test double whose `launch()` really spawns the fixture (e.g. `child_process.spawn(process.execPath, [fixturePath], …)`) and returns a real `ChildProcessHandle`; `ReviewExecutor`/verdict logic stay real. Rationale: the executor reaches the child through a single injectable seam, so a spawning test-double keeps the executor and verdict recomputation fully real (SC-002) with the smallest surface; driving the production launcher + plugin is out of scope for a test-only feature.

### Q2: Form of the timeout and non-zero-exit failure paths
**Context**: FR-005/SC-004 require three distinct failure outcomes: (a) missing sidecar, (b) timeout → SIGTERM→SIGKILL, (c) non-zero exit. FR-001 scopes the real spawnable fixture to "at least the write/withhold sidecar scenarios." Both `phaseTimeoutMs` and the per-`review` override carry a Zod `.min(60_000)` floor (`config.ts:154,145`), so a sub-60s timeout is only reachable by hand-constructing the `WorkerConfig` object (bypassing `.parse()`) — which the existing `phase-loop.remediate-timeout.integration.test.ts` already does (`phaseTimeoutMs: 20` + a *mocked* hanging `ChildProcessHandle`). A genuinely-hanging real process risks the SC-006 CI time budget.
**Question**: Do the timeout (b) and non-zero-exit (c) paths need the real spawnable fixture, or may they reuse a mocked/hanging `ChildProcessHandle`?
**Options**:
- A: Real spawn only for the write/withhold(missing-sidecar) scenarios (a). Timeout (b) and non-zero-exit (c) reuse a mocked/hanging `ChildProcessHandle` with a tiny hand-constructed `phaseTimeoutMs`, matching the existing remediate-timeout pattern. Cheapest, no CI-budget risk.
- B: All three failure paths, including timeout, use the real spawnable fixture (a process that truly hangs until SIGKILL, and one that truly exits non-zero).

**Answer**: A — Real spawn only for the write/withhold (missing-sidecar) scenarios; the timeout and non-zero-exit paths reuse a mocked/hanging `ChildProcessHandle` with a tiny hand-constructed `phaseTimeoutMs`, matching the existing remediate-timeout pattern. Rationale: FR-001 scopes the real fixture to write/withhold scenarios, and the `.min(60_000)` Zod floor means a genuinely-hanging real process would cost ≥60s and threaten the SC-006 CI budget; the mocked-handle pattern still yields three distinct asserted outcomes.

### Q3: Scope of the US2 gate-resume coverage
**Context**: `phase-loop.resume-gates.integration.test.ts` **already** constructs a real `LabelManager` over a fake `GitHubClient` (label `Set`), applies `completed:remediation-limit`, calls the real `LabelManager.onResumeStart()`, and asserts survival + counter reset + terminal-no-op (`SC-001`/`SC-002` in that file) — i.e. FR-006/FR-007's exact regression for #1154, using the real resume path (not injected surviving labels). US2 could therefore already be met.
**Question**: What does FR-006/FR-007 require beyond the existing resume-gates test?
**Options**:
- A: The existing `phase-loop.resume-gates.integration.test.ts` satisfies FR-006/FR-007. US2 only verifies/extends it (e.g. label applied via the monitor's exact mutation shape); no recompose with the real `ReviewExecutor` is needed for the gate-resume regression.
- B: FR-006/FR-007 must additionally drive the gate → pause → `completed:*` → resume cycle with a **real `ReviewExecutor`-driven loop** end-to-end (not stubbed executors).

**Answer**: A — The existing `phase-loop.resume-gates.integration.test.ts` satisfies FR-006/FR-007; US2 only verifies/extends it (e.g. label applied via the monitor's exact mutation shape); no recompose with the real `ReviewExecutor` is needed. Rationale: that suite already constructs a real `LabelManager` over a fake `GitHubClient`, applies `completed:remediation-limit`, calls the real `onResumeStart()`, and asserts label survival + counter reset + terminal-no-op — precisely the #1154 regression. Label-resume is orthogonal to executor verdict logic.

### Q4: The "real" boundary for GitHub interactions (US3 poster/draft-ready)
**Context**: US3/FR-008 assert "exactly one COMMENT-event review via the real poster" and PR draft/ready flips driven by a real verdict. `ReviewPoster` and `PrManager` reach GitHub through `context.github` (a `GhCliGitHubClient` in prod). Every existing orchestrator integration suite uses a fake/recording `GitHubClient`, never live `gh`. "Real poster" is ambiguous about where the real/mock boundary sits.
**Question**: Where does the real/mock boundary sit for these composed-loop suites?
**Options**:
- A: `context.github` stays a recording **fake** `GitHubClient` (no live `gh`); US3 assertions inspect recorded `createReview`/ready/draft calls on that fake. Process spawn, filesystem, and git remain real. (Matches every existing integration suite.)
- B: Use a real `gh` against a fixture/local repo so the actual GitHub CLI path is exercised.

**Answer**: A — `context.github` stays a recording fake `GitHubClient` (no live `gh`); US3 assertions inspect recorded `createReview`/ready/draft calls; process spawn, filesystem, and git remain real. Rationale: every existing orchestrator integration suite records against a fake `GitHubClient`; the "real poster" wiring US3/FR-008 exercises is the `ReviewExecutor`→`ReviewPoster`→`context.github` composition, which a recording fake validates fully without network/auth/CI-budget risk.

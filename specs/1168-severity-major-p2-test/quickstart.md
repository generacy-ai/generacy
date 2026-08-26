# Quickstart: Composed-loop integration coverage (#1168)

Test-only feature. Everything below runs under the orchestrator package; no
product code ships and no changeset is required (the suites and fixtures all live
under `packages/orchestrator/src/worker/__tests__/`, which the changeset gate exempts).

## Run the suites

```bash
# whole orchestrator suite (SC-005/SC-006 budget check)
pnpm --filter @generacy-ai/orchestrator test

# just the new composed-loop suite (US1)
pnpm --filter @generacy-ai/orchestrator test phase-loop.review-composed

# US3 re-point (real executor + real poster)
pnpm --filter @generacy-ai/orchestrator test phase-loop.review-clean

# US2 gate-resume (verify/extend)
pnpm --filter @generacy-ai/orchestrator test phase-loop.resume-gates
```

## How the composed suite is wired

1. **Temp checkout** — the harness `mkdtemp`s a real checkout containing
   `.generacy/`, with an isolated `HOME` / `GIT_CONFIG_GLOBAL` pointed at the temp
   dir (the existing real-git integration pattern). `workflowId = ${owner}/${repo}#${issueNumber}`.
2. **Real `ReviewExecutor`** — built with a *spawning* `AgentLauncher` double
   (`helpers/spawning-agent-launcher.ts`) and injected as
   `PhaseLoopDeps.reviewExecutor`. No verdict-steering stub; no
   `readFindingsArtifact` seam (SC-002).
3. **Scripted CLI fixture** — the double's `launch()` really spawns
   `fixtures/scripted-review-cli.mjs` via
   `child_process.spawn(process.execPath, [fixturePath], { cwd, env })`. Per-scenario
   env (`FIXTURE_MODE`, `FIXTURE_CANDIDATE_JSON`, `FIXTURE_CHECKOUT_PATH`,
   `FIXTURE_WORKFLOW_ID`) is closed over by the harness.
4. **Candidate → engine recompute** — the fixture writes the *candidate* sidecar
   (`.generacy/review-candidate-<sanitized>.json`); the engine reads it via
   `readCandidateFindings`, **ignores any agent-claimed `verdict`**, and recomputes
   the authoritative verdict from findings + `blockingSeverity`
   (`computeVerdict`) — this is the #1155 regression lever (SC-001).
5. **GitHub** — `context.github` is a recording **fake** `GitHubClient` (no live
   `gh`). US3 assertions inspect recorded `createReview` / ready / draft calls.

## Failure paths (no real spawn)

Timeout (SIGTERM→SIGKILL) and non-zero-exit scenarios do **not** use the fixture.
They inject a mocked / hanging `ChildProcessHandle` with a hand-constructed tiny
`phaseTimeoutMs` (e.g. `20`) + `shutdownGracePeriodMs` (e.g. `10`) — the
`WorkerConfig` is built by hand (not `.parse()`d) to bypass the Zod `.min(60_000)`
floor, mirroring `phase-loop.remediate-timeout.integration.test.ts`. No genuinely
hanging real process is ever spawned (SC-006 CI budget).

## SC-002 verification

Grep the new suite to confirm the real executor is composed with no steering stub:

```bash
rg "new ReviewExecutor\(" packages/orchestrator/src/worker/__tests__/phase-loop.review-composed.integration.test.ts
rg "readFindingsArtifact" packages/orchestrator/src/worker/__tests__/phase-loop.review-composed.integration.test.ts   # expect: no verdict-steering seam
```

## Troubleshooting

- **Fixture path not found** — the double resolves the fixture relative to
  `helpers/`; confirm `fixtures/scripted-review-cli.mjs` exists and is executable
  by `process.execPath` (it is run as `node <path>`, no execute bit needed).
- **Candidate not read** — the fixture must derive the candidate path from
  `FIXTURE_WORKFLOW_ID` with the same `[^a-zA-Z0-9_-] → _` sanitization the engine
  uses; a mismatch yields a missing-sidecar (no-verdict) round.
- **Real git failures** — ensure the harness set `HOME` and `GIT_CONFIG_GLOBAL`
  to the temp dir so `git commit` has an identity.

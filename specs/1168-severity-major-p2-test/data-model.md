# Data Model: Composed-loop integration coverage (#1168)

No production entities change. This documents the **test-artifact shapes** the new suites
produce and consume, all mirrored from shipped production code (read-only references).

## Candidate sidecar (agent-written; the fixture's output)

Written by the scripted CLI fixture to
`<checkoutPath>/.generacy/review-candidate-<sanitized-workflowId>.json`
(`getReviewCandidatePath`, `review-artifact.ts:120`). `workflowId = ${owner}/${repo}#${issueNumber}`,
sanitized `[^a-zA-Z0-9_-] → _`.

Governed by the lenient `CandidateArtifactSchema` (`review-artifact.ts:372`) — the engine reads
it via `readCandidateFindings(checkoutPath, workflowId, round)` and **ignores any agent-claimed
top-level `verdict`/`round`** (FR-007 / #1155):

```jsonc
{
  "findings": [
    {
      "severity": "critical" | "major" | "minor",   // required
      "file": "packages/…/foo.ts",                   // required, non-empty
      "line": 42,                                     // optional, positive int
      "title": "…",                                   // required, non-empty
      "detail": "…",                                  // required, non-empty
      "round": 1,                                      // optional (engine stamps authoritative round)
      "status": "open" | "resolved"                  // optional (defaults to "open")
    }
  ]
}
```

Fixture behaviors driven by env/argv (see `contracts/scripted-cli-fixture.md`):
- **write**: emit a candidate with a specified findings array (may claim `verdict: clean`
  while carrying an open blocking finding — the #1155 lever).
- **withhold**: exit 0 without writing the candidate → missing-sidecar failure path.

## Engine-authoritative artifact (engine-written; the assertion target)

Written by `ReviewExecutor` to `review-findings-<sanitized-workflowId>.json`
(`getReviewArtifactPath`), governed by the strict `ReviewArtifactSchema`
(`review-artifact.ts:69`). The recomputed `verdict` here — not the candidate's claim — is what
the loop acts on:

```jsonc
{
  "findings": [ { "id", "severity", "file", "line?", "title", "detail", "round", "status" } ],
  "verdict": "clean" | "changes-required",   // computeVerdict(findings, blockingSeverity)
  "round": 1,                                 // positive int, monotonic
  "lastReviewedCommitSha": "…",
  "remediationCount": 0,                       // default 0
  "markedReadyByEngine": false                 // default false
}
```

Verdict rule (`computeVerdict`, `review-artifact.ts:437`): `changes-required` iff ≥ 1 finding
is `status:'open'` AND `SEVERITY_RANK[severity] >= SEVERITY_RANK[blockingSeverity]`
(`critical:3 > major:2 > minor:1`); else `clean`.

## Composed `PhaseLoopDeps` (US1 / US3 wiring)

The suite builds `PhaseLoopDeps` with the **real** executor and (US3) the **real** poster:

- `reviewExecutor`: `new ReviewExecutor({ agentLauncher: <spawning double>, config, settings,
  logger })` — no verdict-steering stub (SC-002).
- `reviewPoster` (US3): `new ReviewPoster({ github: <recording fake>, owner, repo,
  getPrNumber, logger })`.
- `labelManager`, `stageCommentManager`, `gateChecker`, `cliSpawner`, `outputCapture`,
  `prManager`: mock doubles as in the existing suites (non-review phases short-circuit to
  success).
- `readFindingsArtifact`: **absent** for US1/US3 real composition — the engine writes and reads
  the sidecar itself; injecting it would re-introduce the steering seam this feature removes.

## Config for the composed suite

Hand-constructed `WorkerConfig` (not `.parse()`d) so failure-path timeouts bypass the Zod
`.min(60_000)` floor:
- write/withhold path: normal `phaseTimeoutMs` (e.g. `600_000`), `reviewPhaseEnabled: true`.
- timeout path: `phaseTimeoutMs: 20`, `shutdownGracePeriodMs: 10`, `reviewPhaseEnabled: true`.
- `blockingSeverity` per-scenario (default `critical`; `major` for the all-minor-clean and
  single-critical-changes-required boundary cases).

## Severity-gating truth table (FR-003 assertions)

| findings (status:severity) | blockingSeverity | verdict            |
|----------------------------|------------------|--------------------|
| all `open:minor`           | `major`          | `clean`            |
| one `open:critical`        | `major`          | `changes-required` |
| one `open:major`           | `critical`       | `clean`            |
| one `open:critical`        | `critical`       | `changes-required` |
| one `resolved:critical`    | `critical`       | `clean`            |

## Finding-status lifecycle across rounds (FR-004 assertions)

- an `open` finding at round 1 that the agent marks `resolved` is carried over as `resolved`
  at round 2 (carry-over via the engine merge);
- a sub-blocking finding is dropped at round ≥ 2 (per #1161 finding-id match).

# Contract: Scripted agent-CLI fixture (FR-001 / SC-002)

A **real spawnable** Node script — the first such fixture in the repo — that stands in for the
review agent's CLI. Run via `child_process.spawn(process.execPath, [fixturePath], { cwd, env })`
by the spawning `AgentLauncher` double (`contracts/spawning-agent-launcher-double.md`). Scoped
to the write / withhold (missing-sidecar) scenarios only (Q2→A); timeout and non-zero-exit paths
use a mocked hanging `ChildProcessHandle`, not this fixture.

Location: `packages/orchestrator/src/worker/__tests__/fixtures/scripted-review-cli.mjs`.

## Inputs

The fixture is parameterized per scenario via environment variables set on the spawn:

| Env var                       | Meaning                                                                 |
|-------------------------------|-------------------------------------------------------------------------|
| `FIXTURE_CHECKOUT_PATH`       | Absolute checkout root (the temp dir); candidate written under its `.generacy/`. |
| `FIXTURE_WORKFLOW_ID`         | `${owner}/${repo}#${issueNumber}` — must match the executor's derivation so paths agree. |
| `FIXTURE_MODE`                | `write` \| `withhold`.                                                   |
| `FIXTURE_CANDIDATE_JSON`      | (mode `write`) the exact candidate JSON body to write (a `{ findings: [...] }` object, may claim a bogus top-level `verdict`). |

`cwd` is the checkout path; the fixture derives the candidate path the same way the engine does
(sanitize `FIXTURE_WORKFLOW_ID` with `[^a-zA-Z0-9_-] → _`, join
`.generacy/review-candidate-<sanitized>.json`).

## Behavior

- **`write`**: `mkdir -p` the `.generacy` dir, write `FIXTURE_CANDIDATE_JSON` verbatim to the
  candidate path (atomic temp+rename or plain write — the engine only reads after exit), then
  `process.exit(0)`.
- **`withhold`**: write nothing; `process.exit(0)`. Drives the missing-sidecar failure path —
  `readCandidateFindings` returns `null`, a no-verdict round (never `clean`).

## Outputs / contract guarantees

- Exit code `0` in both modes (a clean-exit-but-no-artifact is exactly the missing-sidecar
  scenario the engine must handle).
- On `write`, the file at the canonical candidate path parses under `CandidateArtifactSchema`;
  the engine's `computeVerdict` over the recomputed findings — **not** any `verdict` the JSON
  claims — decides the loop's path (#1155 regression: a candidate claiming `verdict: clean`
  with an open blocking finding yields a `changes-required` loop path — SC-001).
- Writes only within `FIXTURE_CHECKOUT_PATH`; no network, no stdout contract (the engine reads
  the file, not the stream).

## Why a real spawn (not a mocked handle) here

SC-002 requires the real `ReviewExecutor` composed with `PhaseLoop` via a real spawn with no
verdict-steering stub. The write/withhold path is cheap (the fixture exits immediately), so it
carries no CI-budget risk while proving the full spawn → candidate-file → engine-read →
recompute → loop-act chain end-to-end.

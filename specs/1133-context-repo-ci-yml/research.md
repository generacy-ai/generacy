# Research: CI-aware merge readiness (#1133)

## Decision 1 — Where the CI readout lives

**Decision**: Add a new `getCiRunsForSha(owner, repo, headSha, branch)` method to `GhCliGitHubClient` (`packages/workflow-engine/src/actions/github/client/gh-cli.ts`), declared on the `GitHubClient` interface.

**Rationale**: The worker's phase loop resolves GitHub state through the injected `context.github` (a `GhCliGitHubClient` that shells out to `gh`/`gh api`). The octokit-based `@generacy-ai/github-actions` package (`packages/github-actions/src/operations/runs.ts`) is **not** a dependency of `@generacy-ai/orchestrator` and its `listWorkflowRuns` is per-workflow only (requires a workflow id/name) — it cannot produce a repo-wide, head-SHA-scoped rollup. Adding a `gh api` method mirrors the existing `getRefHeadSha` / `prDiffNames` methods and needs no new dependency.

**Alternatives considered**:
- *Depend on `@generacy-ai/github-actions`* — rejected: adds a cross-package dependency, still needs a repo-wide list the package doesn't expose, and requires an octokit client the worker doesn't construct.
- *Direct `fetch` to the REST API* — rejected: bypasses the `gh` auth/token plumbing the JIT git credential helper and monitors already rely on.

## Decision 2 — Primary vs fallback readout

**Decision**: Primary = `gh api repos/{owner}/{repo}/commits/{headSha}/check-runs`. Fallback (on non-zero exit, which is what a token lacking `checks:read` produces) = `gh api "repos/{owner}/{repo}/actions/runs?branch={branch}"`, filtered client-side to `head_sha === headSha`. Both map through the same pure `aggregateCiVerdict`.

**Rationale**: FR-002 names `actions/runs?branch=` as the known-working readout when the check-runs API is unavailable/token-limited. Routing both paths through one aggregation function makes SC-004 (identical verdict) true by construction — the fallback differs only in *how runs are fetched*, not in *how they're judged*.

**Implementation note**: `check-runs` returns `{ check_runs: [{ status, conclusion }] }`; `actions/runs` returns `{ workflow_runs: [{ head_sha, status, conclusion }] }`. `getCiRunsForSha` normalizes both to `CiRun { status, conclusion }` before aggregation. Use `--jq` to project the fields (mirrors `getRefHeadSha`).

## Decision 3 — Three-state verdict aggregation (Q2-C)

**Decision**: `aggregateCiVerdict(runs)` returns `'green' | 'pending' | 'not-passed'`:
- Ignore any run whose conclusion is `skipped` or `neutral`.
- `not-passed` if any remaining run has a terminal non-success conclusion (`failure`, `cancelled`, `timed_out`, `action_required`).
- `green` if ≥1 remaining run is `success` AND none are terminal-non-success AND none are in-progress (`status !== 'completed'` / `conclusion === null`).
- `pending` otherwise — covers all-skipped, no-runs, and "some in-progress, none failed".

**Rationale**: Encodes skipped≠passed (SC-001). A PR whose CI was entirely skipped yields `pending` (not `green`), so it waits then times out into the resumable pause — it never reaches the gate. The "≥1 success" requirement prevents an empty/all-skipped set from ever reading green.

**Truth table** (see contracts/ci-verdict.md for the full matrix):

| Non-skipped runs | Verdict |
|---|---|
| none (empty or all skipped/neutral) | pending |
| ≥1 success, no failures, none in-progress | green |
| any failure/cancelled/timed_out/action_required | not-passed |
| any in-progress, no failures | pending |

## Decision 4 — Bounded-backoff CI wait (Q1-C, Q3-A, FR-004)

**Decision**: On `validate` success with verdict `pending`, `waitForCiGreen` polls `evaluateCiReadiness` with exponential backoff (e.g. 5s → 10s → 20s → cap 30s) until verdict resolves or the elapsed time hits `ciWaitTimeoutMs`. On `green` → proceed to gate. On `not-passed` → treat as validate/merge not ready (surfaced like a failed readiness, does not raise the approval gate). On timeout → pause with `waiting-for:ci` + `agent:paused`; never declares green.

**Rationale**: "No CI run found" is indistinguishable from "CI not started yet" at the API, so Q3-A treats it as `pending` — the unmigrated-repo case (US4) converges on the same timeout pause rather than a distinct escalation. Exponential backoff satisfies SC-005 (no busy loop). `ciWaitTimeoutMs` is a per-workflow-configurable ceiling with a 15-min default.

**Alternatives considered**:
- *Fixed poll interval* — rejected: either wastes API calls (too fast) or is unresponsive (too slow); backoff is explicitly required.
- *Fail-fast on no-run* (Q3-B) — rejected by clarification: would misfire on the legitimate "CI hasn't started" race.

## Decision 5 — Terminal / no-op resume for the satisfied post-validate gate (FR-006)

**Context**: `validate` is the last phase in the sequence. `PhaseResolver.resolveStartPhase` returns a `WorkflowPhase`; `executeLoopInner` throws on an unknown phase (`phase-loop.ts:323`) and executes from `startIndex` to the end. So naively mapping `implementation-review.resumeFrom = 'validate'` under the flag re-runs `validate` on resume — which FR-006 forbids.

**Decision**: When `ciMergeGateEnabled` is ON and the most-advanced satisfied gate is `implementation-review`, the resume is a **no-op terminal**: `resolveStartPhase` returns the last phase (`validate`) as the resume target, and `executeLoopInner` short-circuits to `{ completed: true }` without executing the phase body when it re-enters at `validate` on a `continue` command carrying both `completed:validate` and `completed:implementation-review`. This makes `startIndex` effectively past the work — neither `validate` nor `implement` re-runs. The gate answer plus `completed:validate` yields the merge-eligible state cockpit / `cockpit_merge` consume (FR-007).

**Rationale**: Keeps the resolver's return type a real `WorkflowPhase` (no fake sentinel phase leaking into every `Record<WorkflowPhase, …>` site), and localizes the no-op to a single guard at loop entry. Cockpit already treats `completed:validate` as terminal (`TERMINAL_COMPLETED_LABELS` in cockpit `label-map.ts`), so the merge-eligible surface is unchanged.

**Alternatives considered**:
- *Add a synthetic terminal `WorkflowPhase` member* — rejected: forces edits at every exhaustive `Record<WorkflowPhase, …>` / Zod-enum / union site (the same broad-vocabulary surface #1121 had to touch) for a phase that never executes.
- *Do not requeue the worker at all on implementation-review satisfaction* — rejected: the label-monitor requeue path is shared machinery; suppressing it for one gate is more invasive than a loop-entry guard.

## Decision 6 — New independent flag, mirrored threading (Q5-B)

**Decision**: `ciMergeGateEnabled` is a new boolean, independent of `reviewPhaseEnabled`. Threaded exactly like `reviewPhaseEnabled`: env `WORKER_CI_MERGE_GATE_ENABLED` (+ prefixed variant) read in `config/loader.ts` → `WorkerConfigSchema.ciMergeGateEnabled` default `false` → passed into `phaseResolver.resolveStartPhase` from `claude-cli-worker.ts` → threaded through `resolveFromContinue`/`resolveFromProcess`/`getEffectiveGateMapping` → consumed in `phase-loop.ts`. `ciWaitTimeoutMs` rides the same env/config path.

**Rationale**: FR-009/SC-006 demand byte-identical behavior when disabled and explicitly forbid coupling to `reviewPhaseEnabled`. The mirror keeps the flag surface familiar and the OFF path a strict no-op.

## Decision 7 — Label vocabulary

**Decision**: Add `waiting-for:ci` (color `FBCA04`, matching the other `waiting-for:*` gates) and `completed:ci` (color `0E8A16`, matching the other `completed:*` labels) to `label-definitions.ts`. New label vocabulary in `workflow-engine` → `minor` bump per CLAUDE.md.

**Rationale**: The timeout pause needs a distinct `waiting-for:ci` so operators (and cockpit) can distinguish a CI-stall from a review pause; `completed:ci` records satisfaction for resume detection consistency.

## Sources

- `packages/orchestrator/src/worker/phase-resolver.ts` — `GATE_MAPPING`, `resolveStartPhase` threading.
- `packages/orchestrator/src/worker/config.ts` — `GateDefinitionSchema`, `WorkerConfigSchema`, gates default.
- `packages/orchestrator/src/worker/phase-loop.ts` — validate execution, gate-check loop, loop-entry guard.
- `packages/orchestrator/src/config/loader.ts:241-249` — `reviewPhaseEnabled` env-read precedent.
- `packages/workflow-engine/src/actions/github/client/gh-cli.ts:1637` — `getRefHeadSha` (gh api + --jq precedent).
- `packages/workflow-engine/src/actions/github/label-definitions.ts:37,46` — label shape precedent.
- `packages/github-actions/src/operations/runs.ts` — octokit run mapping (reference for conclusion semantics; NOT a dependency).
- Clarifications Q1-C / Q2-C / Q3-A / Q4-A / Q5-B.

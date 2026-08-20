# Implementation Plan: Merge readiness — CI skipped≠passed, validate/CI parallel semantics, post-validate approval gate

**Feature**: Make merge readiness require both `validate` success (worker) and CI actually green on the ready PR (GitHub), running in parallel and raising the `implementation-review` gate only once both are green.
**Branch**: `1133-context-repo-ci-yml`
**Issue**: [generacy-ai/generacy#1133](https://github.com/generacy-ai/generacy/issues/1133) | **Epic**: [#1120](https://github.com/generacy-ai/generacy/issues/1120)
**Status**: Complete

## Summary

Today a speckit worker treats a PR as merge-ready the moment the `validate` phase succeeds. Repo `ci.yml` workflows skip draft PRs, and a **skipped** / **neutral** run reads as SUCCESS in naive status rollups, so a PR whose CI never executed can pass the final gate. The cluster token also lacks `checks:read` in some setups, so the check-runs API is unreliable; `actions/runs?branch=` is the known-working fallback.

This feature adds engine-side CI merge-readiness evaluation that maps CI conclusions to `green` / `pending` / `not-passed` (treating `skipped`, `neutral`, `cancelled`, `timed_out`, `action_required`, `failure` as NOT green), folds a bounded-backoff CI wait into `validate` completion, and relocates the `implementation-review` gate to fire on the `validate` phase only once CI is confirmed green. The whole path is gated behind a **new independent flag `ciMergeGateEnabled`**; when disabled the behavior is byte-identical to today.

All five clarifications are load-bearing:
- **Q1→C** — configurable per-workflow `ciWaitTimeoutMs` (sane default); on timeout pause with a resumable `waiting-for:ci` gate + `agent:paused`. Never declares green on pending.
- **Q2→C** — aggregate all workflow runs for the head SHA, ignore `skipped`/`neutral`; green only if every non-skipped run is `success` and ≥1 `success` exists.
- **Q3→A** — "no CI run found" = pending (wait → timeout → resumable pause), never fail-fast.
- **Q4→A** — keep the gate on the `validate` phase; the CI wait is folded into validate's completion; `GATE_MAPPING` resumes at a terminal/no-op position.
- **Q5→B** — new independent flag `ciMergeGateEnabled`; disabled fallback = today's `{ phase: 'implement', resumeFrom: 'validate' }`.

## Technical Context

- **Language/runtime**: TypeScript, ESM, Node ≥22, pnpm workspaces.
- **Primary packages touched**:
  - `@generacy-ai/workflow-engine` — `GhCliGitHubClient` (new CI-readiness method) + `label-definitions.ts` (new `waiting-for:ci` / `completed:ci` vocabulary). **`minor`** (new public client method + new label vocabulary).
  - `@generacy-ai/orchestrator` — worker config/flag threading, phase-loop CI-wait block, gate relocation, phase-resolver `GATE_MAPPING` rework. **`patch`** (internal, no new public exports).
- **Client access model**: the worker uses `GhCliGitHubClient` (shells out to `gh` / `gh api`), NOT the octokit-based `@generacy-ai/github-actions` package (which is not a dependency of orchestrator and is per-workflow only). The CI readout is therefore a new `gh api` method on `GhCliGitHubClient`.
- **Flag-threading precedent**: mirror `reviewPhaseEnabled` end to end — env (`loader.ts`) → `WorkerConfigSchema` (`config.ts`) → `PhaseResolver.resolveStartPhase` (`phase-resolver.ts`) → `phase-loop.ts`.
- **No `.specify/memory/constitution.md`** in the repo → constitution check skipped.

## Constitution Check

No constitution file present (`.specify/memory/constitution.md` absent). Skipped per plan convention.

## Project Structure

### New files

```
packages/workflow-engine/src/actions/github/client/ci-verdict.ts
    Pure verdict aggregation: mapCiConclusion(), aggregateCiVerdict(runs) → 'green' | 'pending' | 'not-passed'.
    Zero I/O — takes an array of { conclusion, status } and returns the three-state verdict.

packages/orchestrator/src/worker/ci-merge-readiness.ts
    evaluateCiReadiness({ github, owner, repo, headSha }) → CiReadiness.
    Calls GhCliGitHubClient.getCiRunsForSha (check-runs), falls back to actions/runs?branch=,
    maps both through aggregateCiVerdict. Bounded-backoff wait helper waitForCiGreen(...) with
    ciWaitTimeoutMs ceiling.
```

### Modified files

```
packages/workflow-engine/src/actions/github/client/interface.ts
    + getCiRunsForSha(owner, repo, headSha, branch): Promise<CiRun[]>  (new interface method)
packages/workflow-engine/src/actions/github/client/gh-cli.ts
    + getCiRunsForSha impl: gh api repos/{o}/{r}/commits/{sha}/check-runs (primary),
      gh api repos/{o}/{r}/actions/runs?branch={branch} filtered to headSha (fallback on
      non-zero exit / missing checks:read).
packages/workflow-engine/src/types/github.ts
    + CiRun, CiConclusion, CiVerdict types.
packages/workflow-engine/src/actions/github/label-definitions.ts
    + waiting-for:ci (color FBCA04), completed:ci (color 0E8A16).

packages/orchestrator/src/config/loader.ts
    + read WORKER_CI_MERGE_GATE_ENABLED and WORKER_CI_WAIT_TIMEOUT_MS env vars (mirror reviewPhaseEnabled).
packages/orchestrator/src/worker/config.ts
    + WorkerConfigSchema.ciMergeGateEnabled: z.boolean().default(false)
    + WorkerConfigSchema.ciWaitTimeoutMs: z.number().int().min(30_000).default(900_000)  // 15 min
    + GateDefinitionSchema.condition enum gains 'on-ci-green'
    + gates default: relocate implementation-review from implement→validate when ciMergeGateEnabled
      (see phase-resolver rework for the flag-conditional shape).
packages/orchestrator/src/worker/phase-resolver.ts
    + thread ciMergeGateEnabled through resolveStartPhase → resolveFromContinue/resolveFromProcess
      → getEffectiveGateMapping.
    + GATE_MAPPING['implementation-review'] becomes flag-conditional:
        OFF → { phase: 'implement', resumeFrom: 'validate' }  (byte-identical to today)
        ON  → { phase: 'validate',  resumeFrom: <terminal no-op> }  (FR-006)
packages/orchestrator/src/worker/phase-loop.ts
    + CI-wait + readiness block folded into validate completion, evaluated before the gate-check loop.
    + 'on-ci-green' gate condition evaluation in the gate loop.
    + terminal no-op short-circuit for a satisfied post-validate implementation-review gate on resume.
packages/orchestrator/src/worker/claude-cli-worker.ts
    + pass this.config.ciMergeGateEnabled into phaseResolver.resolveStartPhase.

.changeset/1133-ci-merge-gate.md
    @generacy-ai/workflow-engine minor + @generacy-ai/orchestrator patch.

docs / spec (FR-008): migration note that target repos must add ready_for_review to the
pull_request trigger types, plus the readiness contract + skipped≠passed rule.
```

### Contracts

```
specs/1133-context-repo-ci-yml/contracts/ci-verdict.md          — aggregation truth table + verdict semantics
specs/1133-context-repo-ci-yml/contracts/gh-cli-ci-readout.md   — getCiRunsForSha method contract (primary + fallback)
specs/1133-context-repo-ci-yml/contracts/gate-and-flag.md       — ciMergeGateEnabled flag, gate relocation, GATE_MAPPING rework
specs/1133-context-repo-ci-yml/contracts/labels.md              — waiting-for:ci / completed:ci label definitions
```

## Key Technical Decisions

1. **CI readout is a new `GhCliGitHubClient.getCiRunsForSha` method**, not the `@generacy-ai/github-actions` octokit package (not an orchestrator dependency; per-workflow only). Primary path: `gh api repos/{o}/{r}/commits/{sha}/check-runs`. Fallback (non-zero exit / no `checks:read`): `gh api repos/{o}/{r}/actions/runs?branch={branch}` filtered to `head_sha === headSha`. Both map through the same pure `aggregateCiVerdict` so SC-004 (identical verdict) holds by construction.

2. **Three-state verdict** (`green` / `pending` / `not-passed`), ignoring `skipped`/`neutral`: `not-passed` if any non-skipped run has a terminal non-success conclusion; `green` if ≥1 non-skipped `success` AND no non-skipped terminal non-success AND no in-progress; `pending` otherwise (includes all-skipped and no-runs — satisfies SC-001).

3. **CI wait folded into `validate` completion** (Q4-A): after `validate` succeeds, evaluate readiness; on `pending` wait with bounded exponential backoff up to `ciWaitTimeoutMs`; on timeout pause with `waiting-for:ci` + `agent:paused` (never green). No busy loop (SC-005).

4. **New independent flag `ciMergeGateEnabled`** (Q5-B), threaded exactly like `reviewPhaseEnabled`. When OFF, `GATE_MAPPING['implementation-review']` and the gates default are byte-identical to today (SC-006).

5. **Gate relocation + terminal resume** (FR-005/FR-006): when the flag is ON, the `implementation-review` gate attaches to `validate` and fires only on `on-ci-green`; a satisfied gate resolves to a terminal/no-op resume so neither `validate` nor `implement` re-runs. See research.md Decision 5 for the chosen no-op mechanism and rejected alternatives.

## Testing Strategy

- Unit: `ci-verdict.test.ts` — aggregation truth table (skipped-only → pending, one failure → not-passed, all success → green, in-progress → pending, no runs → pending).
- Unit: `gh-cli.ci-readout.test.ts` — primary check-runs path + fallback actions/runs path yield identical verdict (SC-004); fallback triggered on non-zero exit.
- Unit: `ci-merge-readiness.test.ts` — bounded backoff, timeout → `waiting-for:ci` pause, never-green on pending (SC-005).
- Integration: `phase-loop.ci-merge-gate.test.ts` — skipped CI + green validate blocks the gate (SC-001); green+green raises it (SC-002); flag OFF byte-identical (SC-006).
- Resolver: `phase-resolver.ci-merge.test.ts` — flag ON → implementation-review on validate + terminal resume; flag OFF → unchanged mapping.

## Next Step

`/speckit:tasks` to generate the task list.

# Implementation Plan: Wire the PR review-posting + draft/ready lifecycle (readFindingsArtifact never supplied)

**Feature**: Supply the missing `deps.readFindingsArtifact` reader at the worker wiring site so the #1125 review-posting + draft/ready lifecycle block executes in production, plus the four latent-defect corrections (severity bridge, live PR number, sidecar-derived round, cross-run ready flag) that wiring the reader exposes.
**Branch**: `1156-severity-critical-p0-entire`
**Status**: Complete

## Summary

The entire #1125 PR-visibility/lifecycle block at `phase-loop.ts:1591-1607` is dead in production. It guards on `deps.reviewPoster && deps.readFindingsArtifact`, but `claude-cli-worker.ts:848-898` wires only the poster — the reader was left `undefined` with the comment "#1124 will supply the reader." #1124 shipped its findings sidecar (`review-artifact.ts`) and the review executor **without** wiring the reader, and the epic closed, so the guard is permanently false and the block never runs.

Wiring the reader in isolation would immediately expose four latent defects the dead path has been masking. This issue delivers the reader **and** the four corrections so the flow works end-to-end and survives pause / re-entry / cross-run:

1. **FR-001 — supply the reader.** Add `readFindingsArtifact` to the `PhaseLoopDeps` object in `claude-cli-worker.ts`, using the same `${owner}/${repo}#${issueNumber}` workflowId the existing `remediateTrigger` already uses.
2. **FR-002/FR-003 — bridge `ReviewArtifact` → `FindingsArtifact`.** The reader reads the engine-written sidecar (`ReviewArtifact`) and bridges it into the `FindingsArtifact` shape the `ReviewPoster` consumes: severity `critical|major|minor` → `blocking|advisory` via the configured `blockingSeverity` threshold (consistent with `computeVerdict`), `title`+`detail` → `text`, `file`+optional `line` → optional `anchor`, `status` → `resolved?`, plus a stable synthesized per-finding `marker = hash(file + title)`.
3. **FR-004 — live PR number.** Replace `ReviewPoster`'s captured `prNumber: number` with an injected `getPrNumber: () => number | undefined` getter resolved live per `postRound` / `resolveResolvedThreads` call, skipping when undefined. Kills the "post to PR #0" bug for early rounds.
4. **FR-005 — round from the sidecar.** `readFindingsArtifact` returns `{ artifact, round }` (round from the sidecar, not the loop-local `reviewRound` that resets to 1 each run). The block passes that round to `postRound` and gates thread resolution on `round >= 2`.
5. **FR-006/FR-007 — cross-run ready flag.** Persist `markedReadyByEngine` in the sidecar so a later `address-pr-feedback` re-entry in a new run can convert a previously-engine-marked-ready PR back to draft — while never demoting a PR a human marked ready.

Bounded by FR-008 (all posting/lifecycle calls stay best-effort — a failure logs and is swallowed) and FR-009 (whole path stays inert when `reviewPhaseEnabled=false` / no sidecar is produced).

## Technical Context

- **Language / runtime**: TypeScript, Node >=22, ESM. Vitest for tests.
- **Packages touched**:
  - `@generacy-ai/orchestrator` — `review-artifact.ts` (schema field + helper), `review-findings-bridge.ts` (NEW), `review-poster.ts` (getter), `pr-manager.ts` (cross-run flag), `phase-loop.ts` (block re-key), `claude-cli-worker.ts` (wire the reader + getter).
  - No public-export or cross-package surface change — everything is orchestrator-internal.
- **Prerequisites (all merged to `develop` at `155b3464`)**: #1121 (phase machinery + seams), #1124 (review executor + `ReviewArtifact` sidecar + `computeVerdict` + `SEVERITY_RANK`), #1125 (`ReviewPoster` + `FindingsArtifact` consuming contract + `PrManager` lifecycle methods), #1128 (`remediationCount` + sidecar spread helpers).
- **Reused surfaces (not re-implemented)**: `readReviewArtifact` / `writeReviewArtifact` (atomic temp+rename, null-on-invalid); `SEVERITY_RANK` + `computeVerdict`'s threshold semantics; `ReviewPoster.postRound` / `resolveResolvedThreads` behavior; `PrManager.markReadyForReview` / `convertToDraftIfEngineMarkedReady` / `getPrNumber`; the `FindingsArtifact` / `ReviewFinding` consuming types in `review-findings-artifact.ts`.

## Key Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D-1 | The reader lives in `claude-cli-worker.ts` as a closure over a **pure bridge function** in a new `review-findings-bridge.ts` | FR-001 is a wiring change; the mapping logic (FR-002/003) is pure and unit-testable in isolation. The closure supplies `checkoutPath`, workflowId, and the resolved `blockingSeverity`; the bridge does the shape transform. |
| D-2 | Severity → blocking/advisory via the configured `blockingSeverity` threshold, not a fixed `critical\|major=blocking` map | Q1=A / FR-002. Single source of truth with `computeVerdict`: at the default `blockingSeverity=critical`, a `major` finding renders **advisory**, matching the clean verdict `computeVerdict` scores — no visual "blocking" finding on a PR the engine called clean. |
| D-3 | Per-finding `marker = sha256(file + '\0' + title)`, truncated (24 hex) | Q2=A / FR-003. `ReviewArtifact` findings carry no id. Keying on `file`+`title` ("this problem in this file") is stable across rounds through `line`/`detail` drift, so re-review thread matching (`findingMarker`) resolves the right thread. A `\0` separator prevents `file`/`title` boundary collisions. |
| D-4 | `ReviewPoster` gets `getPrNumber: () => number \| undefined`, resolved at the top of each public method; both methods no-op when undefined | Q3=A / FR-004. No method-signature change (poster surface stays `postRound`/`resolveResolvedThreads`), resolves at posting time so a PR created mid-loop is targeted correctly, and is inert (skip) before a PR exists — never posts to PR #0. |
| D-5 | `readFindingsArtifact` returns `{ artifact, round }`; the block passes that `round` | Q4=A / FR-005. The reader already reads the sidecar (which carries `round`), so returning it keeps `round` with its single existing read — no mutation of the shared `FindingsArtifact` shape, no redundant second read. The loop-local `reviewRound` is no longer the posting/gating round. |
| D-6 | Persist `markedReadyByEngine` in the sidecar (`ReviewArtifactSchema` field, `.default(false)`); `PrManager` reads it on re-entry to reconstruct the in-memory flag | Q5=A / FR-006. The sidecar is the named source of truth for cross-run lifecycle state. An explicit persisted flag is unambiguous and never demotes a human-marked-ready PR (FR-007) — only the engine's own `markReadyForReview` ever sets it true. `.default(false)` lets pre-#1156 artifacts parse. |
| D-7 | The review executor's explicit sidecar write carries `markedReadyByEngine` forward | The review executor rewrites the whole artifact each round (`review-executor.ts:244-250`) and only carries fields it names; without adding `markedReadyByEngine: priorRound?.markedReadyByEngine ?? false` there, the flag would silently reset on every re-review. `bumpRemediationCount`/`resetRemediationCount` already spread `...artifact`, so they preserve it for free. |
| D-8 | Flag-OFF / no-sidecar byte-identity preserved | FR-009. With `reviewPhaseEnabled=false`, `review` is absent from the effective sequence and the block never runs. If the flag is on but no sidecar was produced, `readReviewArtifact` returns `null` → the reader returns `null` → the block no-ops. |

## Project Structure

```
packages/orchestrator/src/worker/
  review-findings-bridge.ts          # NEW — pure bridgeReviewArtifact() (ReviewArtifact → FindingsArtifact) + synthesizeMarker()
  review-artifact.ts                 # MOD — + markedReadyByEngine field (.default(false)); + setMarkedReadyByEngine() helper
  review-executor.ts                 # MOD — carry markedReadyByEngine forward in the round-rewrite write
  review-poster.ts                   # MOD — prNumber: number → getPrNumber: () => number | undefined; resolve-or-skip per method
  pr-manager.ts                      # MOD — optional workflowId ctor arg; persist flag on markReady; reconstruct + persist-false on convert
  phase-loop.ts                      # MOD — review side-effect block: readFindingsArtifact() → { artifact, round }; pass sidecar round
  claude-cli-worker.ts               # MOD — construct ReviewPoster with getPrNumber getter; wire readFindingsArtifact closure; pass workflowId to PrManager
  __tests__/
    review-findings-bridge.test.ts               # NEW — SC-002 (no finding dropped) + severity-threshold matrix + marker stability
    review-poster.get-pr-number.test.ts          # NEW — SC-003 (live number, skip-when-undefined, never PR #0)
    review-artifact.marked-ready.test.ts         # NEW — persist/read/back-compat default; carry-forward across rounds
    pr-manager.cross-run-draft.test.ts           # NEW — SC-005 (reconstruct-from-sidecar convert) + SC-006 (human-ready no-op)
    phase-loop.review-side-effects.test.ts       # MOD — reader returns { artifact, round }; SC-001 one COMMENT review; SC-004 re-entry round≥2
```

Existing test files that inject the old surfaces and MUST be updated in lockstep (identified via grep):
`phase-loop.review-clean.integration.test.ts`, `phase-loop.merge-conflict-scoped-review.*`, `phase-loop.review-remediate.*`, `phase-loop.review-remediate-convergence.*`, `phase-loop.remediation-cap.*`, and `__tests__/helpers/bugfix-harness.ts` (`makeFindingsReader`). Each constructs `new ReviewPoster({ ...prNumber... })` and/or injects `readFindingsArtifact` returning a bare `FindingsArtifact`; both surfaces change (getter + `{ artifact, round }`).

## Constitution Check

No `.specify/memory/constitution.md` present in the repo → constitution check skipped.

## Changeset

`.changeset/1156-wire-review-posting-lifecycle.md` — `@generacy-ai/orchestrator` **patch**. This is a defect fix (`workflow:speckit-bugfix`) that wires an already-shipped-but-dead code path; no new public exports (the bridge, the getter, and the sidecar field are all orchestrator-internal). Single file.

## Next Step

`/speckit:tasks` to generate the task list.

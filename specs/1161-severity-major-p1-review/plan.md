# Implementation Plan: Collapse the triple findings-artifact schema; activate the discarded convergence engine

**Feature**: Consolidate the engine-native review subsystem onto one findings-artifact schema, one `computeVerdict`, one severity-rank table; wire the #1126 delta/verification convergence engine end-to-end into the live review executor; fix the `settings = null` blockingSeverity resolution; reconcile the `speckit-feature` default (`major`) with the docs.
**Branch**: `1161-severity-major-p1-review`
**Status**: Complete

## Summary

Epic #1120 shipped the engine-native review phase with three parallel
findings-artifact schemas, two `computeVerdict` implementations, three
severity-rank tables, and a fully-built convergence engine
(`runReviewConvergence` → `computeReviewDelta` → `composeVerificationInput` →
`buildVerificationPrompt` → `advanceArtifact`) whose output is computed and then
thrown away. The live review path re-runs a whole-PR review each round, the agent
rewrites the sidecar wholesale, and a round-1 finding the round-2 agent forgets to
re-emit silently vanishes and flips the verdict to `clean`.

Per the resolved decisions (`/speckit:clarify`, 2026-08-21):

- **D1 (Q1=A) — Activate** the #1126 convergence engine. It is fully built and
  unit-tested but disconnected; this is unfinished #1127-bridge wiring, not a
  deliberate stateless choice. Delta-scoped convergence is the mechanism for the
  epic's churn-reduction goal (3–6 rounds → convergence).
- **D2 (Q3=A, Q4=A) — Canonical schema** = `critical|major|minor` severity
  vocabulary, convergence-capable field set: stable per-finding `id`, engine-owned
  monotonic `open|resolved` status, `lastReviewedCommitSha`, and `round`. Home is
  the LIVE `review-artifact.ts` (most consumers, owns persistence helpers,
  `remediationCount`, `markedReadyByEngine`); it gains a per-finding `id`.
- **D3 (Q2=A) — `speckit-feature` default `blockingSeverity = major`**; other
  workflows unchanged (`critical`). Code constant and docs reconciled.

The scope is **orchestrator-internal**: no cloud, cluster-base, cross-package, or
public-export change. The whole feature stays behind the existing
`reviewPhaseEnabled` / `WORKER_REVIEW_PHASE_ENABLED` flag; a flag-OFF cluster is
byte-identical before and after.

## Technical Context

- **Language / runtime**: TypeScript (ESM), Node >= 22.
- **Package**: `@generacy-ai/orchestrator` (`packages/orchestrator`).
- **Test runner**: Vitest (`pnpm --filter @generacy-ai/orchestrator test`).
- **Validation**: `zod` (schemas), `node:fs`/`node:path` (atomic sidecar I/O),
  `node:crypto` (stable-id derivation).
- **Feature flag**: `reviewPhaseEnabled` (env `WORKER_REVIEW_PHASE_ENABLED`,
  default `false`) — gates the `review` phase into the effective sequence.
- **No new dependencies.** No new public exports. No cross-package surface change.

### Canonical schema home & the fork it closes

| Schema file | Status today | Fate |
|---|---|---|
| `worker/review-artifact.ts` | **LIVE** (`critical\|major\|minor`, `open\|resolved`, `round`, `lastReviewedCommitSha`, `remediationCount`, `markedReadyByEngine`; owns `SEVERITY_RANK` + `computeVerdict`) | **Canonical.** Gains stable per-finding `id`. |
| `worker/review-findings-artifact.ts` | #1125 poster contract (`blocking\|advisory`, `marker`, `text`) — self-flagged temp copy to delete | **Deleted.** Poster consumes canonical `ReviewFinding[]`; blocking/advisory is a render-time projection via `SEVERITY_RANK`. |
| `worker/review/findings-artifact.ts` | #1126 convergence artifact (`id`, `round`-0, `lastReviewedSha`, own `SEVERITY_ORDER`/`sev()`) | **Deleted.** Convergence engine retargeted to canonical types. |

## Project Structure

Files touched (all under `packages/orchestrator/src/`):

```
worker/
  review-artifact.ts              # MODIFY: add per-finding `id`; remains the ONE
                                  #   schema + ONE computeVerdict + ONE SEVERITY_RANK
  review-findings-artifact.ts     # DELETE (#1125 orphan)
  review-findings-bridge.ts       # DELETE (bridge to the deleted poster schema)
  review-poster.ts                # MODIFY: consume canonical ReviewFinding[]; derive
                                  #   blocking/advisory from SEVERITY_RANK; marker = id
  review-charter.ts               # MODIFY: round>=2 scopes to the delta window +
                                  #   enumerates still-open findings (verification framing)
  review-executor.ts              # MODIFY: convergence merge replaces wholesale rewrite;
                                  #   resolves blockingSeverity with this.settings (FR-004)
  remediate-executor.ts           # MODIFY: delete local SEVERITY_RANK; import canonical
  phase-loop.ts                   # MODIFY: delete runReviewConvergence + its PhaseTracker
                                  #   key; retype readFindingsArtifact seam to canonical
  config.ts                       # MODIFY: DEFAULT per-workflow blockingSeverity
                                  #   (speckit-feature=major, else=critical)
  claude-cli-worker.ts            # MODIFY: drop bridgeReviewArtifact; wire canonical seam
  review/
    findings-artifact.ts          # DELETE (#1126 orphan schema)
    findings-advance.ts           # MODIFY: retarget to canonical types; delete its
                                  #   second computeVerdict + SEVERITY_ORDER usage
    review-delta.ts               # MODIFY: read canonical `lastReviewedCommitSha`
    verification-input.ts         # MODIFY: operate on canonical ReviewFinding
    verification-prompt.ts        # KEEP/adjust: now feeds the live charter (not discarded)
  __tests__/                      # MODIFY existing + ADD convergence/parity/regression
  review/__tests__/               # MODIFY findings-advance / review-delta tests to canonical
docs/docs/reference/review-artifacts.md   # MODIFY: default blockingSeverity = major (feature)
.changeset/1161-*.md              # ADD
```

## Approach (phased)

1. **Canonical schema (FR-001/FR-003, D2).** Add `id: z.string().min(1)` to
   `ReviewFindingSchema` in `review-artifact.ts`. Keep `SEVERITY_RANK`
   (`critical:3, major:2, minor:1`) and `computeVerdict` as the single source of
   truth. Back-compat parse: default-fill `id` (derive from `file+'\0'+title`
   sha256[:24]) on in-flight sidecars that lack it, so a PR mid-loop does not wedge
   on redeploy.
2. **Delete orphans (FR-001/FR-002/FR-003).** Remove
   `review/findings-artifact.ts`, `review-findings-artifact.ts`,
   `review-findings-bridge.ts`. Retarget `review/findings-advance.ts`,
   `review/review-delta.ts`, `review/verification-input.ts` to import the canonical
   `ReviewFinding`/`ReviewArtifact` + `SEVERITY_RANK` + `computeVerdict`. Delete the
   second `computeVerdict` and `SEVERITY_ORDER`/`sev()`. Delete `remediate-executor`'s
   local `SEVERITY_RANK`; import canonical.
3. **Poster re-home (FR-001/FR-009).** `review-poster.ts` consumes canonical
   `ReviewFinding[]`: `marker = finding.id`, `text = title + '\n\n' + detail`,
   blocking/advisory derived at render via
   `SEVERITY_RANK[f.severity] >= SEVERITY_RANK[blockingSeverity]`. All #1156
   posting/lifecycle behavior preserved; #1156 tests updated only for the input type.
4. **Activate convergence in the executor (FR-005/FR-006/FR-007, D1).** Delete
   `runReviewConvergence` and its `review-findings:<owner>:<repo>:<issue>:<branch>`
   PhaseTracker key. In `review-executor.ts`: read prior sidecar → `computeReviewDelta`
   (from `lastReviewedCommitSha`) → build a **delta-scoped** charter that enumerates
   still-open findings (round >= 2, verification profile) → spawn CLI → `advanceArtifact`
   with **real** inputs (prior artifact + delta + agent candidate) to carry forward
   unaddressed findings, resolve addressed ones (monotonic), and admit new findings
   only at blocking severity on round >= 2 → engine `computeVerdict` → write canonical
   sidecar with `round = prior.round + 1`, `lastReviewedCommitSha = HEAD`. Round
   advances **only** on a successful review; the sidecar is the single round source.
5. **Consistent blockingSeverity (FR-004).** Every verdict-relevant call site
   resolves via `resolveWorkflowOverrides(config, this.settings, workflowName)`. The
   `settings = null` call is deleted with `runReviewConvergence`.
6. **Default + docs reconciliation (FR-008, D3).** Replace the flat
   `DEFAULT_REVIEW.blockingSeverity = 'critical'` with a per-workflow default
   (`speckit-feature → major`, else `critical`), mirroring `defaultMaxRemediations`.
   Update `docs/docs/reference/review-artifacts.md` and record the rationale.

## Constitution Check

No `.specify/memory/constitution.md` in the repository → constitution check skipped.

## Risks & Mitigations

- **Anti-vanish invariant (SC-005) is the load-bearing behavior change.** The
  executor must stop trusting the candidate as the whole truth and instead
  carry-forward prior open findings. Mitigation: `advanceArtifact` already encodes
  "match by id within delta, resolved-is-terminal, drop sub-blocking new findings";
  the executor merge feeds it real inputs. A dedicated convergence test omits a
  round-1 finding in the round-2 candidate and asserts it stays `open`.
- **In-flight sidecars.** Redeploy mid-loop must not wedge. Mitigation: back-compat
  parse default-fills `id` and any renamed field; `readReviewArtifact` returns the
  canonical shape or `null` (never throws to the caller).
- **#1156 poster regression.** Mitigation: preserve poster output byte-for-byte;
  only the input type changes (canonical `ReviewFinding[]` + `blockingSeverity`).
- **Flag-OFF byte-identity (Assumptions).** All changes sit inside the `review`
  phase path, unreachable when `reviewPhaseEnabled = false`.

## Changeset

`.changeset/1161-collapse-findings-schema-activate-convergence.md` —
`@generacy-ai/orchestrator` **patch** (`workflow:speckit-bugfix`): internal
consolidation + bug fix; no new public exports, no new label vocabulary. The
`speckit-feature` default change is a behavioral default shift, still internal.
Verify with `pnpm changeset status` at implement time; single file.

## Next Step

`/speckit:tasks` to generate the dependency-ordered task list.

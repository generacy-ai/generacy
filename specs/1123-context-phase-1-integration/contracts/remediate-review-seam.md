# Contract: `remediate → review` loop-control seam

**Status**: Stable (P1 checkpoint — #1123). P2 (#1124–#1127) and P3 (#1128–#1132) build against this boundary.
**Owner phase**: worker phase loop (`packages/orchestrator/src/worker/phase-loop.ts`).
**Depends on**: #1121 (`WorkflowPhase` gains `review`/`remediate`; phase machinery provides off-sequence entry).

This contract pins the boundary that lets later phases add **real** review/remediate executors without re-plumbing loop control. It is the durable acceptance artifact for FR-007 / SC-006. #1123 ships **stub** executors + the tests that assert this behavior; it ships no real review/remediation logic (FR-008).

## 1. Phases

| Phase | Sequencing | Stage |
|---|---|---|
| `review` | **Linear** — entered immediately after `implement`, for both `speckit-feature` and `speckit-bugfix`. | `implementation` |
| `remediate` | **Off-sequence** — never in the linear phase sequence. Reached **only** via loop control. | `implementation` |

Both map to the `implementation` stage (#1121 FR-002). No new `StageType`.

## 2. Loop-control seam

As shipped by #1121, the off-sequence entry is driven by an **injectable predicate** on `PhaseLoopDeps`, evaluated after a successful `review` pass, plus an `i--; continue;` backtrack that re-enters `review`. It is **independent of any review verdict** (clarification Q2=C) — the predicate is the steering seam, not a verdict. (This supersedes the earlier draft's `{ next: <phase> }` step-outcome sketch; the mechanism #1121 actually delivered is the predicate below.)

```ts
// PhaseLoopDeps (packages/orchestrator/src/worker/phase-loop.ts)
remediateTrigger?: (context: WorkerContext) => boolean;
```

The loop body, after `review` completes successfully:

```ts
if (phase === 'review' && result.success && deps.remediateTrigger?.(context)) {
  await labelManager.onPhaseStart('remediate');
  const remediateResult = this.runStubPhase('remediate');
  await labelManager.onPhaseComplete('remediate');
  results.push(remediateResult);
  outputCapture.clear();
  i--;            // re-enter the same review index
  continue;       // backtrack — control returns to review, never advances
}
```

In production the predicate defaults to `undefined`, so `remediate` is unreachable; tests inject a fire-once predicate to steer exactly one off-sequence pass.

### Invariants

1. **Entry.** `remediate` is entered **only** when `deps.remediateTrigger` is present and returns `true` for the just-completed `review` pass. It is never reached by linear index advance, never directly by a review verdict, and never by a gate/label. (There is no `waiting-for:remediation` label — #1121 Q3=A does not add one.) `remediate` appears in **no** linear phase sequence.
2. **Backtrack.** On completion, the loop runs `i--; continue;` — control **always** returns to a delta-scoped re-`review` pass — never to the next linear phase (validate/merge).
3. **Single seam.** The `remediateTrigger` predicate is the one seam for all three future `remediate` entry points, which P3 converges onto:
   - a `review` verdict of "needs remediation",
   - a `validate` failure (retiring the standalone validate-fix handler),
   - external PR feedback.
   Each becomes a `remediateTrigger` implementation; none introduces a parallel entry mechanism.

## 3. Pause / resume

Pause/resume rides the existing **phase-context sidecar** (`pause-context.ts`, merge-conflict precedent #902), which carries the interrupted phase in-band.

| Paused in | Resumes to | Source |
|---|---|---|
| `review` | `review` | sidecar `ctx.phase` (autonomous phase — no gate) |
| `remediate` | `remediate` | sidecar `ctx.phase` (Q3=A — re-enter to finish; resets the counter in P3) |

- `review` is **autonomous**: no `waiting-for:review` gate, no `GATE_MAPPING` entry. Resume relies solely on the sidecar.
- `remediate`'s forward-looking human gate is **`waiting-for:remediation-limit`** (final approval + remediation-limit are the design's only human gates). Its **enforcement is P3 / out of scope for #1123**. #1123 does not wire or test it.
- `waiting-for:*` / `phase:*` / `agent:*` labels apply and clear **symmetrically** across a pause/resume — no residual label (SC-004).

## 4. Per-workflow config observable inside the loop

`maxRemediations` (feature **3** / bugfix **2**) and the review profile live in `@generacy-ai/config` `OrchestratorSettings` (#1122 Q1) and are read inside the loop via the config object the worker already holds, resolved by a `worker/config.ts` resolver (#1122 Q4). They are **not** a `WorkerConfig` field and **not** an injected loop dependency (clarification Q4=B).

## 5. Change control

Changing any invariant in §2 or the resume targets in §3 requires editing this file. P2/P3 PRs that touch loop control must cite this contract. The phase-union sync audit (FR-006) guards that `review`/`remediate` never drift out of the union's companion enumerations.

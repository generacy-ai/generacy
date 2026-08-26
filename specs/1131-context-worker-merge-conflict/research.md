# Research: Merge-conflict re-arm targets a resolution-scoped review

**Feature**: `1131-context-worker-merge-conflict`
**Status**: Complete

This document records the load-bearing design decisions behind the plan, the
codebase seams they rest on, and the alternatives ruled out.

---

## Decision 1: How a `review` re-arm actually reaches the `review` phase

### Problem

`MergeConflictHandler.finishSuccess` returns
`{ outcome: 're-armed', startPhase: metadata.phase }` today
(`merge-conflict-handler.ts:659`). The natural reading is that `startPhase`
selects the phase the resumed run starts from. **It does not.**

Tracing the re-arm path:

1. Handler returns the re-armed outcome.
2. `claude-cli-worker.ts:380-394` builds a `rearmItem` with
   `command: 'continue'` and `metadata: { startPhase: outcome.startPhase,
   resumeReason: 'merge-conflict-resolved' }`.
3. The dispatcher enqueues the `continue` item after `queue.complete()`.
4. When that item is processed, the start phase is resolved by
   **`PhaseResolver.resolveStartPhase(labels, 'continue', workflowName,
   reviewPhaseEnabled)`** at `claude-cli-worker.ts:439` — from **labels**, not
   from `metadata.startPhase`.
5. `metadata.startPhase` is read only by `assertHandlerOutcomeMatchesWorld`
   (`handler-outcome-assertion.ts:43-56`), a consistency check that verifies the
   pending item's `metadata.startPhase === outcome.startPhase`. It never feeds
   phase resolution.

So re-arming to `validate` "works" today purely because the paused issue's
labels (`completed:*` / `phase:*`) already resolve to the interrupted phase via
`resolveFromContinue` (`phase-resolver.ts:129-161`).

### Why labels won't carry us to `review`

Labels will **not** reliably resolve to `review` after a merge resolution. A
conflict encountered during `validate` — after `review` already ran — carries
`completed:review` (and `completed:implementation-review`), so
`resolveFromContinue`/`resolveFromProcess` skip straight past `review` back to
`validate`. There is no label state that says "re-review the merge I just
resolved." The `review` phase is also gate-less (#1121 Q2→A), so there is no
`waiting-for:review` gate to anchor a resume either.

### Chosen mechanism (Q2→B transport + explicit override)

Add an **explicit `startPhase` override** consumed only on the merge-conflict
resume path. Concretely, in the context-build seam of `claude-cli-worker.ts`
(where `md['resumeReason']` and `md['baseSha']` are already read for the
`'base-advance'` path, ~522-537):

- When `md['resumeReason'] === 'merge-conflict-resolved'` **and**
  `md['startPhase'] === 'review'`, set `context.startPhase = 'review'`
  directly, bypassing the label-derived `resolveStartPhase` result.
- Also set `context.resumeReason = 'merge-conflict-resolved'` and
  `context.reviewScope = md['reviewScope']` (the `{ baseSha, headSha }` object,
  or absent for the whole-branch fallback).

The SHAs travel on the outcome → rearm metadata → `WorkerContext`, never through
the sidecar, because the merge-conflict pause-context sidecar is cleared
immediately after re-arm (Q2→B). This reuses the exact channel that
`startPhase` + `resumeReason` already travel on — a minimal extension of a
self-scoped, single-consumer transport.

### Flag-OFF is byte-identical

When `config.reviewPhaseEnabled` is `false` (FR-009, Q3→B), the handler returns
`startPhase: metadata.phase` exactly as today, `resumeReason` is still
`'merge-conflict-resolved'` but the override branch requires the phase to equal
`'review'` — so it is not taken, and `resolveStartPhase` resolves from labels
just as it does now. No `reviewScope` is set. The resume is byte-identical to
current behavior. This also avoids the `Unknown starting phase: review` throw
at `phase-loop.ts:303-305`, which fires when `review` is filtered out of the
effective sequence (`phase-loop.ts:269-271`) but selected as the start phase.

### Alternatives considered

- **A — force `review` ON for resolutions regardless of the flag** (Q3→A):
  rejected. With the flag off, phase-loop filters `review` out and throws on a
  `review` start; `remediate` is still an inert stub — so forcing review risks a
  hard crash and a dead-end verdict. Gating preserves the safety invariant in
  both modes and respects the deliberate default-OFF rollout.
- **Pre-seed a `phase-start-ref`/label so labels resolve to `review`**
  (Q1→B-style): rejected. Requires synthesizing label state that other
  resolvers and monitors would have to agree on, and there is no natural
  `waiting-for:review` gate to anchor it. The explicit override is local to the
  one resume path and touches no shared label vocabulary.
- **Teach `PhaseResolver` about a merge-conflict resume**: rejected. Pollutes a
  general, label-only resolver with a special case that only one caller needs;
  the override at the context-build seam keeps the special case where the
  special context already lives.

---

## Decision 2: Deriving the resolution base/head SHAs

The `--no-ff` merge that resolves the conflict is created by the handler
(`git merge --no-ff <baseRef>` at `merge-conflict-handler.ts:241`). After it
succeeds and `pushAndSucceed` runs (calling `finishSuccess` at `:616`), `HEAD`
is the merge commit.

- **headSha** = `HEAD` (the merge commit).
- **baseSha** = `HEAD^1` (first parent of the `--no-ff` merge = the pre-merge
  branch tip). The second parent (`HEAD^2`) is the incoming base branch; we want
  the branch tip, so first-parent is correct.

The `base..head` window (`HEAD^1..HEAD`) is therefore exactly the resolution
diff: everything the merge commit introduced relative to where the branch was
before the merge. Unrelated branch files are excluded (FR-002, SC-002).

### The no-op / fallback cases

- **No-op merge path** (`merge-conflict-handler.ts:227-233`): the handler
  finishes without creating a merge commit. There is no `HEAD^1..HEAD`
  resolution delta, so the scope is `{ baseSha: HEAD, headSha: HEAD }` — an
  empty window (`HEAD..HEAD` diffs to nothing).
- **Undetermined SHAs**: if either SHA cannot be resolved at success time,
  `reviewScope` is left `undefined`. Per FR-010 (Q4→C) the handler still re-arms
  `review`, and the executor falls back to reviewing the whole PR diff — a safe
  superset that still honors FR-005 (`validate` runs on the post-merge state).

`metadata.phase` remains **required** (fail-loud guard at
`merge-conflict-handler.ts:641-656` unchanged) — it is still the flag-OFF
fallback target (FR-009) and the fail-loud signal, even though the flag-ON path
no longer re-arms into it.

### Alternatives considered

- **Store SHAs in the sidecar** (Q2→A/C): rejected. The sidecar is cleared
  immediately after re-arm, so it can't be the source of truth the executor
  reads on entry; a new keyed state entry would bring its own staleness
  lifecycle. The outcome-borne `reviewScope` has no lifecycle of its own.

---

## Decision 3: Empty-window short-circuit vs. whole-branch fallback

Two distinct "no meaningful diff" situations must not be conflated:

| Situation | `reviewScope` | Desired behavior |
|-----------|---------------|------------------|
| SHAs undetermined (FR-010) | `undefined` | Review the **whole** PR diff (safe superset) |
| Defined but empty window (FR-011) — no-op merge, net-zero ours/theirs pick | `{ baseSha, headSha }` with empty `baseSha..headSha` diff | **Skip** the review executor, go straight to `validate` |

The distinction is: `undefined` means "I don't know the scope, so review
everything"; a *defined but empty* window means "I know the scope and it is
genuinely nothing to review."

**Placement**: empty-window detection lives in the **review executor**
(`review-executor.ts`), which does a `git diff --quiet baseSha..headSha` (or
`git diff --name-only`) when `context.reviewScope` is present. If the window is
empty, it short-circuits: no CLI spawn, returns a synthetic success PhaseResult,
and the phase loop advances to `validate` (FR-011, SC-004). Both the no-op merge
(`{HEAD,HEAD}`) and a net-zero ours/theirs pick funnel through this single code
path.

This deliberately does **not** run the review charter's "empty diff = blocking
finding" rule (`review-charter.ts` empty-diff clause). That rule exists to catch
an implement-phase no-op bypass; a legitimate ours/theirs resolution is not a
defect (Q5→A). Running an agent to inspect nothing also contradicts the
cost-reduction motivation, while `validate` still runs on the post-merge state
so FR-005 holds.

### Alternatives considered

- **Run the scoped review but suppress the empty-diff finding** (Q5→B):
  rejected. Spawns an agent to review nothing — pure cost with no signal.
- **Treat empty resolution diff as a blocking finding** (Q5→C): rejected.
  Strands a legitimately-resolved PR in `remediate` and forces operator
  intervention for a non-defect.

---

## Decision 4: Threading the diff window into the executor and charter

The review executor spawns the CLI via `agentLauncher.launch({ intent: { kind:
'review', ... } })` (not `cli-spawner`, which type-excludes `review`). The
charter (`buildReviewCharter`) currently names "the PR diff (the commits on this
branch relative to its base)" — the **whole branch** — and has no window param
(Q1→A confirmed the window machinery does not otherwise exist in the review
path).

The plan extends:

- `ReviewCharterInput` with an optional `diffWindow?: { baseSha: string;
  headSha: string }`. When present, the charter names the exact
  `baseSha..headSha` range the agent must review, replacing the whole-PR
  language. When absent (whole-branch fallback), the charter is byte-identical
  to today.
- `ReviewExecutor.execute` reads `context.reviewScope`, performs the empty-window
  short-circuit (Decision 3), and otherwise passes the window through to the
  charter builder.

This is the minimal capability extension Q1→A calls for — an explicit window
input — not a new review mechanism. It is also the same window capability the
delta-scoped convergence re-reviews (#1126) conceptually need, so it is not
throwaway.

---

## Codebase seams (verified this planning phase)

- `merge-conflict-handler.ts` — `finishSuccess` (631-660, the `startPhase`
  choice at :659), fail-loud guard (641-656), `pushAndSucceed` (:616, HEAD =
  merge commit), no-op path (227-233), `git merge --no-ff` (:241). Constructor
  holds `this.config: WorkerConfig` → `config.reviewPhaseEnabled` available.
- `claude-cli-worker.ts` — rearm item build (380-394), label-based
  `resolveStartPhase` (:439), context-build seam reading `md['resumeReason']` /
  `md['baseSha']` (~522-537).
- `handler-outcome.ts` — `ReArmedOutcome` shape (needs optional `reviewScope`).
- `handler-outcome-assertion.ts` — re-armed consistency rule (43-56); stays
  consistent because the outcome's `startPhase` is carried verbatim into rearm
  metadata.
- `phase-loop.ts` — flag filter (269-271), start-phase throw (303-305), review
  invocation (535-537), review side-effects (1249-1265), remediate seam
  (1270-1284), `runStubPhase` (1301-1303).
- `review-executor.ts` — `execute(context)` (:58) does not read `reviewScope`
  today.
- `review-charter.ts` — `buildReviewCharter({ profile, sidecarRelPath,
  blockingSeverity, round })`; forbids tests/builds (43-49, FR-007).
- `review-artifact.ts` — `computeVerdict`, `readReviewArtifactSync` (used by the
  sync `remediateTrigger`).
- `worker/types.ts` — `WorkerContext.startPhase` (:478), `resumeReason?:
  'base-advance'` (:504), `baseSha?` (:506).
- `types/monitor.ts` — `ResolveMergeConflictsMetadata` (67-85); no new sidecar
  field needed (Q2→B).
- `worker/config.ts` — `reviewPhaseEnabled` (:134), `resolveWorkflowOverrides`
  (:54), `DEFAULT_REVIEW`, `maxRemediations`.

---

## Open items carried into implement

- Update `merge-conflict-handler.rearm.test.ts` fixtures: expect `startPhase:
  'review'` + `reviewScope` when the flag is on; unchanged `startPhase:
  metadata.phase` when off.
- Confirm no new **public** export is added (changeset stays `patch`): the
  `diffWindow` charter field and `WorkerContext.reviewScope` are internal to the
  orchestrator package.

*Generated by /plan*

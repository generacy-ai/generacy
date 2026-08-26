# Research: PR-feedback monitor rewrite (#1130)

## Decision 1 — Where does external feedback enter the shared loop?

**Question**: `remediate` is an off-sequence phase reachable only via `remediateTrigger(context)`
after a successful `review`. How should external trusted feedback drive it?

**Decision** (clarification Q1 → A): the monitor/adapter **synthesizes the findings artifact from
external feedback, then enters at `review`** (never directly at `remediate`). The existing
review→remediate seam takes over: `computeVerdict(seed) = changes-required` → `remediateTrigger`
returns `true` → the off-sequence remediate phase runs; convergence re-enters `review` via the
`i--; continue` backtrack until clean.

**Rationale**: `remediate` is off-sequence and reachable only via `remediateTrigger`; even the
`remediation-limit` gate resumes at `review` (`phase-resolver.ts:17`,
`GATE_MAPPING['remediation-limit'] = { phase: 'review', resumeFrom: 'review' }`). Entering at
`review` keeps one code path and one round counter. Entering directly at `remediate` would need a
new command + a bypass of the verdict machinery.

**Alternatives rejected**:
- *(B) new `remediate`-direct command* — a second live entry path, violates "one code path".
- *(C) `review` re-entry with no seeded artifact* — the engine executor re-derives findings from
  the diff, silently dropping body-only external asks (files not in the diff cannot be
  inline-anchored). This is exactly the drop FR-004 forbids.

## Decision 2 — The artifact-overwrite problem, and the seed-aware wrapper

**Observation**: `ReviewExecutor.execute()` (`review-executor.ts`) unconditionally spawns a fresh
CLI review (step 5) and **overwrites** the findings artifact (step 10 `writeReviewArtifact`). So
if the adapter wrote external findings straight into the artifact and then let the review phase
run, the fresh CLI diff-review would clobber the seeded body-only findings before
`remediateTrigger` ever read them.

**Decision** (plan D-1): introduce `SeedAwareReviewExecutor` implementing the same
`execute(context): Promise<PhaseResult>` shape, injected into the existing
`deps.reviewExecutor` slot (`claude-cli-worker.ts:691`). It checks for a checkout-local seed;
present → write artifact from seed + delete seed + synthetic success; absent → delegate to the
real `ReviewExecutor`.

**Why a wrapper, not a modification to `ReviewExecutor`**: `review-executor.ts` and `phase-loop.ts`
are explicitly Out of Scope (owned by #1124/#1126). The wrapper is additive, composes at the DI
seam already in place, and leaves the real executor's convergence-round behavior untouched.

**Alternatives rejected**:
- *Modify `ReviewExecutor` to branch on a seed* — edits an out-of-scope, sibling-owned file.
- *Have the adapter write the artifact and set a "skip CLI" flag on the phase loop* — requires a
  `phase-loop.ts` change (out of scope) and a new cross-cutting flag.

## Decision 3 — Reuse the legacy dual-source parser (FR-004)

**Decision** (clarification Q2 → C): reuse the legacy fixer's dual-source extraction
(`pr-feedback-handler.ts` inline-threads + review-bodies, ~218-402) as the extraction step. The
adapter runs it worker-side (where the checkout and trust config live) and feeds the results into
the seed.

**Rationale**: FR-004 requires preserving dual-source behavior (body-only findings must not be
dropped). That logic already does trust-filtered extraction from both sources. The monitor is an
orchestrator service with **no checkout** and cannot write the checkout-local sidecar — so
extraction must stay worker-side. Q5 → B (thin adapter, not full delete) keeps this parser in
place rather than re-homing it.

**Mapping**: legacy items `{ id, body, author, created_at, updated_at, path?, line? }` → seed
findings. Review-body items already carry the `"review body (no file anchor):\n\n${r.body}"`
prefix; the seed preserves them verbatim so `computeVerdict` and the remediate prompt see the full
text. (Exact finding schema in `data-model.md`.)

## Decision 4 — Engine-authored exclusion is per-thread, all-or-nothing (FR-010)

**Decision** (clarification Q4 → A): exclude a thread from the trusted-unresolved count only when
**all** its comments are engine-authored (marker-matched). Any external trusted comment keeps the
thread live.

**Rationale**: the existing handler treats a thread as live if ANY comment is trusted, and FR-002
keeps human trust authorship-based and first-class. Suppressing on any engine marker would silently
drop a human's trusted reply to an engine finding.

**Implementation**: `thread.comments.every(c => commentCarriesEngineAuthoredReviewMarker(c.body))`
in the trust loop (`pr-feedback-monitor-service.ts:264-286`). The marker helper already encodes the
column-0, case-sensitive, `> `-quoted-excluded match rule (#1127) — do not re-implement it.

## Decision 5 — Counter reset semantics (FR-006)

**Decision** (clarification Q3 → A): a new human review/comment submitted after the cap is hit
resets the remediation budget. Reset is authorship-based, never content-based; full thread
resolution and gate-label removal alone do **not** reset it.

**Implementation** (plan D-2): the remediation counter is the artifact `round`. The adapter clears
the review artifact (`clearReviewArtifact`) whenever it seeds from a fresh trusted-external
trigger, so the seed-aware wrapper derives `round = 1`. Because the adapter only runs on a
trusted-external monitor trigger (authorship-gated upstream), the reset is authorship-based by
construction.

**Rationale**: "all threads resolved" is engine-triggerable and purpose-mismatched; the cited
#1070 reset site resets a *different* counter (`fixerTimeoutRetryCount`). Operator gate-label
removal would silently refill the budget without new work. Ruling out "any of the above".

## Decision 6 — Retire `blocked:stuck-feedback-loop` (FR-005/FR-007/FR-008)

**Decision** (clarification Q5 → B): reduce `pr-feedback-handler.ts` to a thin adapter
(parser + seed writer), delete the `blocked:stuck-feedback-loop` apply-site (~611) and remove the
label from `label-definitions.ts`. Exhaustion now lands on `waiting-for:remediation-limit` via the
existing `on-remediation-limit` gate.

**Rationale**: full deletion would force re-homing the parser and risk dropping body-only findings;
keep-in-place would leave a second live fix path violating "one loop, one code path". Label removal
is a workflow-engine vocabulary change → **minor** bump per CLAUDE.md.

**Verify at implement time**: grep the monorepo for `stuck-feedback-loop` / `STUCK_FEEDBACK_LOOP`
to confirm no other consumer (cockpit label maps, tests) references it before deletion; migrate or
update those in the same PR.

## Decision 7 — No regression to preserved behaviors (FR-009)

Untrusted-notice episodes, the `blocked:*` skip guard, and the webhook+polling hybrid with adaptive
interval are **not** modified. The engine-exclusion guard is inserted *inside* the existing trust
loop and only reduces the trusted-unresolved set; all downstream Case A/B/C branches and the
adaptive-interval logic remain byte-identical on their inputs. Existing monitor test suites are the
regression oracle (SC-006).

## Feature-flag interaction

With `reviewPhaseEnabled = false` (default), `review` is absent from the effective sequence
(`getPhaseSequence`), so the adapter's phase-loop entry at `review` is unreachable and the legacy
routing (or a guarded fallback) applies. Enabling the flag is what activates the new path. The
monitor's engine-exclusion is inert on repos that have no engine-authored threads, so flag-off
clusters see no behavior change (SC-001/SC-003 are only meaningful with the epic enabled).

## References

- Engine review markers + match rule: `worker/review-poster.ts` (#1127).
- Findings artifact + verdict: `worker/review-artifact.ts` (#1124).
- Review→remediate seam + gate: `worker/phase-loop.ts`, `worker/config.ts`,
  `worker/phase-resolver.ts` (#1121/#1124/#1126).
- Full epic design: `docs/engine-review-remediate-plan.md` (generacy-ai/tetrad-development).

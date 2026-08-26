# Research: Resume label-strip fix (#1154)

All source references pinned at develop `155b3464` per the spec; branch offsets have shifted, so implement against symbols not raw line numbers.

## Decision 1 — FR-001: guard `onResumeStart()` with `isHumanGateCompletion()` (not a pre-strip snapshot)

**Decision**: Guard the completed-strip loop in `LabelManager.onResumeStart()` with the already-existing `isHumanGateCompletion(completedLabel)` predicate. Do NOT implement the alternative (evaluate the reset / no-op / already-satisfied checks against a pre-strip label snapshot threaded through the worker into the phase loop).

**Rationale**:
- `isHumanGateCompletion()` and `HUMAN_GATE_SUFFIXES` already exist in `label-manager.ts` for exactly this purpose but were never consulted by `onResumeStart()`. Reusing them is the smallest correct change.
- The fix stays local to one method. The snapshot alternative spreads a new parameter across `claude-cli-worker.ts` → `PhaseLoop` → every gate/no-op/reset check — more surface, more regression risk, and it leaves the strip itself still discarding the label (only compensating downstream).
- Q1→A settled scope: exempt the **full** `HUMAN_GATE_SUFFIXES` set. Repeatable clarification-style gates (`clarification`, `spec-review`, etc.) resume at a *later* phase, so a surviving `completed:<X>` is never re-checked at the resume phase → no immediate-refire regression. The Assumptions section confirms the set cannot be shrunk by a repo-level workflow override.

**Note on the strip's remaining scope**: every `waiting-for:<suffix>` label denotes a gate by construction, and `HUMAN_GATE_SUFFIXES` covers all gate suffixes (`GATE_MAPPING` + `WORKFLOW_GATE_MAPPING` + supplemental). After the guard, the completed-strip effectively becomes a no-op for gate completions — which is the intended behavior. The `waiting-for:*` and `agent:paused` removals in the same method are the parts that still do real work and stay unchanged.

**Alternatives considered**:
- Pre-strip snapshot (offered by the issue) — rejected as above.
- Narrow the exemption to only at-phase-re-evaluating gates (Q1 option B) — rejected by clarification Q1→A.

## Decision 2 — FR-004: `ci` mapping = `{ phase: 'validate', resumeFrom: 'validate' }`

**Decision**: Add `'ci': { phase: 'validate', resumeFrom: 'validate' }` to `GATE_MAPPING`.

**Rationale**:
- `waiting-for:ci` is raised during `validate` (before `completed:validate` exists), so the terminal no-op short-circuit cannot fire — a terminal treatment would be unreachable (Q2→A). Re-running `validate` re-verifies CI is green on the new head (US3).
- Membership in `GATE_MAPPING` auto-adds `ci` to the derived `HUMAN_GATE_SUFFIXES`, giving it the FR-001 strip exemption consistently with every other gate (SC-005).
- Today `completed:ci` resume only works via the full-revalidate fallback in `resolveFromContinue`; a defined mapping makes the resume deterministic.

**Alternatives considered**:
- Terminal treatment like implementation-review (Q2 option B) — rejected: the gate fires before `completed:validate`, so the short-circuit's precondition can never hold.

## Decision 3 — FR-005: hidden-marker comment dedupe

**Decision**: Prepend `<!-- generacy-remediation-limit -->` to the "Remediation limit reached" body and skip posting when `listPrCommentBodies()` already contains the marker.

**Rationale**:
- Mirrors existing engine-authored marker patterns (e.g. `maybePostUntrustedNotice`, other `<!-- generacy-* -->` markers) — a proven, low-risk pattern already in the codebase.
- "One comment per distinct cap pause" (SC-004) is satisfied because a genuine new cap pause follows a real resume cycle, and a real resume runs FR-002's reset+re-arm branch (which clears `completed:remediation-limit`) plus FR-006's defensive clear. The dedupe guards only the resume/re-pause thrash on the *same* count. A future genuine pause posts once more only if the operator has since answered and the counter re-hit the cap — a different pause event.
- Marker matching is a substring `includes` on comment bodies, case-sensitive, same as sibling markers.

**Alternatives considered**:
- Track a "already posted" flag in Redis / phaseTracker — rejected as over-engineered; the PR comment history is already the durable source of truth and the marker grep is stateless.

## Decision 4 — FR-006: defensive clear placement (clean review pass)

**Decision**: Clear a lingering `completed:remediation-limit` inside the clean-review side-effect block, gated on `artifact.verdict === 'clean'`, best-effort (try/catch, non-fatal).

**Rationale**:
- Q3→B mandates a clear that is **distinct from and additional to** FR-002's reset-branch removal. The reset branch only fires when a resume actually runs it; an answer that lingers past that branch must still be cleared on a clean review so it cannot pre-satisfy the *next* cap pause.
- The clean-review block is the natural "the review converged, we are moving on" checkpoint, and it already performs GitHub label/PR mutations (`markReadyForReview`), so adding a best-effort label removal there is consistent.
- Best-effort (swallow + warn) because a comment/label API hiccup must not fail an otherwise-clean review pass.

**Alternatives considered**:
- Clear only in the reset branch (Q3 option A) — rejected by Q3→B: leaves the pre-satisfy hole open.

## Decision 5 — FR-007: integration test drives the real `onResumeStart()`

**Decision**: New integration test builds a `PhaseLoop` with a real `LabelManager` (so `onResumeStart()` actually runs) and a fake label-backed `GitHubClient`, then drives resume for both P0 gates.

**Rationale**:
- The existing unit tests inject labels directly into the phase loop and bypass `onResumeStart()`, which is precisely why this bug class was invisible (SC-001/SC-002 measurement in the spec). Exercising the real strip is the only way to regression-lock the fix.
- Fake `GitHubClient` models mutable label state so `removeLabels` / `addLabels` / `getIssue` / `getIssueLabels` reflect the strip and the reset+re-arm, letting the test assert the counter reset, the cleared gate label, and the loop proceeding (SC-001) plus the terminal short-circuit with no `validate` re-run (SC-002).

**Alternatives considered**:
- Extend the existing label-injection unit tests — rejected: they cannot reach `onResumeStart` and would re-encode the same blind spot.

## Changeset

`@generacy-ai/orchestrator` **patch** — internal bug fix across `label-manager.ts`, `phase-resolver.ts`, `phase-loop.ts`; no new public exports, no new label vocabulary (`waiting-for:ci` / `completed:ci` already exist from #1133). Single `.changeset/1154-resume-gate-strip.md`.

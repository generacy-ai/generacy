# Research: Manual-task awareness in the #1187 tasks.md safety net (#1214)

All five design-shaping questions were resolved in `clarifications.md`; this file records the decisions, rationale, and rejected alternatives, plus the code-grounding verified at plan time.

## Decision 1 — Label sequence at pause: completed-at-pause (Q1=A)

**Decision**: On manual-validation pause, run `labelManager.onPhaseComplete('implement')` first (grants `completed:implement`), then `onGateHit('implement', 'waiting-for:manual-validation')`.

**Rationale**: `GATE_MAPPING['manual-validation']` already carries `{ phase: 'validate', resumeFrom: 'validate' }` (`phase-resolver.ts:16`) — a phase *after* implement. The resolver can only resolve cleanly at `validate` if `completed:implement` exists. The #1133 on-ci-green gate (`phase-loop.ts:1937-1952`) is the exact precedent: it grants `completed:validate` at pause for the same reason. Ordering is safe against the #958 assumption at `label-manager.ts:287-292` because `onPhaseComplete` already removed `phase:implement`, so `onGateHit`'s removeLabels is a no-op — identical to the ci-green path.

**Rejected**:
- **B — `onPhaseExecutedWithoutCompletion('implement')` + extend the resolver**: extends the resolver for a label state only this one gate produces; more surface, no benefit.
- **C — bare `onGateHit` + change `GATE_MAPPING['manual-validation']` to resume at `implement`**: changes resume semantics of an existing gate other flows may rely on; also re-runs implement, which is exactly the wasted pass the feature eliminates.

**Verified at plan time (Assumption 4)**: no `DEFAULT_RESUME_RETAIN_SUFFIXES` change. The set is `['remediation-limit', 'dependency-limit']` (`label-manager.ts:107`) — those gates resume *at* the gated phase and must survive the strip. `manual-validation` resumes *past* the gate check (at `validate`), so the standard strip of `completed:manual-validation` on resume is correct (re-arms the gate). `completed:implement` is a phase completion, which `onResumeStart`'s strip never touches (it only removes `completed:<X>` paired with a co-present `waiting-for:<X>`).

**Required side effect**: the comment at `phase-loop.ts:1930-1932` claims ci-green is "the one gate where `completed:<phase>` is granted at pause" — must be updated (manual-validation becomes the second).

## Decision 2 — Keyword tier: first-4-words positional match (Q2=B)

**Decision**: When no `[manual]` marker is present, classify a task manual iff a case-insensitive whole-word keyword (`manual`, `manually`, `hand-test`) appears in the **first 4 words** of the task text after the checkbox capture / heading task-ID (+ optional `[DONE]`).

**Rationale**: Keywords are the medium-confidence tier (agency `implement.md:176-178`). Imperative manual tasks front-load the keyword ("Manually verify …", "Hand-test the …"); mid-sentence noun uses ("update the user manual", "add manuals directory") never appear that early. A false positive suppresses re-entry only when ALL remaining unchecked tasks classify manual, and the result is a visible labeled pause a human can override — so residual miss risk is acceptable. Mirrors the strict-positional discipline of `HEADING_DONE` (`tasks-md-fallback.ts:39`).

**Rejected**:
- **A — whole-word anywhere**: misfires on "user manual"-style noun uses, silently suppressing legitimate re-entry — the inverse of the current bug.
- **C — exact leading verbs only**: misses real phrasings like "Verify the deploy manually completes" that the evidence corpus suggests are common.

## Decision 3 — Marker tier: `[manual]` anywhere, both grammars (Q3=A)

**Decision**: The literal bracketed token `/\[manual\]/i` classifies a task manual anywhere in the task line — checkbox grammar (anywhere after `- [ ]`) and heading grammar (anywhere after the task ID) alike.

**Rationale**: Evidence case #2714 used `[manual]` markers that were ignored; strict positioning would re-miss real-world placements like trailing `[manual]`. The marker check is orthogonal to counting: it never affects checked/unchecked and never interacts with the strict `HEADING_DONE` `[DONE]`-after-ID rule — a heading line may carry both tokens (a checked manual task is simply checked).

**Rejected**:
- **B — immediately-after-ID (mirror `[DONE]`)**: symmetric but re-misses trailing placements, i.e. re-creates #2714.
- **C — checkbox grammar only**: heading-grammar manual tasks would silently re-enter; grammar coverage should be uniform since #1187 counts both.

## Decision 4 — Precedence + failure mode: label wins, fail-open to classification (Q4=A)

**Decision**: A `waiting-for:manual-validation` label on the issue suppresses partial synthesis unconditionally, regardless of tasks.md contents. Label-read failure falls back to tasks.md classification as if the label were absent — never blind re-entry, never fail-closed.

**Rationale**: The label is the agent's explicit protocol signal (agency `implement.md:174-186`); overriding it from a heuristic count would fight the protocol. Fail-open-to-classification matches the existing philosophy at `tasks-md-fallback.ts:14-16` and `:88-91`. When the label is present but classification reports automatable unchecked tasks, log a structured divergence warning (shape mirroring `phase-loop.ts:928-946`) so operators can spot agent mislabeling.

**Rejected**:
- **B — tasks.md wins**: forces re-entry over the agent's explicit pause signal; a stale count (e.g. tasks checked but file not yet committed) would burn a wasted CLI run.
- **C — fail-closed on label-read failure**: strands genuinely incomplete stories on transient GitHub errors.

## Decision 5 — WIP commit before pause (Q5=A)

**Decision**: The pause path always runs `prManager.commitPushAndEnsurePr` (honoring `pushRefused` with an aborting return, per #1051) and propagates `prUrl` BEFORE applying labels — mirroring the #1211 dependency-block sequence exactly.

**Rationale**: Option B's premise ("the phase's normal commit already ran") is factually wrong: the safety-net region (`phase-loop.ts:919-952`) and the #1211 branch (`:956-1064`) both run BEFORE the normal step-5 commit at `:1396`. An early `gateHit` return skips the phase's only commit path — the tree may hold real work from the just-finished increment.

**Rejected**:
- **B — no commit**: loses uncommitted increment work across the pause.

## Decision 6 — Guard-branch pause (FR-009/010)

**Decision**: When the no-progress guard fires (`tasksRemaining >= lastTasksRemaining` at `phase-loop.ts:1071`), re-evaluate the remainder (label check + tasks.md classification) before escalating; a human-gated remainder pauses via the Decision-1/5 sequence instead of `failed:implement`.

**Rationale**: This covers the sentinel-present path the safety-net block never sees — an agent that emits `SPECKIT_IMPLEMENT_PARTIAL` over a purely-manual remainder loops once, makes no progress, and would otherwise be failed exactly like the field cases. Automatable-remainder guard behavior stays byte-identical (failure path untouched).

**Rejected**:
- **Guard unchanged (safety-net-only fix)**: leaves a one-sentinel-away regression to the original bug.

## Sources

- `specs/1214-summary-1187-tasks-md/spec.md` (FR-001..FR-013, SC-001..SC-009)
- `specs/1214-summary-1187-tasks-md/clarifications.md` (Q1-Q5, batch 1, 2026-08-27)
- `packages/orchestrator/src/worker/tasks-md-fallback.ts` (current #1187 evaluator)
- `packages/orchestrator/src/worker/phase-loop.ts` (`:914-952` safety net, `:954-1064` #1211 template, `:1071` guard, `:1923-1952` #1133 gate)
- `packages/orchestrator/src/worker/phase-resolver.ts:16` (`manual-validation` GATE_MAPPING entry)
- `packages/orchestrator/src/worker/label-manager.ts` (`:69-86` HUMAN_GATE_SUFFIXES/isHumanGateCompletion, `:107` retain set, `:287-292` #958 assumption)
- Evidence: Painworth/ai-lawfirm#2723 (keyword tier), #2714 (marker tier)

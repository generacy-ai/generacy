# Clarifications: #1214 — tasks.md safety net vs. manual-verification tasks

## Batch 1 — 2026-08-27

### Q1: Label state on manual-validation pause
**Context**: Spec Assumption 3 explicitly defers this. `waiting-for:manual-validation` resumes at `validate` (per `GATE_MAPPING` in `phase-resolver.ts`), a *later* phase than `implement`. But `LabelManager.onGateHit('implement', ...)` only removes `phase:implement` and adds the gate + `agent:paused` — it never grants `completed:implement`. Per the #958 contract, `completed:<phase>` is normally applied *after* the gate check, so a bare `onGateHit` leaves a label set the resolver may not be able to resolve at `validate` on resume. The #1211 dependency-block precedent uses bare `onGateHit`, but that gate resumes AT `implement`, so it never faces this problem.
**Question**: When the safety net pauses at `waiting-for:manual-validation` (manual-only remainder), which label sequence should the engine apply?
**Options**:
- A: `onPhaseComplete('implement')` first (grants `completed:implement`), then `onGateHit('implement', 'waiting-for:manual-validation')` — treats implement as done for resolver purposes; resume at `validate` resolves cleanly.
- B: `onPhaseExecutedWithoutCompletion('implement')` then apply gate labels — implement is *not* marked complete (manual tasks remain unchecked in tasks.md), and the resolver/resume path is extended to handle this state.
- C: Bare `onGateHit('implement', 'waiting-for:manual-validation')` (mirror #1211) and change `GATE_MAPPING['manual-validation']` to resume at `implement` instead of `validate`.

**Answer**: *Pending*

### Q2: Keyword-detection matching semantics
**Context**: FR-006 classifies tasks as manual via keywords (`manual`, `manually`, `hand-test`, `manually verify`) when no `[manual]` marker is present. Substring matching would misfire on task text like "update the user manual" or "add manuals directory", silently suppressing legitimate re-entry (the inverse of the current bug). The evidence cases (#2723 T028/T029) contain phrases like "Manually verify" at the start of the task text.
**Question**: How strict should keyword matching be for classifying a task as manual-verification?
**Options**:
- A: Case-insensitive whole-word match anywhere in the task text (`\bmanual(ly)?\b`, `\bhand-test\b`) — accepts some false positives like "user manual" in exchange for catching all phrasings.
- B: Case-insensitive match only when the keyword appears in the first N words (e.g., first 4) of the task text after the checkbox/ID — targets imperative task phrasing ("Manually verify X…") and avoids mid-sentence noun uses.
- C: Only exact leading verbs (`Manually …`, `Hand-test …`, `Verify manually …`) — lowest false-positive rate; misses tasks phrased differently.

**Answer**: *Pending*

### Q3: Manual classification for the heading task grammar
**Context**: `countTasks` recognizes two grammars: checkbox (`- [ ] T001 …`) and heading (`### T001 …` / `### T001 [DONE] …`). FR-005/FR-006 describe the `[manual]` marker and keywords for classification, but the heading grammar has strict position rules (`[DONE]` must appear immediately after the task ID, per FR-002 of #1187). Evidence case #2714 used `[manual]` markers and still failed, so marker handling must be pinned for whichever grammars it applies to.
**Question**: Does manual classification apply to both grammars, and where must the `[manual]` marker appear?
**Options**:
- A: Both grammars; `[manual]` recognized anywhere in the task line (checkbox: anywhere after `- [ ]`; heading: anywhere after the task ID) — lenient, matches how authors actually write it.
- B: Both grammars; `[manual]` must appear immediately after the task ID (mirroring the strict `[DONE]` position rule) — strict and symmetric, but risks missing real-world placements like trailing `[manual]`.
- C: Checkbox grammar only — heading tasks are never classified manual (heading grammar is rare and the evidence is checkbox-based).

**Answer**: *Pending*

### Q4: Precedence when the label and tasks.md disagree
**Context**: FR-001..004 say the `waiting-for:manual-validation` label suppresses partial synthesis, while US2's acceptance says a mixed remainder (manual + automatable unchecked tasks) still re-enters. These can conflict: the label may be present on the issue while tasks.md still shows unchecked *automatable* tasks (e.g., operator applied the label early, or a prior increment left work behind). There is also the failure mode where the label read itself errors.
**Question**: When the issue carries `waiting-for:manual-validation` but tasks.md still has unchecked automatable tasks, and when the label read fails, what should the safety net do?
**Options**:
- A: Label wins unconditionally — never synthesize partial when the label is present, regardless of tasks.md contents; label-read failure falls back to tasks.md classification (fail-open to classification, not to blind re-entry).
- B: tasks.md wins — automatable-unchecked > 0 forces re-entry even with the label present (label only matters when the automatable remainder is zero); label-read failure behaves as label-absent.
- C: Label wins, and label-read failure also suppresses re-entry (fail-closed) — safest against wasted CLI runs but can strand genuinely incomplete stories on transient GitHub errors.

**Answer**: *Pending*

### Q5: WIP commit on the manual-pause path
**Context**: The #1211 dependency-block pause commits and pushes WIP (via `prManager.commitPushAndEnsurePr`, honoring the #1051 `pushRefused` abort) *before* posting its marker comment and applying gate labels, so the checkout state survives the pause. The new manual-validation pause path (FR-009/FR-010: no-progress guard pauses instead of failing when the remainder is human-gated) occurs at the same structural point in the phase loop, but the spec does not say whether it must also commit/push first.
**Question**: Should the manual-validation pause path perform a WIP commit/push (honoring `pushRefused`) before applying the gate labels, mirroring the #1211 precedent?
**Options**:
- A: Yes — always commit/push any uncommitted work before pausing (mirror #1211; the tree may hold real work from the just-finished increment).
- B: No — the pause fires after a successful implement phase whose normal commit path already ran; an extra commit step is redundant and adds failure surface.

**Answer**: *Pending*

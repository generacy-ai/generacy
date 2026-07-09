# Clarifications: `cockpit resume <issue-ref>`

Source spec: [`spec.md`](./spec.md)
Issue: [generacy-ai/generacy#891](https://github.com/generacy-ai/generacy/issues/891)

## Batch 1 — 2026-07-09

### Q1: Phase → gate mapping (esp. multi-gate phases)

**Context**: The spec's Assumption #1 says the mapping "isn't a 1:1 identity" is possible, and code confirms this: `waiting-for:clarification` (not `waiting-for:clarify`), `waiting-for:implementation-review`, `waiting-for:tasks-review`. Worse, `packages/orchestrator/src/worker/config.ts` shows the `implement` phase has **three** distinct gates in the label protocol: `waiting-for:implementation-review`, `waiting-for:sibling-review`, `waiting-for:merge-conflicts`. FR-002 speaks of THE `<gate>` singular. For `failed:implement`, which gate does `resume` restore?

**Question**: How does `resume` pick `<gate>` when a phase has multiple gates in the label protocol?

**Options**:
- A: Use a single canonical "default" gate per phase (e.g. `implement → implementation-review`, `tasks → tasks-review`, `clarify → clarification`, `validate → validation` (or similar), etc.). Multi-gate phases fold to their primary review gate. `resume` picks the default; other gates are handled by the phase itself on re-run.
- B: Refuse in the multi-gate case unless the failed issue also carries a hint label naming the specific gate to restore (e.g. `failed:implement:sibling-review`). Without a hint, exit non-zero with evidence per FR-004.
- C: Restore ALL gates listed for that phase in the label protocol (add each gate's `waiting-for:<gate>` + `completed:<gate>` pair). The label monitor's next poll picks whichever the detector matches first.
- D: The verb only supports single-gate phases (clarify, tasks, validate); `failed:implement` is out of scope and treated as a refusal.

**Answer**: *Pending*

---

### Q2: `agent:error` presence as re-arm precondition

**Context**: US1 AC-1 lists the input state as `{agent:error, failed:validate}`. FR-002 says "labels including `agent:error` and exactly one `failed:<phase>`". But nothing in the spec addresses what happens when `failed:<phase>` is present **without** `agent:error` — a state that can occur if a workflow explicitly sets `failed:<phase>` (e.g. gate refusal, manual failure) without the runtime error flag. This matters because it decides which branch (FR-002 happy path, FR-003 no-op, or FR-004 refusal) the verb takes.

**Question**: When an issue has `failed:<phase>` but **not** `agent:error`, what does `resume` do?

**Options**:
- A: Treat as valid re-arm — `failed:<phase>` alone is sufficient. Remove `failed:<phase>` (and `agent:error` if present, defensively), apply the resume-pair. `agent:error` is a "belt-and-suspenders" input that isn't required.
- B: Treat as no-op (FR-003 path) — without `agent:error` the issue isn't "in a failed state" the verb is designed to recover. Exit 0 with an explanatory line.
- C: Treat as refusal (FR-004 path) — the label state is inconsistent (partial failure evidence); exit non-zero with an evidence line naming the missing `agent:error`.

**Answer**: *Pending*

---

### Q3: `phase:<phase>` label handling

**Context**: The label protocol includes `phase:<phase>` progress labels (e.g. issue #891 currently carries `phase:clarify`). `LabelManager.onGateHit` **removes** `phase:<phase>` when it applies `waiting-for:<gate>`. The spec's FR-002 enumerates only four mutations (remove `agent:error`, remove `failed:<phase>`, add `waiting-for:<gate>`, add `completed:<gate>`) and does NOT mention `phase:<phase>`. But the worker's startPhase resolver may depend on `phase:<phase>` state, and a `failed:<phase>` issue likely still carries the corresponding `phase:<phase>`.

**Question**: Does `resume` also mutate the `phase:<phase>` label, and if so how?

**Options**:
- A: Leave `phase:<phase>` alone — the spec's four mutations are the complete set. The worker resolver keys off the resume-pair, not `phase:<phase>`.
- B: Ensure `phase:<phase>` is **present** — if missing, add it. The resolver needs it to pick `startPhase = <phase>`. `resume` becomes a five-mutation operation.
- C: **Remove** `phase:<phase>` to mirror `onGateHit`'s exact effect. The resume detector re-adds it when the issue is dequeued and the worker starts the phase.
- D: Not the `resume` verb's concern — leave `phase:<phase>` in whatever state the failed phase left it. Planning phase confirms by reading the resolver.

**Answer**: *Pending*

---

### Q4: `agent:paused` alongside the resume pair

**Context**: `LabelManager.onGateHit` applies **three** labels for a natural pause: `waiting-for:<gate>`, `completed:<phase-of-previous>` (the paused-phase's completion marker), AND `agent:paused`. The resume detector's predicate (per FR-002 and #845) speaks of the `waiting-for:<gate>` + `completed:<gate>` pair — but whether the detector *also* requires `agent:paused` for pickup is not specified in the spec, and getting it wrong silently strands FR-009's regression test.

**Question**: Does `resume` also apply `agent:paused` to fully mirror a naturally paused state?

**Options**:
- A: Yes — apply `agent:paused` too. The resume verb produces a state indistinguishable from a naturally-paused-then-completed gate, so any detector predicate (present or future) works. Log line reports five mutations, not four.
- B: No — only the four mutations in FR-002. The resume detector explicitly checks `waiting-for` + `completed` only; `agent:paused` is observability metadata for humans, not part of the detector predicate.
- C: Only if the detector requires it. Planning phase reads the detector code and picks A or B accordingly. Spec assumption: whichever matches the poll-path resume detector's exact predicate.

**Answer**: *Pending*

---

### Q5: Preserve prior `completed:<earlier-phase>` markers

**Context**: A `failed:validate` issue has typically accumulated `completed:specify`, `completed:clarify`, `completed:plan`, `completed:tasks`, `completed:implement` from prior phases. The worker's startPhase resolver uses these to pick the correct start phase — without them, it may back up to `specify` and re-run everything (which is what `process:*` re-queue does, and what US1 explicitly wants to AVOID: "without losing prior phase artifacts"). The spec does not explicitly state that these markers are preserved.

**Question**: What is `resume`'s obligation with respect to prior-phase `completed:*` labels?

**Options**:
- A: Preserve all existing `completed:<earlier-phase>` labels. The four FR-002 mutations are the ONLY changes; prior state is otherwise untouched. This is the intent (US1 preservation of prior artifacts) but should be spelled out.
- B: `resume` does not touch prior-phase completions — but the worker's startPhase resolver is verified in FR-009 to pick `<phase>` on the re-armed issue. If the resolver walks the `completed:*` chain, preservation is implicit.
- C: `resume` explicitly re-asserts prior-phase completions (idempotent re-add) so a stray label deletion elsewhere doesn't corrupt the re-arm. Adds robustness at the cost of extra `gh` calls.

**Answer**: *Pending*

---

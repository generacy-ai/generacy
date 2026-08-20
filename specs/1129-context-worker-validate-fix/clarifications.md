# Clarifications: Route validate failures into the remediate loop

## Batch 1 — 2026-08-20

### Q1: Validate-failure → remediate entry mechanism
**Context**: The existing remediate seam (`phase-loop.ts:1270`) fires only after
`review` completes successfully, driven by `deps.remediateTrigger(context)` which
reads the review findings artifact verdict. A `validate` failure instead lands in
the `if (!result.success)` block (`phase-loop.ts:804`), which escalates and
`return`s. There is currently no path from a validate failure into the remediate
seam, so the routing mechanism must be defined.
**Question**: How should a validate failure route into the remediate loop?
**Options**:
- A: In the validate-failure branch, directly drive an off-sequence `remediate`
  inline (mirroring the review seam), then backtrack `i` to re-run `review`
  (delta-scoped) then `validate`.
- B: Have the validate failure synthesize a `changes-required` review findings
  artifact from the validate evidence, then backtrack `i` to `review` so the
  existing `remediateTrigger`/seam picks it up naturally.
- C: Add a `WorkerContext` flag (e.g. `pendingValidateRemediation`) that
  `remediateTrigger` also honors, and backtrack to `review`.

**Answer**: B — Have the validate failure synthesize a `changes-required` review
findings artifact from the validate evidence, then backtrack `i` to `review` so the
existing `remediateTrigger`/seam picks it up naturally. Reuses the single existing
remediate seam and the artifact-round counter/gate that #1128 owns ("one loop, one
counter, one code path"); an inline driver would be invisible to the artifact-round
gate, and a `WorkerContext` flag cannot survive the gate pause/resume the persisted
counter requires.

### Q2: Interim autonomous fixing while `remediate` is a stub
**Context**: The real `remediate` executor is deferred to later epic issues; today
`remediate` is `runStubPhase('remediate')` — a synthetic success that changes no
code. If `validate-fix-handler` is fully retired now (FR-005), a validate red would
loop `remediate → review → validate` with no actual fix until the
`on-remediation-limit` pause.
**Question**: Given `remediate` is still a stub, what happens to autonomous validate
fixing in the interim?
**Options**:
- A: Fully retire `validate-fix-handler` now; accept no autonomous validate fix
  until the real remediate executor lands (routing-only; validate reds pause at
  `on-remediation-limit`).
- B: Reduce `validate-fix-handler` to a thin adapter that serves as the interim
  remediate behavior for validate evidence, preserving real autonomous fixing
  until the epic's real executor lands.

**Answer**: B — Reduce `validate-fix-handler` to a thin adapter that serves as the
interim remediate behavior for validate evidence. `remediate` is still
`runStubPhase` and the real executor lands in a later issue, so fully retiring now
would strand every validate red at the human cap gate; the thin adapter keeps a
single path and carries the sibling-overlap guard (Q5) for free.

### Q3: Shared remediation counter and `on-remediation-limit` gate for validate
**Context**: The `on-remediation-limit` gate (`phase-loop.ts:1122`) reads the review
findings artifact's `round` and requires `verdict === 'changes-required'`. FR-002
says validate remediations share the `maxRemediations` budget with review.
**Question**: How does a validate-driven remediation increment and become visible to
the `on-remediation-limit` gate against the shared `maxRemediations` budget?
**Options**:
- A: Validate failures write/advance the same review findings artifact (bump
  `round`, set `verdict: 'changes-required'`) so the existing gate works unchanged.
- B: Track the validate remediation via the same in-loop `reviewRound` counter but
  without touching the review artifact; extend the gate to also consider a
  validate-pending signal.

**Answer**: A — Validate failures write/advance the same review findings artifact
(bump `round`, set `verdict: 'changes-required'`) so the existing gate works
unchanged. The `on-remediation-limit` gate reads the persisted artifact round
against the shared `maxRemediations`, so advancing that same artifact makes a
validate remediation count against the shared FR-002 budget with zero change to the
gate #1128 owns.

### Q4: Label semantics on the new path
**Context**: Today a validate failure escalates via `failed:validate` (`onError`).
The new path removes first-red escalation. Two terminal outcomes exist: budget
exhaustion (`on-remediation-limit` → `waiting-for:remediation-limit`) and
fingerprint repeat (`failed:validate-repeated`, `REPEAT_FAILURE_THRESHOLD = 2`).
**Question**: On the routed path, is `failed:validate` still applied, and which label
marks budget exhaustion?
**Options**:
- A: `failed:validate` is no longer applied for a routed validate red; budget
  exhaustion pauses with `waiting-for:remediation-limit`; `failed:validate-repeated`
  (fingerprint) is the sole terminal failure label.
- B: Keep `failed:validate` as the terminal escalation when the loop ends without a
  green validate, alongside the fingerprint backstop.

**Answer**: A — `failed:validate` is no longer applied for a routed validate red;
budget exhaustion pauses with `waiting-for:remediation-limit`;
`failed:validate-repeated` (fingerprint, `REPEAT_FAILURE_THRESHOLD = 2`) is the sole
terminal failure label. The design removes first-red escalation and forbids a
terminal label that silently strands the loop; exhaustion is a resumable gate, not a
failure label.

### Q5: Sibling-owned-file overlap protection
**Context**: `validate-fix-handler` performs a sibling-owned-file overlap check —
it enumerates open PRs to the same base branch, tells the fixer not to recreate
their files, and reverts + escalates if the commit touches a sibling-owned file.
The generic `remediate` path has no equivalent guard.
**Question**: Must the sibling-owned-file overlap protection be preserved when
validate failures route through remediate?
**Options**:
- A: Preserve it — the validate remediation prompt/commit must retain the
  sibling-owned-file avoidance and revert-on-overlap guard.
- B: Drop it — accept the generic remediate behavior; sibling-overlap protection is
  not required for the routed validate path.

**Answer**: A — Preserve it — the validate remediation prompt/commit must retain the
sibling-owned-file avoidance and revert-on-overlap guard. Parallel epic siblings
share one base branch and can recreate each other's files (a live hazard — siblings
#1128/#1130/#1131/#1132 all edit `phase-loop.ts` against develop); under the thin
adapter the guard is preserved for free.

# Research: `cockpit resume <issue-ref>` — re-arm a failed phase

## Decision 1: Gate-mapping source of truth

**Decision**: `resume` derives `<preceding-gate>` by inverting `GATE_MAPPING` from `packages/orchestrator/src/worker/phase-resolver.ts` (overlaid with `WORKFLOW_GATE_MAPPING[workflowName]`), NOT by inverting `WorkerConfigSchema.gates` in `packages/orchestrator/src/worker/config.ts`.

**Rationale**: Two candidate sources exist and give different answers:

- **`WorkerConfigSchema.gates`** describes which gates *fire during* a given phase (e.g. `speckit-feature.implement` fires `waiting-for:implementation-review`). Its map is phase → gate-fired-in-that-phase.
- **`GATE_MAPPING`** describes what phase to resume to when a gate is completed (e.g. `completed:implementation-review` → `resumeFrom: 'validate'`). Its map is gate → resumeFrom.

The verb's job is to restore a label pair that makes `PhaseResolver.resolveFromContinue` pick `<phase>` as `startPhase`. That resolver is what `GATE_MAPPING` was built for; the resolver walks completed gates and returns their `resumeFrom`. So the inversion is: find gates `G` where `GATE_MAPPING[G].resumeFrom === <phase>`. `WorkerConfigSchema.gates` is a red herring here — restoring `implementation-review` for `failed:implement` would send the resolver to `validate` (wrong direction).

The Q1 clarification's phrasing ("workflow config's phase/gate order") is best read as the *effective* gate map available to the resolver (which is `GATE_MAPPING` with per-workflow overlay), not the per-workflow trigger list in `WorkerConfigSchema.gates`.

**Alternatives considered**:
- **Invert `WorkerConfigSchema.gates`**: rejected. Wrong semantic direction (see above). Would produce the pair `waiting-for:implementation-review` + `completed:implementation-review` for `failed:implement`, sending the resolver to `validate` — the exact behavior the T-S2 by-hand surgery was working around.
- **Hardcode a phase → gate map in `resume.ts`**: rejected. Spec's Assumption §1 explicitly forbids this — a workflow-config change must not silently break the verb.
- **Duplicate the map into `packages/workflow-engine`**: deferred to implementation. If the direct cross-package import from orchestrator surfaces a circular-dep concern, this becomes the fallback.

## Decision 2: Tie-break when multiple gates map to the same `<phase>`

**Decision**: Prefer cross-phase gates (`entry.phase !== <phase>`) over self-loops. Among cross-phase candidates, prefer the nearest predecessor in `PHASE_SEQUENCE`. Among self-loop candidates, use stable insertion order.

**Rationale**: For `failed:validate`, two gates have `resumeFrom = 'validate'`:
- `implementation-review` (phase: implement) — a cross-phase gate that fires naturally at end of implement.
- `manual-validation` (phase: validate) — a self-loop that fires *during* validate.

Q1's answer explicitly chose `implementation-review` for `failed:validate`. That's the "the gate that naturally precedes the phase" — the cross-phase entry. The self-loop `manual-validation` would also produce the correct resolver outcome (`resumeFrom = validate`), but it represents an ambiguous state ("was this phase paused mid-execution, or naturally after implement?"), making downstream observability harder.

Explicitly documented tie-break case: **`failed:clarify`**. Cross-phase candidate is `spec-review` (phase: specify, resumeFrom: clarify). Self-loop candidates are `clarification` and `clarification-review` (both phase: clarify, resumeFrom: clarify). Per the cross-phase-first rule, `spec-review` wins. However `spec-review` is not fired by any workflow in `WorkerConfigSchema.gates` — it exists only in `WORKFLOW_LABELS`. Since applying it as an unfired-elsewhere label is possibly surprising, a follow-up option is to constrain the tie-break to gates *actually present* in the effective `WorkerConfigSchema.gates[workflowName]`. Plan defers this optimization; unit tests document the current tie-break in a truth-table so a change is visible.

**Alternatives considered**:
- **Prefer self-loop when it exists**: rejected. Loses the "byte-identical to a naturally-paused-then-completed gate" invariant Q4 explicitly targets — a self-loop like `manual-validation` implies the phase was paused for manual review, not that it completed and moved to the next phase.
- **Refuse in the multi-candidate case**: rejected. Blocks recovery for exactly the phases most operators would want to recover (`validate` and `clarify` both have multi-candidate). Q1 already resolved this to A (cross-phase preferred), not B (refuse).
- **Prefer the gate that maps to `phase === <phase>`** (opposite of chosen rule): rejected. Sends the same signal to the resolver but muddles the "which pause point were we at" observability.

## Decision 3: Mutation ordering (additions before removals)

**Decision**: Apply the three additions (`waiting-for:<preceding-gate>`, `completed:<preceding-gate>`, `agent:paused`) in a single `addLabels` call FIRST, then the up-to-three removals (`failed:<phase>`, `agent:error`, `phase:<phase>`) in a subsequent `removeLabels` call.

**Rationale (from spec Assumptions §7)**: `gh` doesn't offer a multi-label transaction. A mid-sequence failure between "additions applied" and "removals applied" leaves the issue in an over-labeled state — `{failed:<phase>, waiting-for:<preceding-gate>, completed:<preceding-gate>, agent:paused}`. Over-labeled is *recoverable* (running `resume` again is a no-op after the additions succeed, and the operator can inspect the issue), whereas the inverted order (removals first, additions second) can leave the issue "under-labeled" — `{}` on the failed side but no gate pair yet, so the monitor won't poll it and the operator has no signal that recovery is half-done.

**Alternatives considered**:
- **Removals first, additions second**: rejected per above.
- **Single mixed call `gh api PATCH /repos/.../issues/N/labels`**: `GhWrapper` doesn't currently expose a PATCH-style transaction. Extending `GhWrapper` would broaden the surface for a tiny gain. Deferred.
- **Interleave: add `agent:paused` first, then add gate pair, then remove failed set**: no benefit over the two-call sequence and harder to reason about.

## Decision 4: `agent:paused` is unconditionally applied (per Q4)

**Decision**: `agent:paused` is included in the additions triple regardless of whether the label-monitor's resume detector requires it.

**Rationale (from clarification Q4-A)**: The resume detector at `label-monitor-service.ts:157-179` checks *only* the `completed:<name>` + `waiting-for:<name>` pair. `agent:paused` is not required for the pair to fire. However Q4 asked for "byte-identical to a naturally-paused-then-completed gate" — `LabelManager.onGateHit` applies `agent:paused` on every natural pause. Including it makes the post-resume label set future-proof against any detector predicate change or observability tooling that keys off `agent:paused`.

The cost is exactly one extra label in the same API call — no additional round-trip, no branching. Confirmed by inspection: `gh issue edit --add-label a --add-label b --add-label c` is one call.

**Alternatives considered**:
- **Skip `agent:paused` since the detector doesn't need it** (Q4-B): rejected. Any future detector-predicate change silently strands the verb.
- **Read the detector at plan-time and pick A or B** (Q4-C): rejected. A holds unconditionally; no read-time deferral needed.

## Decision 5: Defensive removal semantics

**Decision**: `phase:<phase>` and `agent:error` are removed *only if present* in the fetched label set. The log line reports only the labels actually mutated — no "would have removed" entries.

**Rationale (from clarification Q3-C and spec FR-010)**: Q3 chose "remove `phase:<phase>` to mirror `onGateHit`'s exact effect" — but a `failed:<phase>` issue that took the `LabelManager.onError` path already has `phase:<phase>` removed (see `label-manager.ts:104-121` — `onError` removes `phase:<phase>` and adds `failed:<phase>` + `agent:error`). So `phase:<phase>` is typically already absent. The removal in `resume` is a defensive belt-and-suspenders for cases where the phase failed via a non-`onError` path (or a manual gate refusal).

Similarly `agent:error` may be absent on a manually-applied `failed:<phase>` — Q2 confirms `failed:<phase>` alone is a valid re-arm case.

Reporting only actual mutations in the log line prevents a scripted caller (auto-mode Requeue ledger) from over-counting phantom operations.

**Alternatives considered**:
- **Always attempt the removal, ignore 404s**: rejected. `gh` returns success on removing a label that isn't there, but the log line would then over-report the mutation. Fetch-first-then-decide is one extra round-trip but is already required to enter the classifier (we need labels to detect `failed:*`), so no additional API cost.
- **Skip fetch, `add` first and always `remove` all three**: rejected. `remove` on an absent label may (per `GhWrapper` semantics) throw — needs an audit and extra try/catch scaffolding.

## Decision 6: Workflow name resolution

**Decision**: Read `workflow:<name>` label from the issue's fetched label set. Fall back to `speckit-feature` if none is present (matching `label-monitor-service.ts:resolveWorkflowFromLabels`).

**Rationale**: The `GATE_MAPPING` overlay is workflow-scoped (`WORKFLOW_GATE_MAPPING['speckit-epic']` overrides some entries). The label-monitor already reads the issue's `workflow:*` label to pick the correct workflow for downstream dispatch — mirroring that resolution keeps the verb aligned with monitor behavior.

An explicit `--workflow <name>` flag is optional in v1 — the label-based fallback covers all currently-shipping workflows. If a workflow is ever added that the verb can't detect from labels alone, the flag becomes the escape hatch. Plan phase decision: include the flag scaffolding but keep it undocumented in v1 (parity with `advance --gate` which is required, whereas here it's optional).

**Alternatives considered**:
- **Always require `--workflow <name>`**: rejected. Loses idempotency ergonomics — the same command shouldn't need two args for a one-liner.
- **Always assume `speckit-feature`**: rejected. Silently mishandles `speckit-epic` `tasks-review` mapping (self-loop vs. cross-phase).

## Decision 7: Test scope — path-exhaustive + regression

**Decision**: `resume.test.ts` covers the classifier's 5+ decision branches with dedicated tests; `resume.regression.test.ts` proves the poll-path handoff end-to-end via a real `parseLabelEvent` + `PhaseResolver.resolveStartPhase` invocation against the post-resume label set.

**Rationale (from spec FR-008 + FR-009)**: The unit suite pins the CLI's decision logic (correctness of the labels chosen, refusal branches, ordering, defensive removals). The regression test pins the *contract with the monitor and resolver* — it's the "prove the by-hand surgery is now automated" test that spec FR-009 explicitly names. Splitting into two files matches the pattern used by `context.test.ts` (unit) + `context.artifact-paths.test.ts` (regression) elsewhere in the cockpit tree.

**Alternatives considered**:
- **One giant test file**: rejected. Same reasons as `context.test.ts` split — separate concerns, faster reading.
- **Integration test via a live `gh` process**: rejected. Adds test flake surface with no additional signal — the mock-based regression test already asserts on the label-set-in / phase-name-out contract, which is what matters.

## Implementation patterns

- **Commander subcommand shape**: mirror `advance.ts` almost exactly — same deps-injection surface, same `CockpitExit` translation, same `stdout`/`stderr` splittability.
- **Inverse map cache**: `resolvePrecedingGate` computes the inverted `GATE_MAPPING` once per module load (identical pattern to `buildGates()` in `gate-vocabulary.ts`). Workflow overlay applied per-call since the workflow arg varies.
- **`GhWrapper` interface** (from `@generacy-ai/cockpit`): already exposes `addLabels(nwo, n, string[])` and `removeLabels(nwo, n, string[])` (verified transitively via `advance.ts` `addLabel` — plural addLabels is used by the same file via `github.addLabels` in the orchestrator code path; if the wrapper only has singular `addLabel`, add a batching loop or extend the wrapper — implementation-phase decision).
- **Log line formatting**: `resumed <nwo>#<n>: re-armed phase=<phase> via preceding-gate=<preceding-gate>; added=[a,b,c] removed=[d,e]`. Single-line so a scripted caller can grep for `re-armed phase=` and parse the rest.

## Key sources / references

- **Spec**: `specs/891-found-during-cockpit-v1/spec.md`
- **Clarifications**: `specs/891-found-during-cockpit-v1/clarifications.md`
- **Prior work**:
  - **#822** — introduced `resolveIssueContext` as the unified issue-ref resolver.
  - **#850** — enforced the `no-restricted-imports` rule that prevents cockpit verbs from bypassing `resolveIssueContext`. Applies transitively to the new file.
  - **#845** — established the `waiting-for:<gate>` + `completed:<gate>` resume-pair as the label-monitor's poll-path detector predicate.
  - **#862** — retired the resume-branch `phase-tracker` dedupe key; the new verb is not affected but the removal simplifies the monitor's mental model referenced in the regression test.
  - **#830** — `resolveCockpitIdentity` for actor resolution. Not used by `resume` (no comment posted).
- **Verb reference**: `packages/generacy/src/cli/commands/cockpit/advance.ts` — the shape template.
- **Gate mapping source**: `packages/orchestrator/src/worker/phase-resolver.ts` — `GATE_MAPPING`, `WORKFLOW_GATE_MAPPING`.
- **Monitor detector**: `packages/orchestrator/src/services/label-monitor-service.ts:157-179` — the predicate the post-resume label set must satisfy.
- **Label protocol**: `packages/workflow-engine/src/actions/github/label-definitions.ts` — canonical label set.
- **Label lifecycle**: `packages/orchestrator/src/worker/label-manager.ts` — the pattern `resume` replicates on-issue.

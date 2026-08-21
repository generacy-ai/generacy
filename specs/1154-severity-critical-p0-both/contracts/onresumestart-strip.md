# Contract: `LabelManager.onResumeStart()` resume-strip behavior

Location: `packages/orchestrator/src/worker/label-manager.ts`

## Precondition
Called on every `continue` command from `claude-cli-worker.ts` before the phase loop, with the issue's current labels fetched.

## Behavior

`onResumeStart()` computes `labelsToRemove` and applies them. The removal set MUST:

1. **Remove** stale gate labels: every `waiting-for:<X>` currently present. *(unchanged)*
2. **Remove** `agent:paused` if present. *(unchanged)*
3. **Remove** `completed:<X>` for a co-present `waiting-for:<X>` **only when `isHumanGateCompletion('completed:<X>')` is `false`**. *(FR-001 — new guard)*

Because every `waiting-for:<X>` suffix `X` is a gate suffix and `HUMAN_GATE_SUFFIXES` covers all gate suffixes, condition (3) removes no `completed:<gate>` in practice — human-answer gate completions survive the resume.

## Postcondition invariants

- For every `X ∈ HUMAN_GATE_SUFFIXES`: if `completed:X` was present before the call, it is still present after. *(SC-003)*
- `waiting-for:*` and `agent:paused` labels present before the call are absent after. *(unchanged)*
- Non-gate `completed:<phase>` labels are unaffected.

## Test hooks
- Unit: `label-manager.onresumestart.test.ts` asserts SC-003 directly (retain human-gate completions; still remove stale `waiting-for:*` / `agent:paused`).
- Integration: `phase-loop.resume-gates.integration.test.ts` asserts the label survives long enough for the downstream reset / no-op branches to run (FR-007 / SC-001 / SC-002).

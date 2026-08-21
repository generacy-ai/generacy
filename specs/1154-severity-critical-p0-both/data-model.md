# Data Model: Resume label-strip fix (#1154)

No new persisted entities, types, or storage. The fix operates entirely on the existing GitHub-label protocol and the existing review-findings sidecar artifact. This document records the label lifecycle and set-membership invariants the fix depends on.

## GitHub labels (existing vocabulary)

| Label | Meaning | Applied by | Removed by |
|-------|---------|-----------|-----------|
| `waiting-for:<gate>` | A gate is parked awaiting a human answer | worker (gate hit) | `onResumeStart()` (stale-gate removal) — unchanged |
| `completed:<gate>` | Operator has answered the gate | operator | `onResumeStart()` completed-strip — **now guarded (FR-001)** |
| `agent:paused` | Workflow parked | worker | `onResumeStart()` — unchanged |
| `completed:<phase>` | A workflow phase finished | worker | n/a |

### Gate suffixes touched here
- `remediation-limit` (US1, P0) — in `GATE_MAPPING` → in `HUMAN_GATE_SUFFIXES`
- `implementation-review` (US2, P0) — in `GATE_MAPPING` → in `HUMAN_GATE_SUFFIXES`
- `ci` (US3, P1) — **added to `GATE_MAPPING` by FR-004** → newly in `HUMAN_GATE_SUFFIXES`

## `HUMAN_GATE_SUFFIXES` membership (derived set)

Derived at module load in `label-manager.ts` from three sources (union):

1. `Object.keys(GATE_MAPPING)` — `clarification`, `spec-review`, `clarification-review`, `plan-review`, `tasks-review`, `implementation-review`, `manual-validation`, `remediation-limit`, **`ci` (new)**
2. All keys across `WORKFLOW_GATE_MAPPING[*]` — `tasks-review`, `children-complete`, `epic-approval`
3. `SUPPLEMENTAL_HUMAN_GATE_SUFFIXES` — `sibling-review`, `merge-conflicts`

**Invariant (SC-005)**: after FR-004, `HUMAN_GATE_SUFFIXES.has('ci')` is `true`. No other membership changes.

**Invariant (FR-001)**: `isHumanGateCompletion('completed:<X>')` returns `true` for every `X ∈ HUMAN_GATE_SUFFIXES`; `onResumeStart()` must not strip any `completed:<X>` for which this predicate is `true`.

## `GATE_MAPPING` entry (FR-004)

```ts
'ci': { phase: 'validate', resumeFrom: 'validate' }
```

- `phase: 'validate'` — the gate belongs to the `validate` phase (where `waiting-for:ci` is raised on CI wait-timeout).
- `resumeFrom: 'validate'` — resume re-runs `validate` to re-verify CI is green on the new head (Q2→A). No terminal short-circuit for `ci` (its precondition `completed:validate` is absent when the gate fires).

## Review-findings sidecar (existing, read-only here)

`ReviewArtifactSchema` at `packages/orchestrator/src/worker/review-artifact.ts`:
- `verdict: 'clean' | 'changes-required'` — FR-006 reads this to decide whether to defensively clear `completed:remediation-limit`.
- `remediationCount: number` — reset to 0 by FR-002's reset-branch (`resetRemediationCount`); untouched by this fix otherwise.
- `round: number` — untouched.

No schema change.

## Comment marker (FR-005)

- `REMEDIATION_LIMIT_MARKER = '<!-- generacy-remediation-limit -->'` — a hidden HTML comment prepended to the "Remediation limit reached" body.
- Dedupe key: substring presence of the marker in the results of `listPrCommentBodies(owner, repo, prNumber)`.
- Not persisted anywhere except the PR comment stream itself (stateless dedupe).

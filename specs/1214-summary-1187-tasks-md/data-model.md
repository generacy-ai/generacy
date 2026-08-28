# Data Model: Manual-task awareness in the #1187 tasks.md safety net (#1214)

No persisted state is added (FR-013). All types are in-memory, in `packages/orchestrator/src/worker/`.

## Widened `TasksMdEvaluation` (tasks-md-fallback.ts)

```typescript
export type TasksMdEvaluation =
  | {
      kind: 'incomplete';
      unchecked: number;    // > 0
      automatable: number;  // > 0 (else the evaluation would be manual-only)
      manual: number;       // >= 0; unchecked manual tasks
      checked: number;
      total: number;
    }
  | {
      kind: 'manual-only';  // NEW: every unchecked task classifies manual
      unchecked: number;    // > 0
      manual: number;       // === unchecked
      checked: number;
      total: number;
    }
  | { kind: 'complete'; unchecked: 0; checked: number; total: number }
  | { kind: 'unreadable'; reason: string };
```

**Invariants**:
- `unchecked === automatable + manual` (incomplete variant).
- `manual-only` ⇔ `unchecked > 0 && automatable === 0`.
- `complete` and `unreadable` variants are byte-identical to #1187 — no manual fields (classification is irrelevant when nothing is unchecked or nothing is readable).
- Checked manual tasks are just checked: classification applies only to the unchecked remainder.

## Widened `countTasks` return (tasks-md-fallback.ts)

```typescript
export function countTasks(content: string): {
  unchecked: number;
  checked: number;
  total: number;
  manual: number;   // NEW: count of unchecked tasks classified manual
};
```

Pure, idempotent, no I/O — same contract as #1187. `total === unchecked + checked` unchanged.

## Classification rules (two-tier, per line)

Applied only to lines already recognized as **unchecked** tasks by the existing grammars:

```typescript
/** Tier 1 — literal bracketed marker, anywhere in the task line (Q3=A). */
const MANUAL_MARKER = /\[manual\]/i;

/** Tier 2 — whole-word keyword within the first 4 words of the task text (Q2=B). */
const MANUAL_KEYWORDS = /\b(?:manual|manually|hand-test)\b/i;
```

- **Task text** = the substring after the checkbox capture (`- [ ] ` prefix) for checkbox grammar, or after the heading marker + task ID + optional `[DONE]` token for heading grammar.
- Tier 2 runs only when Tier 1 does not match. "First 4 words" = split task text on whitespace, take the first 4 tokens, test the joined prefix.
- The marker never affects checked/unchecked counting and never interacts with the strict `HEADING_DONE` position rule — `### T001 [DONE] Verify flow [manual]` is a checked task, full stop.

**Classification truth table** (unchecked tasks):

| Task line | Manual? | Via |
|---|---|---|
| `- [ ] T005 [manual] Verify the deploy` | yes | marker |
| `- [ ] T005 Verify the deploy [manual]` | yes | marker (trailing, #2714) |
| `### T005 Check dashboards [manual]` | yes | marker, heading grammar |
| `- [ ] T028 Manually verify the export flow` | yes | keyword, word 1 (#2723) |
| `- [ ] T029 Hand-test the retry path` | yes | keyword, word 1 |
| `- [ ] T010 Verify manually that CI passes` | yes | keyword, word 2 |
| `- [ ] T011 update the user manual` | no | "manual" is word 4? — no: whole-word but position 4 of text "update the user manual" → word 4 **is** within first 4; see note below |
| `- [ ] T012 rewrite the entire user manual section` | no | keyword at word 5+ |
| `- [ ] T013 add manuals directory` | no | `manuals` fails whole-word match |

> **Note on "update the user manual"**: the keyword lands at word 4, inside the window. This residual false positive is accepted per Q2's rationale — it suppresses re-entry only when *all* remaining unchecked tasks classify manual, producing a visible, operator-overridable pause rather than a silent failure. Tests must pin this case explicitly (whichever behavior implement settles on, document it); the spec's canonical negative examples ("update the user manual" as a *later-position* phrase) use longer prefixes.

## Synthesized `ImplementPartialResult` (mixed remainder, FR-008)

Unchanged type (`types.ts:178`). On an `incomplete` evaluation (automatable > 0, no label), synthesis uses the **automatable** count only:

```typescript
result.implementResult = {
  partial: true,
  tasks_remaining: evaluation.automatable,   // NOT evaluation.unchecked
  tasks_completed: evaluation.checked,
  tasks_total: evaluation.total,
};
```

Manual tasks are excluded from `tasks_remaining` so the no-progress guard compares automatable progress only.

## Pause-path result shape (phase-loop.ts)

No new types. The pause returns the existing loop-result shape (mirrors #1211 / #1133):

```typescript
{ results, completed: false, lastPhase: 'implement', gateHit: true }
```

`pushRefused` abort returns the same shape with `gateHit: false` (per #1051).

## Label states (existing vocabulary only, FR-012/SC-008)

| Label | Role here | Already defined |
|---|---|---|
| `waiting-for:manual-validation` | pause gate; presence suppresses synthesis (Q4=A) | yes (`label-definitions.ts`) |
| `completed:manual-validation` | operator resume grant | yes |
| `completed:implement` | granted at pause (Q1=A) so `resumeFrom: 'validate'` resolves | yes |
| `agent:paused` | applied by `onGateHit` | yes |

`GATE_MAPPING['manual-validation'] = { phase: 'validate', resumeFrom: 'validate' }` — pre-existing (`phase-resolver.ts:16`), unchanged.

## Structured log shapes

- **Divergence warn** (label present + `automatable > 0`): mirrors `phase-loop.ts:928-946` — fields include `{ phase: 'implement', unchecked, automatable, manual, checked, total, reason: 'manual-validation-label-present' }` (exact field names finalized at implement; must be structurally consistent with the existing safety-net logs).
- **Label-read failure warn**: `{ phase: 'implement', error }` + fallback-to-classification note.
- **Unreadable** (unchanged from #1187): `{ reason }`.

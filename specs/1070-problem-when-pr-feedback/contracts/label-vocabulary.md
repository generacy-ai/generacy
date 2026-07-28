# Contract: New label vocabulary (FR-002, FR-002a, FR-003)

**Kind**: New public label vocabulary in `@generacy-ai/workflow-engine`.
**File**: `packages/workflow-engine/src/actions/github/label-definitions.ts` (add three entries next to the existing `blocked:stuck-feedback-loop` at line 111).
**Changeset**: `@generacy-ai/workflow-engine` → **`minor`** (per CLAUDE.md: "new label vocabulary in `workflow-engine` → `minor`").

## Additions

Insert immediately after the existing `blocked:stuck-feedback-loop` entry (line 114) so the three timeout-family labels sit together with the sibling loop-family label:

```typescript
{
  name: 'blocked:fixer-timeout',
  color: 'D73A4A',
  description: 'PR-feedback CLI timed out (exit 143) after pushing a partial commit — up to two automatic retries will follow.',
},
{
  name: 'blocked:fixer-timeout-no-progress',
  color: 'D73A4A',
  description: 'PR-feedback CLI timed out (exit 143) without pushing any commit — human intervention required (retries would not make progress).',
},
{
  name: 'blocked:fixer-timeout-repeat',
  color: 'D73A4A',
  description: 'PR-feedback CLI timed out and the auto-retry budget (2) was exhausted without fully resolving review threads — human intervention required.',
},
```

**Color rationale**: `D73A4A` is the same red as the sibling `blocked:stuck-feedback-loop` and other `blocked:*` labels (`stuck-merge-conflicts`, `stuck-validate-fix`).

## Semantic contract per label

| Label | Meaning | Retry behavior | Operator action |
|---|---|---|---|
| `blocked:fixer-timeout` | Timeout with partial commit; retry budget remaining | Monitor auto-dispatches on next poll; label removed at dispatch time | **None** — wait one 20-min cycle before intervening. If the retry succeeds, the label vanishes. |
| `blocked:fixer-timeout-no-progress` | Timeout with zero commits pushed | Terminal — no auto-retry (retries would not help; the fixer never even started writing) | Investigate why the fixer produced no commits. Remove label to permit a retry (which will get the full budget again). |
| `blocked:fixer-timeout-repeat` | Timeout after auto-retry budget (2) was exhausted | Terminal — no auto-retry | Review whether the work is too large for a single 20-min window. Either (a) intervene manually to finish the reply/resolve loop, or (b) split the review into smaller chunks and remove the label to permit a fresh trigger. |

## Verification

- **CI label-sync**: The `label-sync-service` at `packages/orchestrator/src/services/label-sync-service.ts` iterates `WORKFLOW_LABELS` and creates any missing labels on the target repository. Test at `packages/orchestrator/src/services/__tests__/label-sync-service.classify.test.ts` demonstrates the "description too long" failure shape — verified visually that all three descriptions above fit well under GitHub's 100-char label description limit.
- **Cockpit tier classification**: Existing prefix rule at `packages/cockpit/src/state/label-map.ts:44-48` classifies every `blocked:*` label into the `waiting` tier without change. Verified by reading that block.
- **Cockpit precedence tie-break**: Two of the three labels (`blocked:fixer-timeout-no-progress`, `blocked:fixer-timeout-repeat`) require an addition to `WAITING_PIPELINE_ORDER` — see `contracts/handler-counter-seam.md` §D-3 and `data-model.md` §7 for the exact insertion.

## SC-005 preservation

The existing `blocked:stuck-feedback-loop` label description and behavior are **unchanged**. The e2e cockpit test at `packages/cockpit/src/__tests__/e2e-address-pr-feedback.test.ts:119` continues to pass unmodified (spec SC-005). Verified by reading the test — it only exercises `blocked:stuck-feedback-loop`, which continues to be applied by FR-004's no-diff / push-failed branches.

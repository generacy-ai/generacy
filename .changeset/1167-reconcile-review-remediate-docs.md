---
'@generacy-ai/cockpit': patch
'@generacy-ai/workflow-engine': patch
---

Reconcile review/remediate docs, comments, and enumerations with shipped
behavior (#1167). Cockpit's `WAITING_PIPELINE_ORDER` gains
`waiting-for:remediation-limit` (after `waiting-for:implementation-review`) and
`waiting-for:ci` (last), and `STAGE_COMPLETE_PIPELINE_ORDER` gains
`completed:validate` / `completed:remediate` / `completed:review` so the new
review/remediate gates sort deterministically instead of falling back to the
default `WORKFLOW_LABELS` index. The workflow-engine `ReviewGate` union is
widened with the existing `remediation-limit` and `ci` gate labels for type
completeness. No runtime behavior change — these are deterministic-ordering and
type-surface additions only.

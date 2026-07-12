# Data Model — Found during the cockpit v1

## Entities touched

### `WAITING_PIPELINE_ORDER: string[]`

- **Location**: `packages/cockpit/src/state/precedence.ts:26`.
- **Semantics**: ordered list of `waiting-for:*` and `blocked:*` labels; earlier index wins the curated `sourceLabel` slot for the `waiting` tier when multiple co-occur. Gates not listed sort after all listed gates and fall back to `WORKFLOW_LABELS` index.
- **Change**: insert `'waiting-for:address-pr-feedback'` at **index 1** (between `'blocked:stuck-feedback-loop'` and `'waiting-for:spec-review'`). No structural change to the array type; consumers of the array (`compareSourceLabels` in the same file) are unchanged.
- **Docstring update**: at lines 20–25, remove `address-pr-feedback` from the "unlisted, falls back to `WORKFLOW_LABELS` index" list, cross-reference the FR-010 audit.

### `PrFeedbackHandler.handle(item, checkoutPath): Promise<void>`

- **Location**: `packages/orchestrator/src/worker/pr-feedback-handler.ts:73`.
- **Semantics**: entry point for `address-pr-feedback` command processing. Has four terminal returns (Case A / Case B / blocked-stuck / happy). Currently: only two of the four (`Case A` at line 222 and `happy` at line 357) call `removeFeedbackLabel`; none of the four clears `agent:in-progress`.
- **Change**: wrap the body in `try/finally`; the `finally` block clears `agent:in-progress` (best-effort, non-fatal on failure, logged — mirrors existing `removeFeedbackLabel` shape). The happy-path clear collapses into a single `removeLabels(['waiting-for:address-pr-feedback', 'agent:in-progress'])` call (idempotency-safe with the `finally` backstop).
- **New private method** (recommended): `clearInProgressLabel(github, owner, repo, issueNumber): Promise<void>`. Same shape as `removeFeedbackLabel`. Called from `finally`.
- **Modified private method**: `removeFeedbackLabel` may be extended (or a new `removeFeedbackAndInProgressLabels` sibling created) to remove both labels in one call on the happy path — SC-005 requires the string literal `'agent:in-progress'` to appear at exactly one code site.

### Test entities (new / extended)

- **Classifier tests** — extend `packages/cockpit/src/__tests__/classifier.test.ts` with the four `waiting-for:address-pr-feedback` cases (SC-001).
- **Event-stream tests** — new or extended test at `packages/cockpit/src/__tests__/event-stream.test.ts` (or wherever the existing `issue-transition` event assertions live) for the two edge cases (SC-002).
- **Handler completion tests** — `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.test.ts` (create if absent) with four scenarios (happy / Case A / Case B / blocked-stuck), each asserting the surviving label set (SC-004).
- **End-to-end fixture** — request-changes → server-side feedback loop → completion → `cockpit_await_events` consumer sees the completion transition (SC-003).

## Validation Rules

- **Precedence invariant**: `blocked:stuck-feedback-loop` MUST remain at index 0. `waiting-for:address-pr-feedback` MUST be at index 1. Every other listed gate MUST retain its current relative order (shifted by +1 in absolute index).
- **Handler-completion invariant** (SC-004): after `handle()` returns via any terminal path, the issue's label set MUST NOT contain `agent:in-progress`.
- **Single-point clear invariant** (SC-005): `grep -c 'agent:in-progress' packages/orchestrator/src/worker/pr-feedback-handler.ts` MUST equal 1 after the change (or 2 if a doc comment references the label — measurement is against **code**, not docs; the check may be phrased "exactly one `removeLabels(..., 'agent:in-progress', ...)` call site").
- **No wire-format changes**: `issue-transition` event payload shape MUST NOT change (spec Out of Scope).
- **No playbook changes**: `auto.md` D.3 / D.4 dispatch table MUST NOT change (FR-007).

## Relationships

- **Precedence → classifier**: `compareSourceLabels(a, b, 'waiting', workflowIndex)` in `packages/cockpit/src/state/precedence.ts:66` returns `ai - bi` when both labels are in `WAITING_PIPELINE_ORDER`. The one-line insertion changes the return value for the `{implementation-review, address-pr-feedback}` pair from "unlisted vs. listed" to "index 5 vs. index 1", making `address-pr-feedback` win.
- **Classifier → event plane**: the curated `sourceLabel` change on each label edit drives the `issue-transition` event; because the sourceLabel now genuinely changes on the add and remove edges (instead of staying pinned at `implementation-review`), the events fire.
- **Handler → issue label set**: the `finally` clear ensures the post-handler label set is truthful; downstream observers (auto playbook, cockpit state classifier, cockpit UI) read a non-lying label set on every exit path.

---

## FR-010 Audit — Unlisted `waiting-for:*` Gates in `WAITING_PIPELINE_ORDER`

**Scope**: the six other unlisted gates named in `packages/cockpit/src/state/precedence.ts:22-24`: `pr-feedback`, `clarification-review`, `sibling-review`, `children-complete`, `epic-approval`, `dependencies`. For each, this table records the writer(s), whether it *can* co-occur with any gate listed in `WAITING_PIPELINE_ORDER` today, and the follow-up disposition.

| Gate | Writer(s) | Demonstrated co-occurrence with a listed gate? | Evidence | Follow-up |
|---|---|---|---|---|
| `waiting-for:pr-feedback` | **None in-tree.** Declared at `packages/workflow-engine/src/actions/github/label-definitions.ts:38`; no `addLabels(...)` writer found anywhere in `packages/`. | **N/A** — no runtime writer, so no on-issue co-occurrence is currently possible. | `grep 'waiting-for:pr-feedback'` returns only the label definition line and spec-doc references (specs/199, specs/807, specs/926). | **None.** If a runtime writer is introduced later, that PR must re-run this audit. Historical: `specs/199-description-implement-pr/plan.md:604` records the "distinct from `address-pr-feedback`" design intent. |
| `waiting-for:clarification-review` | `packages/workflow-engine/src/actions/workflow/update-phase.ts:44` (in the `WAITING_FOR_LABELS` map — applied by the `block` action for phase `clarification-review`). | **No.** `clarification-review` fires as a speckit **epic-side / clarify-phase** gate that precedes `plan` / `tasks` / `implement`; it does not overlap with `implementation-review`, `plan-review`, `tasks-review`, or `manual-validation` in the same speckit-feature lifecycle. No writer path in-tree co-writes it with a listed gate on the same issue. | Only writer at `update-phase.ts:44`; `workflow-engine` phase-ordering constants show `clarify` runs before every phase whose completion produces a listed review gate. | **None.** Finding recorded — if a future workflow introduces a phase configuration that emits `clarification-review` alongside a listed gate, follow-up is required at that PR. |
| `waiting-for:sibling-review` | Applied by the phase loop when the `speckit-feature` implement-phase gate with `condition: 'on-sibling-review'` fires — gate definition at `packages/orchestrator/src/worker/config.ts:73`; applied through `LabelManager.onGateHit` (phase-loop iteration path from #692). | **YES — demonstrated with `waiting-for:implementation-review`.** The `implement` phase declares **two** gates in the default `speckit-feature` config: `{ phase: 'implement', gateLabel: 'waiting-for:implementation-review', condition: 'always' }` **and** `{ phase: 'implement', gateLabel: 'waiting-for:sibling-review', condition: 'on-sibling-review' }` (`config.ts:71-73`). When both conditions match, the phase loop pauses on both, producing `{ waiting-for:implementation-review, waiting-for:sibling-review }` on the issue. The existing classifier test at `packages/cockpit/src/__tests__/classifier.test.ts:95-97` explicitly asserts the sibling-review + tasks-review co-occurrence behavior. | `packages/orchestrator/src/worker/config.ts:71-73`; `packages/orchestrator/src/worker/__tests__/gate-checker.test.ts:127-134`; `packages/cockpit/src/__tests__/classifier.test.ts:95-97`. | **YES — open follow-up issue.** Same "no transition" failure mode as #926: with `{ implementation-review, sibling-review }` present, the curated state is `implementation-review` (higher-index sibling-review is unlisted → falls back after all listed) and both the sibling-review add and remove edges are silently absorbed. Recommended follow-up: promote `waiting-for:sibling-review` to `WAITING_PIPELINE_ORDER` — same one-line-precedence pattern as #926 — with its own co-occurrence analysis (index position TBD in that spec; likely between `implementation-review` and `manual-validation`, or ahead depending on active-vs-passive framing per #883 principle). |
| `waiting-for:children-complete` | `packages/orchestrator/src/worker/epic-post-tasks.ts:123` (`await github.addLabels(owner, repo, issueNumber, ['waiting-for:children-complete'])` at end of epic post-tasks). Removed by `EpicCompletionMonitorService` before adding `completed:children-complete` (`packages/orchestrator/src/services/epic-completion-monitor-service.ts:45`). | **No.** Written on **epic** issues only; the epic post-tasks flow removes phase labels before adding `waiting-for:children-complete`, and speckit epics do not carry `waiting-for:implementation-review` / `plan-review` / `tasks-review` / `manual-validation` / `spec-review` / `clarification` concurrently (those are per-child, not per-epic). No writer path in-tree co-writes it with a listed gate on the same issue. | Writer at `epic-post-tasks.ts:123`; remover at `epic-completion-monitor-service.ts` (removes before adding `completed:*`). Grep across `packages/**/*.ts` for `addLabels.*children-complete` returns only the one writer. | **None.** Finding recorded. |
| `waiting-for:epic-approval` | **None in-tree.** Declared at `packages/workflow-engine/src/actions/github/label-definitions.ts:41`; no `addLabels(...)` writer found. The design writer (`EpicCompletionHandler`) is described in `specs/201-description-implement-epic/data-model.md:113` but not yet in source. Note: `packages/workflow-engine/src/actions/epic/create-pr.ts:135` writes the distinct `needs:epic-approval` label (different label). | **N/A** — no runtime writer at time of audit. | `grep 'waiting-for:epic-approval'` returns only the label definition + design specs. Actual writer paths in-tree write `needs:epic-approval`, a semantically different label. | **None.** When the epic-approval writer lands, it will be on the **epic** rollup issue (same non-overlap argument as `children-complete`), so no follow-up is expected — but the PR introducing the writer must re-run this audit. |
| `waiting-for:dependencies` | **None in-tree.** Declared at `packages/workflow-engine/src/actions/github/label-definitions.ts:42`; no `addLabels(...)` writer found. | **N/A** — no runtime writer. | `grep 'waiting-for:dependencies'` across `packages/**/*.ts` returns only the label definition line. | **None.** If a writer is introduced later, that PR must re-run this audit. |

**Summary**: of the six unlisted gates, **one** (`waiting-for:sibling-review`) has demonstrated co-occurrence with a listed gate and gets an open follow-up issue. Two (`clarification-review`, `children-complete`) have a runtime writer but no demonstrated co-occurrence path with any listed gate. Three (`pr-feedback`, `epic-approval`, `dependencies`) have no runtime writer at all — the co-occurrence question is not applicable today. All findings recorded so that a future PR introducing a writer inherits the audit trail.

---

*Generated by speckit*

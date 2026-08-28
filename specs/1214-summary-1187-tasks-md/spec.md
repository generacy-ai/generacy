# Feature Specification: Manual-task awareness in the #1187 tasks.md safety net

**Branch**: `1214-summary-1187-tasks-md` | **Date**: 2026-08-27 | **Status**: Draft

## Summary

The #1187 tasks.md safety net treats **every** unchecked task line as work the agent still owes, with no notion of a task the agent cannot complete headlessly (browser/manual verification, deploy checklists, human sign-off). This directly contradicts the manual-task protocol the implement prompt already specifies, and the collision is **deterministic**: any story whose task list ends in manual-verification tasks burns two extra full implement CLI runs and then hard-fails with `failed:implement` + `failed:implement-repeated`, even though the implementation is complete and green.

The prompt side (`agency` [`agency-plugin-spec-kit/commands/implement.md:174-186`](https://github.com/generacy-ai/agency/blob/develop/packages/agency-plugin-spec-kit/commands/implement.md#L174-L186), step 10) instructs the agent to:

1. parse remaining incomplete tasks and classify them as manual (high confidence: `[manual]` marker; medium: keywords `manual` / `manually` / `hand-test` / `manually verify`),
2. **leave them unchecked**,
3. apply `waiting-for:manual-validation` to the issue,
4. report success as a **terminal** state ("Do NOT suggest running `/speckit:implement` again").

The engine already understands that label elsewhere — `packages/orchestrator/src/worker/phase-resolver.ts:16` maps `manual-validation` → `{ phase: 'validate', resumeFrom: 'validate' }`, and it is in cockpit's gate vocabulary (`packages/cockpit/src/gates/schema.ts`, `packages/cockpit/src/state/precedence.ts`). The safety net is the one place that doesn't.

## Root cause

`packages/orchestrator/src/worker/tasks-md-fallback.ts:55` (`countTasks`) counts unchecked lines with no classification; `:126` maps `unchecked > 0` → `kind: 'incomplete'`.

`packages/orchestrator/src/worker/phase-loop.ts:919` synthesizes a partial `implementResult` from that count and falls through to the increment block at `:954`, which re-runs implement. The agent's second run correctly early-exits (step 10a idempotence) and leaves the same manual tasks unchecked, so the no-progress guard at `:958` (`tasksRemaining >= lastTasksRemaining`) fires:

```
implement (no-progress guard) — failed post-exit: no-progress (process exit 0)
no progress: tasks_remaining stayed at 2 across two increments
```

The re-entry decision never consults the issue labels, so the `waiting-for:manual-validation` the agent applied during increment 1 is ignored. The resulting label set is self-contradictory: `waiting-for:manual-validation` + `failed:implement` + `failed:implement-repeated` on the same issue. `failed:implement-repeated` is terminal and blocks re-enqueue, so every occurrence needs a human.

## Evidence — Painworth/ai-lawfirm#2723 (AD-16)

`tasks.md` at the WIP head: 27/29 checked. The two unchecked tasks:

- `- [ ] T028 Browser-verify per repo policy (quickstart.md §Emulator): emulators_start … then via Playwright MCP …`
- `- [ ] T029 Berman-deploy checklist for SC-002 (**deferred per house practice** — emulator cannot place LiveKit calls)`

Implement transcript, increment 1 (`~/.claude/projects/-workspaces-ai-lawfirm/0707d07d-4154-4ad3-9740-d38a8720c38e.jsonl`, final message):

> All automated gates are green post-merge: `type-check` ✓, `pnpm test` ✓, `pnpm test:scripts` ✓. … The only two remaining tasks are both manual validation: **T028** — Browser-verify via emulator + Playwright MCP; **T029** — Berman-deploy checklist for SC-002 (explicitly deferred; emulator can't place LiveKit calls). Per the command's manual-task handling, I'll add the label.

…then `✓ All automated tasks complete (27/27)` and `waiting-for:manual-validation` applied.

Increment 2, forced by the safety net (`a7a2420d-9cb2-42b0-bd6e-23aa42c0d492.jsonl`, final message):

> Both are `manual` verification tasks. `waiting-for:manual-validation` is already applied to #2723. … Add `completed:manual-validation` once T028/T029 are done to resume the workflow. **No automated work is outstanding — do not re-run `/implement`.**

Worker log (`ai-lawfirm-worker-1`), 88 seconds later:

```
"issueNumber":2723,"tasksRemaining":2,"tasksTotal":29,"msg":"tasks.md safety net: unchecked tasks remain, re-entering implement"
"issueNumber":2723,"tasksRemaining":2,"tasksTotal":29,"msg":"tasks.md safety net: unchecked tasks remain, re-entering implement"
"tasksRemaining":2,"lastTasksRemaining":2,"msg":"Implement increment made no progress — failing to prevent infinite loop"
```

The implementation itself was complete and the merge gate green; PR Painworth/ai-lawfirm#2785 was not the problem.

### The `[manual]` marker alone is also ignored

Painworth/ai-lawfirm#2714's single remaining task carried the documented high-confidence marker verbatim:

```
- [ ] T030 [manual] Browser verification per repo policy — Playwright MCP against the emulator stack
```

It still hit the no-progress guard. So this is not "the agent forgot the convention" — the engine has no manual awareness of any kind.

### …and keyword detection alone would not fix it

#2723's T028/T029 contain **no** occurrence of "manual"/"manually". An engine-side keyword heuristic mirroring the prompt would have missed them. Any fix that relies only on text classification is incomplete.

## Impact (Painworth/ai-lawfirm, ~40h window, 3 workers)

- Spurious safety-net re-entries on **10 issues** — 2609, 2713, 2714, 2715, 2716, 2717, 2718, 2720, 2722, 2723 — **23 wasted full implement CLI runs** (each a complete headless Claude session against a large monorepo).
- Hard `failed:implement` on **8**: 2609, 2713, 2714, 2715, 2717, 2718, 2720, 2723. Remainders were 1–5 tasks out of 18–34 in every case — i.e. the trailing verification tasks, not real gaps.
- `failed:implement-repeated` (terminal, blocks re-enqueue) → each requires manual label surgery before the issue can move.
- Two false failure alerts posted per issue, plus a stage comment reading `implement ❌ error` on work that is finished and green.

This is a regression: before #1187, sentinel-absent runs advanced, so the agent's "all remaining are manual" terminal state was honored.

## Suggested fix

1. **Primary — honor the authoritative signal (no heuristics).** In the `phase-loop.ts:919` block, before synthesizing a partial, read the issue's labels. If `waiting-for:manual-validation` is present, do not re-enter implement: treat it as a gate/pause (the resolver already knows how to resume from it at `validate`). This is the agent's own classification, it is already a first-class gate, and it is visible to a human in the label set.
2. **Belt-and-braces — classify in `countTasks`.** Return `manualUnchecked` alongside `unchecked`, using the same layered detection the prompt defines (`[manual]` marker, then keywords), and drive re-entry off *automatable* unchecked only. This catches #2714 even when the label is missing. Keep it additive so existing `countTasks` behavior on non-manual lines is byte-identical.
3. **Guard semantics.** When the remainder is unchanged **and** the remaining tasks are all manual / the manual-validation label is present, pause at `manual-validation` rather than failing. Never apply `failed:implement-repeated` to a remainder that is human-gated by construction — the guard exists to stop agent thrash, not to punish a legitimate terminal state.
4. **Upstream (agency) — make the marker mandatory.** Tighten the tasks prompt so any task that cannot complete in a headless worker must carry an explicit `[manual]` marker. #2723's tasks.md shows the convention is not reliably emitted today, which is why (2) cannot be the only fix.

Found while investigating repeated `failed:implement` on the ai-lawfirm dogfood cluster (generacy from `ghcr.io/painworth/ai-lawfirm/generacy:latest`, safety net from 4e0ad874, 2026-08-24). Follow-up to #1187, sibling of #1192.

## User Stories

### US1: Manual-validation label is honored instead of forcing re-entry

**As an** operator running speckit stories on a dogfood cluster,
**I want** the tasks.md safety net to stop re-entering implement once the agent has applied `waiting-for:manual-validation`,
**So that** a complete-and-green story pauses at the human gate instead of burning two extra implement runs and hard-failing.

**Acceptance Criteria**:
- [ ] With `waiting-for:manual-validation` present on the issue and unchecked tasks remaining, the safety net does not synthesize a partial `implementResult` and does not re-enter implement.
- [ ] The run terminates as a gate pause (`waiting-for:manual-validation` + `agent:paused`), not as a phase failure.
- [ ] `failed:implement` and `failed:implement-repeated` are never applied on this path.
- [ ] Adding `completed:manual-validation` resumes the workflow at `validate`, per the existing `GATE_MAPPING` entry.

### US2: Manual tasks are recognized even when the label is missing

**As an** operator whose implement agent left `[manual]`-marked tasks unchecked but did not apply the label,
**I want** the engine to classify those unchecked lines as manual and exclude them from the re-entry decision,
**So that** a story whose only remainder is human-gated work does not thrash (the #2714 case).

**Acceptance Criteria**:
- [ ] `countTasks` reports manual-unchecked separately from automatable-unchecked, using the `[manual]` marker as high-confidence detection and the prompt's keyword set as medium-confidence detection.
- [ ] Re-entry is driven off automatable-unchecked only; a remainder that is entirely manual does not trigger re-entry.
- [ ] Counting of non-manual task lines (both checkbox and heading grammars) is byte-identical to today.
- [ ] A remainder that mixes manual and automatable tasks still re-enters implement, and the synthesized counts reflect the automatable remainder.

### US3: The no-progress guard never punishes a human-gated remainder

**As an** operator,
**I want** the no-progress guard to distinguish agent thrash from a legitimate terminal state,
**So that** an unchanged remainder that is human-gated by construction pauses rather than producing a terminal `failed:implement-repeated` that needs manual label surgery.

**Acceptance Criteria**:
- [ ] When the remainder is unchanged across increments and the remaining work is entirely manual (or the manual-validation label is present), the loop pauses at `manual-validation` instead of firing the guard.
- [ ] The guard still fires — unchanged — when the unchanged remainder contains automatable work.
- [ ] No failure alert is posted and the stage comment does not read `error` on the manual-pause path.

### US4: Non-manual stories behave exactly as they do today

**As a** maintainer of the orchestrator,
**I want** the change to be inert for stories with no manual tasks and no manual-validation label,
**So that** #1187's safety net keeps catching genuinely unfinished implement runs.

**Acceptance Criteria**:
- [ ] A sentinel-absent run with automatable unchecked tasks and no manual-validation label re-enters implement identically to today.
- [ ] `complete` and `unreadable` evaluations keep their current fail-open behavior (phase advances, reason logged).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Before synthesizing a partial `implementResult`, the safety-net block must read the issue's current labels and detect `waiting-for:manual-validation`. | P1 | `phase-loop.ts` safety-net block (currently `:919`) |
| FR-002 | When `waiting-for:manual-validation` is present, the block must not synthesize a partial and must not re-enter implement — the label wins unconditionally, regardless of tasks.md contents. If the label read fails, fall back to tasks.md classification (fail-open to classification, never to blind re-entry). When the label is present but classification says automatable tasks remain, log the divergence so operators can spot agent mislabeling. | P1 | Authoritative signal — no heuristics involved (clarifications Q4=A) |
| FR-003 | On that path the loop must terminate as a gate pause, returning `gateHit: true` and `completed: false`. Sequence: (1) WIP commit/push any uncommitted work via `prManager.commitPushAndEnsurePr`, honoring the #1051 `pushRefused` abort; (2) `onPhaseComplete('implement')` (grants `completed:implement`); (3) `onGateHit('implement', 'waiting-for:manual-validation')` (applies the gate label + `agent:paused`). | P1 | Structural precedent: #1211 dependency-blocked branch for the WIP commit (Q5=A); #1133 on-ci-green gate for completed-at-pause (Q1=A). Update the #1133 comment at `phase-loop.ts:1930-1932` — manual-validation becomes the second completed-at-pause gate |
| FR-004 | The manual-pause path must never apply `failed:implement`, `failed:implement-repeated`, or `agent:error`, and must not post a failure alert. | P1 | This is a deliberate pause, not a failure |
| FR-005 | `countTasks` must additionally report the count of unchecked task lines classified as manual, without changing the existing `unchecked` / `checked` / `total` semantics for non-manual lines. | P1 | Additive; both checkbox and heading grammars |
| FR-006 | Manual classification must use layered detection matching the implement prompt. High-confidence: the literal bracketed `[manual]` token (e.g., `/\[manual\]/i`), recognized anywhere in the task line for **both** grammars (checkbox: anywhere after `- [ ]`; heading: anywhere after the task ID); the marker must not affect checked/unchecked counting and must not interact with the strict `HEADING_DONE` `[DONE]`-after-ID rule — a heading line can carry both tokens. Medium-confidence: the keyword set (`manual`, `manually`, `hand-test`, `manually verify`), matched case-insensitively only when the keyword appears in the first N words (e.g., first 4) of the task text after the checkbox/ID — mid-sentence noun uses like "update the user manual" must not classify as manual. | P1 | Keyword-only detection is provably insufficient (#2723). Marker placement lenient per evidence #2714 (clarifications Q3=A); keyword position strict to avoid false positives (Q2=B) |
| FR-007 | `evaluateTasksMd` must classify a remainder whose unchecked lines are all manual as a distinct outcome from `incomplete`, so the phase loop can pause rather than re-enter. | P1 | New variant on `TasksMdEvaluation` |
| FR-008 | The re-entry decision and the synthesized `tasks_remaining` must be driven off automatable-unchecked only. | P1 | Mixed remainders still re-enter |
| FR-009 | The no-progress guard must not fire when the unchanged remainder is human-gated (all-manual remainder or manual-validation label present); it must pause at `manual-validation` instead. | P1 | Guard exists to stop thrash, not to punish terminal states |
| FR-010 | The no-progress guard's existing behavior for unchanged remainders containing automatable work must be unchanged. | P1 | Regression protection |
| FR-011 | `complete` and `unreadable` evaluations must keep their current fail-open behavior. | P2 | No change to #1187's fail-open discipline |
| FR-012 | The change must require no new label vocabulary. | P2 | `waiting-for:manual-validation` and `completed:manual-validation` already ship in `WORKFLOW_LABELS`; `GATE_MAPPING` already has the entry |
| FR-013 | The pause must be reachable for both `workflow:speckit-feature` and `workflow:speckit-bugfix`. | P2 | Both run implement; the safety net is workflow-agnostic |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Spurious implement re-entries on a story whose only remainder is manual, with the label present | 0 | Test: sentinel-absent implement + unchecked manual tasks + `waiting-for:manual-validation` → no synthesized partial, no `i--` re-entry |
| SC-002 | Spurious implement re-entries on the #2714 shape (`[manual]` marker present, label absent) | 0 | Test: unchecked line carrying `[manual]`, no label → pause, not re-entry |
| SC-003 | Terminal `failed:implement-repeated` applied to a human-gated remainder | 0 | Test: label set after the manual-pause path contains neither `failed:implement` nor `failed:implement-repeated` |
| SC-004 | Resumption after the pause | Resumes at `validate` | Test: `completed:manual-validation` resolves to `resumeFrom: 'validate'` via existing `GATE_MAPPING` |
| SC-005 | Counting of non-manual task lines | Byte-identical | Test: existing `countTasks` grammar matrix (checkbox + heading, incl. `[DONE]` and range/summary rejection) passes unmodified |
| SC-006 | Re-entry on a mixed remainder (manual + automatable) | Still re-enters, counts reflect automatable only | Test: mixed fixture → synthesized `tasks_remaining` equals the automatable count |
| SC-007 | Re-entry on a purely automatable remainder with no manual-validation label | Unchanged from today | Existing `phase-loop` safety-net tests pass unmodified |
| SC-008 | New label vocabulary added | 0 entries | `git diff` shows no change to `label-definitions.ts` |
| SC-009 | Field reproduction (#2723 tasks.md T028/T029, no "manual" keyword, label present) | Pauses at the gate | Test using the #2723 remainder as a fixture |

## Assumptions

1. `waiting-for:manual-validation` is the agent's own classification and is treated as authoritative — the engine does not second-guess it with text heuristics when the label is present.
2. `manual-validation` already resolves to `{ phase: 'validate', resumeFrom: 'validate' }` in `GATE_MAPPING`; both `waiting-for:manual-validation` and `completed:manual-validation` already exist in `WORKFLOW_LABELS` and in cockpit's gate vocabulary and precedence order. No new vocabulary, resolver entry, or cockpit change is needed.
3. Because `manual-validation` resumes at `validate` (a *later* phase than `implement`), the label state applied on pause must leave the resumed run resolvable at `validate`. **Resolved (clarifications Q1=A)**: `onPhaseComplete('implement')` first (grants `completed:implement`), then `onGateHit('implement', 'waiting-for:manual-validation')` — mirroring the #1133 on-ci-green completed-at-pause precedent at `phase-loop.ts:1937-1952`. The ordering is safe against `label-manager.ts:287-292`'s #958 assumption because `onPhaseComplete` already removed `phase:implement`, making `onGateHit`'s removeLabels a no-op exactly as on the ci-green path.
4. Whether `manual-validation` needs to join `DEFAULT_RESUME_RETAIN_SUFFIXES` is expected to be **no**, by the same reasoning documented for `completed:ci` (the resolver consumes the completed label before the resume strip runs) — to be confirmed at `/plan`.
5. Both the label check (FR-001–FR-004) and the classification (FR-005–FR-008) are required. The evidence establishes each alone is insufficient: #2714 had the marker but hit the guard, and #2723's manual tasks contain no "manual"/"manually" keyword.
6. The manual-task protocol in the implement prompt (`agency`, step 10) is stable and its detection rules are the contract the engine-side classifier mirrors.
7. Reading issue labels inside the safety-net block is acceptable — the phase loop already holds a `GitHubClient` and reads labels elsewhere (gate satisfaction, resume resolution).
8. No feature flag. This is a correctness fix on a path that is currently deterministically wrong; it is inert for stories with no manual tasks and no manual-validation label.
9. No new persisted state: no Redis keys, no on-disk files. The label set and `tasks.md` are the only inputs.

## Out of Scope

- **Suggested fix #4 — tightening the tasks prompt so any headless-incompletable task must carry an explicit `[manual]` marker.** That lives in the `agency` repo (`agency-plugin-spec-kit`) and is a separate change; this spec deliberately assumes the marker is *not* reliably emitted, which is why the label check and the keyword tier both ship here.
- Repairing issues already stranded with `waiting-for:manual-validation` + `failed:implement` + `failed:implement-repeated` (2609, 2713, 2714, 2715, 2717, 2718, 2720, 2723). Those need one-time label surgery; no migration ships here.
- Any change to the `SPECKIT_IMPLEMENT_PARTIAL` sentinel, its grammar, or the sentinel-present fast path.
- Any change to the gate/pause label protocol, `GATE_MAPPING`, or `HUMAN_GATE_SUFFIXES` derivation beyond consuming what already exists.
- Auto-completing manual tasks, driving browser verification from the engine, or checking manual task lines on the agent's behalf.
- Changes to the review/remediate loop, the CI merge gate, or the dependency-blocked pause (#1211) — referenced only as structural precedent.
- Cockpit UI/CLI changes. `waiting-for:manual-validation` is already in cockpit's vocabulary and precedence order.

---

*Generated by speckit*

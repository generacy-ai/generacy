# Feature Specification: closed children must not read as actionable in cockpit watch/status

**Branch**: `873-found-during-cockpit-v1` | **Date**: 2026-07-09 | **Status**: Draft | **Source**: [generacy#873](https://github.com/generacy-ai/generacy/issues/873)

## Summary

The cockpit `watch` startup-sweep and `status` classifier are label-only: any child issue carrying `completed:validate` (or any other actionable label) reads as a merge-candidate on every fresh run, even after the child's PR has been squash-merged and the issue has been **closed**. An operator following the `/386` suggestion flow copies the suggested `/cockpit:merge <owner>/<repo>#N` and re-invokes merge against an already-merged PR.

The fix promotes issue open/closed state to a first-class actionability signal: **`state: CLOSED` dominates any label-derived actionability tier.** Closed children render as done in `status` and produce no actionable line and no suggestion in `watch`'s startup sweep.

## Observed (from #873)

`/cockpit:watch 1` on the sniplink epic, after children #2 and #3 were squash-merged and their issues closed:

```
{…#2 → terminal, completed:validate…} · suggested: /cockpit:merge christrudelpw/sniplink#2
{…#3 → terminal, completed:validate…} · suggested: /cockpit:merge christrudelpw/sniplink#3
```

Both suggestions are stale — the PRs are merged, the issues closed.

## Root cause

- `isActionableSnapshot()` in `packages/generacy/src/cli/commands/cockpit/watch/actionable.ts` filters strictly on `snap.labels[]` (`completed:validate`, `needs:intervention`, `agent:error`, prefixes `waiting-for:*`, `failed:*`, or PR `checksRollup === 'failure'`). It never inspects `snap.state`.
- `computeInitialSweep()` in `packages/generacy/src/cli/commands/cockpit/watch/diff.ts:127` iterates every actionable snapshot in the current map and emits one `label-change` event with `initial: true`. Closed issues still pass the filter, so the operator sees them as actionable on every fresh watch.
- `StatusRow` in `packages/generacy/src/cli/commands/cockpit/status/row.ts` carries only the classifier's `CockpitState` (label-derived). The `groupRows` renderer in `status/group.ts` has no notion of "done" — every row prints under its phase header with the same visual weight, whether the underlying issue is open or closed.
- `IssueSnapshot.state` / `PrSnapshot.state` (`'OPEN' | 'CLOSED'`) are already collected in `snapshot.ts:14,25` and fetched by the `gh` wrapper — no new data-plane work is needed.

## User Stories

### US1 — Cockpit operator running a fresh watch on a partially-completed epic

**As a** cockpit operator (human or agent) resuming a watch on an epic whose earlier children have already merged and closed,
**I want** closed children excluded from the startup sweep's actionable set (no line, no `/cockpit:merge` suggestion),
**So that** I do not accidentally re-run `/cockpit:merge` against an already-merged PR after copying a stale suggestion.

**Acceptance Criteria**:
- [ ] A closed issue carrying `completed:validate` (or any actionable label) is silent in the startup sweep — no NDJSON event, no operator-visible line.
- [ ] An open issue carrying `completed:validate` continues to emit an `initial: true` `label-change` event unchanged.
- [ ] A live open→closed transition during a watch session still emits exactly one `issue-closed` event (existing behavior in `diffIssue` at `diff.ts:82`), and no downstream suggestion is derivable from that event.
- [ ] The startup sweep for an epic where every child is closed produces zero actionable NDJSON lines.

### US2 — Cockpit operator reading `status` on a mixed-state epic

**As a** cockpit operator running `/cockpit:status <epic>`,
**I want** closed children rendered as done (visually distinct from open, actionable rows) inside their phase group,
**So that** I can tell at a glance which children still need attention versus which have already landed.

**Acceptance Criteria**:
- [ ] Closed children appear in their phase group with a "done"/"closed" marker (visual treatment TBD in plan) rather than the raw label-derived `CockpitState`.
- [ ] No `/cockpit:merge` suggestion is emitted for a closed child.
- [ ] Open children in the same phase group continue to render with their existing `CockpitState` and colour treatment.
- [ ] The JSON envelope (`renderJsonEnvelope`) exposes enough signal (e.g. an `issueState` field on `StatusRow`, or a derived `done: true` flag) for downstream consumers to make the same distinction.

## Functional Requirements

| ID     | Requirement                                                                                                                                                                                                                                                             | Priority | Notes |
|--------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|-------|
| FR-001 | `isActionableSnapshot(snap)` MUST return `false` when `snap.state === 'CLOSED'`, regardless of `snap.labels` or `snap.checksRollup`.                                                                                                                                     | P1       | Single-line guard at the top of the function. Preserves the existing "raw labels not classified state" comment (see `actionable.ts:16-21`). |
| FR-002 | `computeInitialSweep()` MUST NOT emit an event for any snapshot whose issue/PR `state` is `CLOSED`. (Implicit once FR-001 lands, but codified so a future refactor of the sweep can't reintroduce the leak.)                                                             | P1       | |
| FR-003 | `diffIssue()`'s existing `prev.state === 'OPEN' && curr.state === 'CLOSED'` branch (`diff.ts:82`) MUST remain — the live open→closed transition still emits one `issue-closed` event.                                                                                    | P1       | Confirms no regression on legitimate lifecycle-transition emission. |
| FR-004 | The `status` renderer MUST visually distinguish closed children from open children within a phase group. Concrete treatment (label text, glyph, colour) is a plan-phase decision; the requirement is that the two states are unambiguous to a reader of the plain-text render. | P1       | Suggested placeholder from #873: `✓ merged/closed`. Final wording deferred to plan. |
| FR-005 | The `status` renderer MUST NOT surface any `/cockpit:merge <ref>` suggestion (nor any other `actionable` treatment) for a closed child.                                                                                                                                  | P1       | The suggestion string itself lives in a downstream (assistant/render) layer; closing off the underlying `actionable`/`terminal-merge-candidate` classification at the row level is the cockpit-side contract. |
| FR-006 | The `StatusRow` (or equivalent) MUST carry a machine-readable field that lets JSON consumers detect closed-vs-open without re-parsing labels. Concrete field name deferred to plan.                                                                                      | P2       | Options: add `issueState: 'OPEN' \| 'CLOSED'` to `StatusRow`; or add a derived `done: boolean`; or introduce a new `CockpitState` value (see FR-007). Cost/scope tradeoff is a `/clarify` question. |
| FR-007 | The classifier rule "issue `state: closed` dominates any label-derived actionability tier" MUST be codified somewhere durable: either as a comment on `classify()`, as a wrapper type in `ClassifiedIssue`, or as a documented invariant in `contracts/`.                | P2       | Cheapest fix: consumer-side (actionable + row builders). Doesn't change the pure `classify()` signature. |
| FR-008 | Behaviour MUST be identical for closed-because-merged and closed-because-not-planned. Cockpit does not distinguish the two — both are "done, not actionable".                                                                                                            | P2       | Reduces edge-case surface; call out as a `/clarify` question if disputed. |

## Success Criteria

| ID     | Metric                                                                                                                                                                                                             | Target                        | Measurement                                                                                                                                                                                     |
|--------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| SC-001 | On a fresh `cockpit:watch` of the sniplink epic (or an equivalent fixture with a closed child carrying `completed:validate`), zero startup-sweep NDJSON events reference the closed child.                          | 0 stale events                | Regression test replaying the sniplink fixture through `computeTransitions(new Map(), curr)`. Asserts no event has `curr.state === 'CLOSED'`.                                                     |
| SC-002 | On the same fixture, `cockpit:status` renders each closed child as done (visually distinguishable from open rows) with no `/cockpit:merge` suggestion.                                                              | 0 merge suggestions           | Snapshot test on rendered plain-text output + JSON envelope. Assert the row's rendered state string is not the raw `terminal` value.                                                              |
| SC-003 | Open issues carrying `completed:validate` continue to appear in the startup sweep exactly as they do today.                                                                                                          | 100% behaviour preserved      | Regression test: existing fixtures for open `completed:validate` issues must produce byte-identical `computeInitialSweep()` output.                                                              |
| SC-004 | A live open→closed transition during a watch session emits exactly one `issue-closed` event; the subsequent poll's snapshot map excludes the (now closed) issue from any actionable output.                          | 1 terminal event, then silent | Sequence test: two-poll fixture. Poll 1 has the issue OPEN + `completed:validate` → 1 initial `label-change`. Poll 2 flips to CLOSED → 1 `issue-closed` event. Poll 3 (identical to 2) → silent. |

## Assumptions

- The `gh` wrapper reliably reports the OPEN/CLOSED state for issues and PRs. (Confirmed — `Issue.state` exists at `packages/cockpit/src/gh/wrapper.ts:9`, and both `IssueSnapshot` and `PrSnapshot` carry `state`.)
- The `/cockpit:merge` suggestion text itself is generated by a downstream consumer of the NDJSON stream (assistant / render layer), not by cockpit itself. Closing off the underlying "actionable" classification therefore also closes the suggestion.
- No consumer of `CockpitEvent.to === 'terminal'` treats `initial: true` events differently from live transitions — dropping closed children from the initial sweep does not orphan a downstream consumer that expected a synthetic terminal marker on every startup.
- `.claude/` slash-command wrappers and any assistant-mode `/cockpit:watch` transcription pipelines can read the fixed NDJSON stream unchanged; they only lose the stale actionable line, they don't need a new event shape.

## Out of Scope

- Renaming or re-shaping `CockpitEvent` (e.g. adding a new discriminator for "closed-but-was-actionable") — this is a filter, not a schema change.
- Changing the pure `classify()` signature in `packages/cockpit/src/state/classifier.ts`. The state-dominates-labels rule is applied at the *consumer* boundary (`actionable.ts` + status row builder), not inside the label-only classifier.
- Rewriting the assistant-side suggestion generator. Cockpit's contract is "don't classify a closed issue as actionable"; the assistant merely stops seeing candidates it would otherwise suggest.
- Handling the reverse transition (closed → reopened). If GitHub reports the reopen, the next poll's snapshot naturally carries `state: OPEN` and the existing filter re-includes it — no special handling needed.
- Backfilling historical NDJSON logs. Only forward behaviour changes.
- Cockpit-managed automatic label cleanup on merge/close. #873 explicitly notes "closed issues keep their label residue forever"; this feature does not attempt to strip stale labels, only to ignore them for actionability purposes.

## Regression Tests (from #873, mapped to SC IDs)

- **Closed issue carrying `completed:validate`** → `cockpit:status` shows done, `cockpit:watch` sweep emits nothing actionable, no `/cockpit:merge` suggestion. **→ SC-001, SC-002**
- **Open issue carrying `completed:validate`** → unchanged (merge candidate). **→ SC-003**
- **Live close during a watch session** → exactly one terminal done-line, no suggestion, issue drops from subsequent actionable sets. **→ SC-004**

---

*Generated by speckit; enhanced from issue #873.*

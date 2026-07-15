# Implementation Plan: Address-pr-feedback flow must not advance implementation-review gate

**Feature**: Prevent anonymous `completed:implementation-review` writes; install a `LabelManager` seam guard so only `cockpit advance` can complete a human gate; log-loud + re-add `waiting-for:implementation-review` at fix-session exit
**Branch**: `941-summary-during-snappoll`
**Issue**: [#941](https://github.com/generacy-ai/generacy/issues/941)
**Status**: Complete

## Summary

The snappoll dogfood run advanced `implementation-review` twice with no operator `cockpit advance` call and no `<!-- generacy-cockpit:manual-advance -->` audit comment. The address-pr-feedback flow is the suspected source but recon has ruled out `PrFeedbackHandler.handle()` as the direct writer. This change ships defense-in-depth per Q1 → C:

1. **FR-003 seam guard in `LabelManager`.** `applyLabels()` becomes the single write path for `github.addLabels` and rejects any `completed:<human-gate>` unless the caller passes a closed-union token. Union has one member — `AllowGateComplete.CockpitAdvance` — per Q2 → B. Because `cockpit advance` writes over the wire via `gh` CLI (not through orchestrator's `LabelManager`), zero current in-orchestrator sites need the token. Any live writer trips the guard and identifies itself in the resulting error trace (Q1's diagnosis mechanism).
2. **FR-002 log-loud + re-add at fix-session exit.** `PrFeedbackHandler.handle()` gains a terminal check: after every exit branch (happy path, both blocked-stuck dispositions, Case A/B, thrown errors), if `waiting-for:implementation-review` is missing, emit `{ event: 'gate-label-missing-at-fix-exit', … }` at `error` level and idempotently re-add. Per Q3 → C: satisfies the operator-visible guarantee without silently masking whichever path stripped the label.
3. **FR-005 integration regression test.** A phase-loop-layer test drives a simulated `address-pr-feedback` queue item with a mock `GitHubClient`, injects a request-changes review whose findings are not resolved, and asserts terminal labels on the mock are exactly `{ 'waiting-for:implementation-review', 'agent:paused' }` — never `completed:implementation-review`. Per Q5 → B: locks the interaction chain, not just the handler.
4. **FR-007 unit tests for the guard**: token-less `completed:<human-gate>` → reject; with token → allow; `completed:<worker-phase>` (e.g. `completed:implement`) → allow without token; non-`completed:*` writes → unaffected.

## Technical context

### Language / framework
- **TypeScript** (Node ≥22), monorepo package `@generacy-ai/orchestrator`.
- Test runner: **vitest** (unit + integration).
- Zero new runtime dependencies.

### Key files and their roles

| File | Role | Change |
|---|---|---|
| `packages/orchestrator/src/worker/label-manager.ts` | Owns every orchestrator-side label write via private `applyLabels()`. | Add `AllowGateComplete` token type + `isHumanGateCompletion()` predicate + guard branch in `applyLabels()`. All internal callers (`onPhaseStart`, `onPhaseComplete`, `onGateHit`, `onError`, `onResumeStart`) are audited — none of them writes `completed:<human-gate>` today, so no call-site changes to legitimate paths. |
| `packages/orchestrator/src/worker/pr-feedback-handler.ts` | `PrFeedbackHandler.handle()` — every terminal branch exits through a shared `finally` (per #926). | New helper `ensureImplementationReviewGate(github, owner, repo, issueNumber)` called from the `finally` block **before** `clearInProgressLabel`. Reads current labels; if `waiting-for:implementation-review` is absent, emits `error`-level structured log `{ event: 'gate-label-missing-at-fix-exit', … }` and calls `github.addLabels(..., ['waiting-for:implementation-review'])` (idempotent). |
| `packages/orchestrator/src/worker/__tests__/label-manager.guard.test.ts` (new) | FR-007 unit coverage for the guard. | New file. |
| `packages/orchestrator/src/__tests__/pr-feedback-gate-invariant.integration.test.ts` (new) | FR-005 integration regression: drives address-pr-feedback through the worker route with a mock `GitHubClient` and asserts terminal label set. | New file. |
| `packages/generacy/src/cli/commands/cockpit/advance.ts` | Writes `completed:<gate>` via `gh.addLabel` on the operator machine — bypasses orchestrator `LabelManager` by construction. | **No change.** `AllowGateComplete.CockpitAdvance` exists as a type in orchestrator for architectural clarity; the CLI path never invokes `LabelManager.applyLabels`, so no token threading is required. |

### Gate label set (identifies "human gate" for the guard predicate)

Derived from `WorkerConfigSchema.gates` (`packages/orchestrator/src/worker/config.ts:89-107`) and the `GATE_MAPPING` in `packages/orchestrator/src/worker/phase-resolver.ts:9-18`. The predicate `isHumanGateCompletion(label)` returns true when `label` starts with `completed:` and its suffix is in the set of known gate labels:

```
clarification, spec-review, plan-review, tasks-review,
implementation-review, sibling-review, merge-conflicts
```

Phase-completion writes (`completed:specify`, `completed:clarify`, `completed:plan`, `completed:tasks`, `completed:implement`, `completed:validate`) are **not** human-gate completions — the guard lets them through untouched. The suffix set is intersected with `GATE_MAPPING` keys, so a future gate rename shows up in a single canonical place.

### Guard mechanism (FR-003)

- **API surface unchanged.** `applyLabels` stays private; `LabelManager`'s public methods (`onPhaseStart`, `onPhaseComplete`, `onGateHit`, `onError`, `onResumeStart`, `ensureCleanup`) keep the same signature. The guard is a runtime check inside `applyLabels`.
- **Optional token parameter.** `applyLabels(labels: string[], allow?: AllowGateComplete)`. When `allow == null` and any label satisfies `isHumanGateCompletion`, throw `HumanGateCompletionUnauthorizedError` with `{ label, siteHint }`. Thrown synchronously before the wrapped `github.addLabels` call — never reaches GitHub.
- **Zero legitimate call sites need the token** (per Assumption §2 + the direct code audit above). If FR-003 trips on the first CI run, that's the diagnostic surface promised in Q1 → C.
- **Test-only escape hatch:** the union is exported; tests that need to exercise the "legitimate cockpit-advance path in-process" pass `AllowGateComplete.CockpitAdvance` explicitly.

### FR-002 re-add mechanism (log-loud + idempotent)

Location: new private method `PrFeedbackHandler.ensureImplementationReviewGate()`, called from the shared `finally` block at `pr-feedback-handler.ts:411-416`, **immediately before** `this.clearInProgressLabel(...)`. Ordering matters: check-and-re-add first, then clear `agent:in-progress`, so the terminal transient state is never `{ agent:in-progress present, waiting-for:implementation-review absent }`.

- Read labels via `github.getIssue(...)` (already used by `LabelManager.onResumeStart`).
- If `waiting-for:implementation-review` present → no-op (log at `debug`).
- Else → structured `error` log with fields `{ event, owner, repo, issueNumber, prNumber }`, then `github.addLabels(..., ['waiting-for:implementation-review'])`. Non-fatal on either failure (mirrors existing `removeFeedbackLabel` / `clearInProgressLabel` shape) — the `finally` block must never throw.

### FR-005 integration test scope

- Driver: `PhaseLoop` or `ClaudeCliWorker` — whichever gives the shortest path to enqueueing a simulated `address-pr-feedback` queue item.
- Mocks: `GitHubClient` (records `addLabels` / `removeLabels` calls into an array of ordered edits), `AgentLauncher` (returns a fake child process that exits 0 with no diff, simulating "fix session ran but findings not resolved").
- Preload issue with `{ waiting-for:implementation-review, waiting-for:address-pr-feedback, agent:in-progress, agent:paused }` and unresolved review threads.
- Drive the handler through one full cycle.
- Assert the mock's ordered edit log:
  - Contains a final terminal state where the union of adds − removes = `{ waiting-for:implementation-review, agent:paused }`.
  - Never contains an `addLabels(..., ['completed:implementation-review'])` on any exit branch.
  - The `addLabels` set never contains `completed:implementation-review` regardless of which handler exit branch fired.
- Deliberate-regression check (per SC-003): temporarily add `github.addLabels(…, ['completed:implementation-review'])` inside the fix-session exit path — the test must go red.

### Non-goals in this plan
- Creating an approve-review auto-advance handler (Q2 → B, spec §Out-of-scope).
- Retrofitting the audit-comment invariant to non-human gates like `completed:validate` (out of scope).
- Fixing the root cause of any `LabelManager.onResumeStart` stripping of `waiting-for:implementation-review` between pause and fix-session-exit. FR-002's `error` log becomes the trigger for a separate follow-up issue.
- Any change to `cockpit advance` CLI.

## Project structure

```
packages/orchestrator/src/
  worker/
    label-manager.ts                                # MODIFIED — add guard + token + predicate
    pr-feedback-handler.ts                          # MODIFIED — add ensureImplementationReviewGate()
    __tests__/
      label-manager.guard.test.ts                   # NEW — FR-007 unit tests (guard + predicate)
      pr-feedback-handler.gate-reassert.test.ts     # NEW — FR-002 unit tests (log + re-add)
  __tests__/
    pr-feedback-gate-invariant.integration.test.ts  # NEW — FR-005 integration test
specs/941-summary-during-snappoll/
  plan.md            # THIS FILE
  research.md
  data-model.md
  contracts/
    label-manager-guard.md
    pr-feedback-gate-reassertion.md
  quickstart.md
```

## Constitution check

`.specify/memory/constitution.md` — not present in this repository at this branch. No governance-level constraints to check against.

## Success criteria mapping

| SC ID | Deliverable satisfying it |
|---|---|
| SC-001 (0 anonymous `completed:implementation-review` transitions) | FR-003 guard (`LabelManager.applyLabels` rejects any orchestrator-internal write of `completed:<human-gate>`) |
| SC-002 (exactly 1 non-test caller of `AllowGateComplete.CockpitAdvance`) | Type exists in orchestrator; zero non-test call sites (external `cockpit advance` writes via `gh` CLI). Static grep post-implementation confirms |
| SC-003 (FR-005 integration test passes; goes red on deliberate regression) | New `pr-feedback-gate-invariant.integration.test.ts` |
| SC-004 (`gate-label-missing-at-fix-exit` ≤ 1 open incident) | FR-002 structured `error` log emitted from `ensureImplementationReviewGate`; alerting is ops-side, not in-repo |
| SC-005 (snappoll scenario cannot be reproduced) | FR-005 test IS the reproduction — it locks the terminal state |

## Suggested next step

Run `/speckit:tasks` to expand this plan into an ordered task list.

# Implementation Plan: `cockpit advance` must not remove `waiting-for:<gate>`

**Feature**: `cockpit advance` posts the marked comment and adds `completed:<gate>`, but leaves `waiting-for:<gate>` in place for the worker to clear on resume.
**Branch**: `845-found-during-cockpit-v1`
**Date**: 2026-07-07
**Spec**: [spec.md](./spec.md)
**Clarifications**: [clarifications.md](./clarifications.md)
**Status**: Complete

## Summary

Root cause: `cockpit advance` currently adds `completed:<gate>` and then removes `waiting-for:<gate>`. The orchestrator's poll-path resume detector (`label-monitor-service.ts:~156–180`) requires **both** labels present to emit a `resume` event — a `completed:*` with no matching `waiting-for:*` is logged as an orphan and returns `null`. Poll-only clusters (fresh local deploys, no webhook delivery) therefore strand every advance-ed issue at `{completed:<gate>, agent:in-progress, agent:paused}` indefinitely. The webhook path can race and catch the brief add-then-remove window, which is why this survived earlier smoke tests.

Fix: remove the third side-effect of `advance` (the `removeLabel(waitingLabel)` call). Label cleanup on resume belongs to the worker, which already removes `waiting-for:*`, `completed:*`, and `agent:paused` on the resume path. Idempotence (AD-6) and gate-refusal (AD-4) checks are untouched. Operator-visible arrow-form phrasing on three surfaces (CLI stdout, marker comment body, docs) is updated to describe intent + persistence rather than a label diff, per clarifications Q1→C. The `advance.ts` header comment is rewritten around the label-pair invariant per clarifications Q2→C.

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js ≥22 (per `packages/generacy/package.json`).
**Primary Dependencies**: `commander`, `@generacy-ai/cockpit` (`GhCliWrapper`, `loadCockpitConfig`), `vitest` for tests.
**Storage**: N/A — this is a CLI behavior change. Labels live in GitHub Issues.
**Testing**: `vitest` (`packages/generacy/src/cli/commands/cockpit/__tests__/advance.test.ts`, `advance-marker.test.ts`).
**Target Platform**: Node CLI (`generacy cockpit advance`) executed on operator workstations and inside cluster orchestrator processes.
**Project Type**: Monorepo package (`packages/generacy`) with cross-package consumer (`packages/orchestrator/src/services/label-monitor-service.ts` — no changes required; already implements the intended label-pair contract).
**Performance Goals**: N/A (one CLI invocation removes one `gh` call; net-negative on API budget).
**Constraints**:
- Zero new dependencies.
- Zero changes to `label-monitor-service.ts` — the fix is that `advance` matches the monitor's existing contract, not the other way around.
- Marker comment HTML prelude (`<!-- generacy-cockpit:manual-advance gate=… actor=… ts=… -->`) MUST remain byte-stable — it is scanned by `clarification-comment-finder.ts` and downstream cockpit surfaces.
- Existing `advance.test.ts` cases that assert `remove:waiting-for:*` in the call-order array MUST be updated (this is the regression signal SC-002).
**Scale/Scope**: 3 source files modified, 2 test files modified/extended, 2 spec artifacts referenced across repos (#788 doc surfaces + `tetrad-development/docs/label-protocol.md`). ~30 LOC of production change, ~50 LOC of test change.

## Constitution Check

*GATE: no constitution file at `.specify/memory/constitution.md`. Repository-wide invariants from `CLAUDE.md` and clarifications:*

| Gate | Result | Note |
|------|--------|------|
| No new backwards-compat shims for removed code | PASS | This is a corrective removal; no legacy pathway retained. |
| Change matches the spec's Q&A intent, not just the letter | PASS | Q1→C (all three arrow surfaces) and Q2→C (header rewrite around invariant) are honored, not the narrower A/B options. |
| Tests hit real behavior, not mocks-of-mocks | PASS | Regression test asserts on the mock `gh` call-log — the same surface the existing happy-path test uses. |
| Structured logging conventions | N/A | No new log lines. Existing orphan-log in `label-monitor-service.ts` remains as-is (it becomes a much rarer path but is still valid signal). |

Post-Phase-1 re-check: no violations introduced.

## Project Structure

### Documentation (this feature)

```text
specs/845-found-during-cockpit-v1/
├── spec.md              # (present, unchanged by /plan)
├── clarifications.md    # (present, unchanged by /plan)
├── plan.md              # THIS FILE
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output — minimal (no new types)
├── quickstart.md        # Phase 1 output
├── contracts/
│   ├── advance-command.md          # Behavioral contract for `runAdvance` after fix
│   └── manual-advance-marker.md    # Sentence-text update (HTML prelude unchanged)
└── checklists/          # (empty)
```

### Source Code (repository root)

```text
packages/generacy/src/cli/commands/cockpit/
├── advance.ts                          # MODIFIED — remove removeLabel call; rewrite header; update stdout summary
├── manual-advance-marker.ts            # MODIFIED — update sentence text (HTML prelude byte-stable)
└── __tests__/
    ├── advance.test.ts                 # MODIFIED — update call-order assertion; add regression test
    └── advance-marker.test.ts          # MODIFIED — update sentence-text fixture

packages/orchestrator/src/services/
└── label-monitor-service.ts            # UNCHANGED — reference only; the fix conforms to its existing contract
```

External (out-of-repo, tracked for closure but NOT changed by this PR):

```text
tetrad-development/docs/label-protocol.md   # Confirms label-pair invariant. Reference-only.
specs/788-.../ (or successor)               # Any operator-facing docs mentioning "waiting-for:X → completed:X" — update phrasing per Q1→C.
```

**Structure Decision**: Single-package modification inside `packages/generacy` (the CLI), with a documentation touchpoint into any cockpit operator docs. The orchestrator side (`label-monitor-service.ts`) is intentionally not modified — its existing label-pair check is the *reason* the fix is on the CLI side.

## Design Overview

### Behavioral change (production code)

**`advance.ts` — `runAdvance` happy path**

Before:
```
1. postIssueComment(body)
2. addLabel(completedLabel)
3. removeLabel(waitingLabel)          ← DELETED
```

After:
```
1. postIssueComment(body)
2. addLabel(completedLabel)
```

- The `try/catch` block wrapping step 3 (lines 169–176) is deleted in full.
- Idempotence check (line 115) unchanged: `completed:<gate>` present → return early. This still correctly no-ops re-runs, since step 2 is the label that gates it.
- Refusal check (line 123) unchanged: active `waiting-for:*` ≠ requested gate → exit 3. This still works after fix because `waiting-for:<gate>` is exactly the label whose presence we assert.
- Stdout summary (lines 178–181) is updated from ``waiting-for:X → completed:X`` to phrasing that describes the persistent state, per Q1→C. Proposed:
  ```
  advanced <ref>: completed:<gate> added — waiting-for:<gate> left in place for the worker to clear on resume (comment: <url>)
  ```
- Header block comment (lines 1–14) is rewritten around the label-pair invariant per Q2→C:
  ```
  /**
   * `generacy cockpit advance <issue> --gate <name>` — manually flip a gate.
   *
   * Label-pair invariant (see #845):
   *   Poll-path resume detection in label-monitor-service.ts requires BOTH
   *   `waiting-for:<gate>` AND `completed:<gate>` to be present on the issue.
   *   The worker owns clearing `waiting-for:*`, `completed:*`, and
   *   `agent:paused` on the resume path — this command MUST NOT remove
   *   `waiting-for:<gate>` here.
   *
   * Side effects (in order):
   *   1. gh issue comment   (post manual-advance marker)
   *   2. gh issue edit --add-label completed:<gate>
   *
   * Idempotent (AD-6): if `completed:<gate>` is already on the issue, exits 0
   * with `already advanced …` and posts nothing.
   *
   * Refusal (AD-4): if the active `waiting-for:*` ≠ requested gate, exits 3
   * without side effects. No `--force` in v1.
   */
  ```

**`manual-advance-marker.ts` — `formatManualAdvanceComment`**

- HTML prelude UNCHANGED (byte-stable — parsed by `clarification-comment-finder.ts` and downstream cockpit surfaces).
- Sentence text updated per Q1→C. Proposed:
  - With actor: ``Marked `completed:<gate>` by **@<actor>** — `waiting-for:<gate>` left in place for the worker to clear on resume.``
  - Without actor: ``Marked `completed:<gate>` — `waiting-for:<gate>` left in place for the worker to clear on resume.``
- Validation regex and thrown-error paths unchanged.

### Test changes

**`advance.test.ts`**
- Happy-path test (lines 36–60): remove `'remove:waiting-for:clarification'` from expected `calls` array; update stdout assertion to match the new summary phrasing.
- New regression test: assert that on the happy path `gh.removeLabel` is **never** called with any label starting with `waiting-for:`. This is the SC-003 signal — deleting the fix reintroduces the bug and this test fails.
- Idempotence test and gate-refusal test: unaffected (they never reach the removed step).

**`advance-marker.test.ts`**
- Update fixture strings for the "with actor" and "without actor" cases to match the new sentence text.
- HTML-prelude fixtures unchanged.

### Non-changes (deliberate)

- `label-monitor-service.ts` — its existing `if (issueLabels.includes(waitingLabel))` check is exactly the contract this fix conforms to. Modifying it would create an alternative resume path that hides future advance-side regressions.
- Marker HTML prelude — byte-stable to avoid churn in downstream comment scanners.
- `advance.ts` idempotence / refusal branches — these are the only pieces protecting against replay and misuse; they're orthogonal to the label-pair bug.

## Complexity Tracking

*Constitution Check passed; no violations.*

No new abstractions, no new files under `src/`, no new dependencies. Deleting a `try/catch` block plus text updates.

## Risk / Rollback

- **Risk**: an operator (or older cockpit-cluster) tooling that reads the stdout summary line by regex may break on the new phrasing. Mitigation: SC-001 spot-check on cockpit-consuming scripts; the summary is human-facing, not parsed programmatically (verified by grep across `packages/generacy` and `packages/orchestrator` at plan time — no scripted consumers).
- **Rollback**: revert the three-file change; no data migration; no schema change; no relay-payload change.

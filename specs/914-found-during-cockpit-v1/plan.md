# Implementation Plan: Hoist the pre-phase base-merge to run once per cycle

**Feature**: Fix double-merge-clean between install and validate — #914
**Branch**: `914-found-during-cockpit-v1`
**Status**: Complete

## Summary

The pre-phase base-merge hook (#864) runs twice inside `PhaseLoop`'s validate branch: once before the pre-validate install command, and once again before the validate command itself. The second invocation calls `performBaseMerge`, which begins with `git reset --hard origin/<branch>` + `git clean -fd` (`base-merge.ts:104-107`). On any branch whose committed `.gitignore` predates the ignore-`node_modules` scaffold on `origin/<base>`, that clean removes the freshly-installed `node_modules` directory as "untracked & non-ignored" — validate then dies with `exit 127: vitest: not found`, and every requeue reproduces the same failure because the branch state never changes.

The fix is a **structural** one-mechanism change (per spec §Fix and clarification Q5-B): restructure the pre-phase base-merge call sites so that any phase's pre-command hook fires **at most once per cycle**, gated by a per-iteration boolean. In code terms, that reduces to:

1. Delete the second `runPreValidateBaseMerge` call at `phase-loop.ts:311-325` (the one between install and validate).
2. Wrap `runPreImplementBaseMerge` and `runPreValidateBaseMerge` in a per-iteration `hasBaseMergedThisCycle` guard so no future phase can reintroduce the double-merge shape by accident.

Base-merge semantics, base-ref resolution, conflict-pause behavior, and the committed-vs-ephemeral discriminant are all unchanged. This is a pure hoist — no new modules, no new dependencies, no behavior change for up-to-date branches.

Per clarification Q3-A, the retry loop lives **above** the hoisted call site: `i--; continue;` re-enters the `for` iteration, which re-declares the guard bool and re-runs the hook. One merge per attempt, install→validate always travels together.

Per clarification Q2-A, no drift detection between install and validate is added; the (seconds-to-minutes) staleness window is deliberately accepted because #892 already re-runs validate when `origin/<base>` advances.

Per clarification Q4-A, SC-005 is discharged by the SC-001 + SC-002 unit fixtures; no orchestrator-level end-to-end fixture ships here (the smoke-test epic exercises the sequence by construction).

## Technical Context

**Language / runtime**: TypeScript, Node.js ≥22, ESM.

**Repos / packages touched**: `packages/orchestrator/src/worker/` only.

**New direct dependencies**: none. Everything is an in-place mutation of existing control flow inside a single class.

**Existing infrastructure leaned on**:
- `PhaseLoop.executeLoopInner` (`packages/orchestrator/src/worker/phase-loop.ts`) — the double-merge site. The fix lives here.
- `runPreImplementBaseMerge` / `runPreValidateBaseMerge` / `runPrePhaseBaseMerge` (same file) — unchanged in body; wrapped by the new guard at their call sites.
- `performBaseMerge` (`base-merge.ts`) — unchanged. Its `git reset --hard` + `git clean -fd` semantics stay as-is; hoisting simply removes the between-commands invocation that made those steps destructive.
- `BaseMergeRunner` DI seam — unchanged; existing fake runners in `phase-loop.merge.test.ts` continue to work.

**Constraints**:
- The base-merge invariant introduced by #864 must be preserved: validate MUST run against the merged tree, not the raw feature-branch tree. The hoisted call still runs before the first spawned command of the cycle (Q1-A), so validate still sees the merged tree; it just sees it without a mid-cycle destructive reset.
- FR-006 (single atomic PR that modifies `phase-loop.ts`) holds — the change is contained inside `PhaseLoop` and its unit tests.
- Retry idempotency (Q3-A): a same-phase retry (`i--; continue;`) is a new cycle and re-fires the hook once. The retry loop must stay above the hoisted call site.
- Existing test `runs a second base-merge before the validate command itself` at `phase-loop.merge.test.ts:342-367` currently asserts the buggy behavior (`baseMergeCount === 2`). This test is flipped to assert `baseMergeCount === 1` as part of the same PR.

## Project Structure

```
packages/orchestrator/src/worker/
├── phase-loop.ts                          MODIFY
│   ├── executeLoopInner: introduce per-iteration `hasBaseMergedThisCycle` bool,
│   │   declared inside the `for (let i = ...; ...; i++)` body so it auto-resets
│   │   on every phase entry (including retry re-entries via `i--; continue;`).
│   ├── executeLoopInner: `runPreImplementBaseMerge` call site — wrap in guard,
│   │   set flag on success (unchanged behavior for the implement path, which
│   │   never fired twice; the guard is the general immunization from Q5-B).
│   ├── executeLoopInner: `runPreValidateBaseMerge` call site (line 264, before
│   │   install) — wrap in guard, set flag on success.
│   └── executeLoopInner: DELETE the second `runPreValidateBaseMerge` call at
│       lines 311-325 (the between-install-and-validate invocation — the bug).
└── __tests__/
    └── phase-loop.merge.test.ts           MODIFY
        ├── Flip existing "runs a second base-merge before the validate command
        │   itself" test (line 342) to assert exactly one merge per cycle and
        │   rename accordingly.
        ├── NEW: "install artifacts survive to validate" — records event sequence
        │   [base-merge, install (touches `node_modules/.stamp`), validate (reads
        │   `.stamp`)], asserts one base-merge and validate sees the stamp.
        │   Discharges SC-001.
        ├── NEW: "up-to-date branch — single merge, unchanged behavior" —
        │   validate cycle, base-merge returns { ok: true }, install + validate
        │   run once each. Discharges FR-003 (unchanged path).
        ├── NEW: "retry re-runs install AND merge" — first validate cycle fails,
        │   worker triggers `i--; continue;` (simulated by driving the loop with
        │   a phase list containing validate twice and injecting a failing then
        │   passing result); assert exactly one merge per attempt (2 total across
        │   2 attempts). Discharges Q3-A.
        └── NEW: "implement phase — single merge (symmetry case per Q5-B)" —
            implement phase's base-merge fires once, unchanged. Guards against
            a future edit that reintroduces a double-merge shape for a committed
            merge path.
```

Nothing else in the orchestrator or workflow-engine changes. No config schema changes. No new gate labels. No new relay events. No changes to `base-merge.ts`, `pr-manager.ts`, `label-manager.ts`, `gate-checker.ts`, or `cli-spawner.ts`.

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo (verified — only templates are present under `.specify/`). No project-level constitution constraints apply. General principles honored:

- **Blast radius**: single file + its test file. FR-006's "single atomic PR that modifies `phase-loop.ts`" holds.
- **No premature abstraction**: no new module, no new class, no new interface. The guard is a local `let` inside a for-loop body — the smallest possible expression of "at most once per cycle."
- **Existing DI seams reused**: `BaseMergeRunner` fake in the existing test file covers all new fixtures.
- **Fail-loud on invariant violation**: the guard is a positive check ("have I merged?"). If a future edit adds a third merge call site outside the guarded region, the new "retry re-runs install AND merge" test will catch the miscount.

# Research

## Decision 1 — hoist the merge, do NOT weaken `performBaseMerge`'s cleanup

**Decision**: Fix by removing the between-commands invocation of `performBaseMerge` (structural). Do NOT change `performBaseMerge`'s `git reset --hard` + `git clean -fd` prelude.

**Rationale**:
- `performBaseMerge`'s prelude is load-bearing for its callers: reset-to-branch-tip is the crash-safety story from #864 (§Constraints in that plan: "every phase begins with `git reset --hard origin/<branch>`; nothing persists across phase boundaries"). Softening it into "clean but preserve `node_modules`" would either (a) require enumerating which untracked paths to preserve — brittle and monorepo-shape-specific, or (b) be a general "don't clean" — which would let stale worktrees leak across phase boundaries and reintroduce a different class of tree-drift bug.
- The spec §Fix names the hoist as "the one-mechanism fix" and characterizes cleanup-weakening as "independently defensible hardening." The hoist alone makes the destructive mid-cycle clean structurally unreachable, which is stronger than a weakening that could still be reintroduced by a future double-call.
- Q5-B chose the general "at most once per cycle" rule, which is the hoist expressed as a guard. There is no cheaper narrow variant to prefer.

**Alternatives considered**:
- **A** — Add `.gitignore`-style filtering to `git clean -fd` (skip `node_modules`, `.venv`, `target/`, `dist/`, …). Rejected: enumerates project-shape-specific paths in a repo-agnostic layer; fragile across the fleet.
- **B** — Change the second `runPreValidateBaseMerge` to a no-op when the branch was already merged this cycle (in-place, no hoist). Rejected: same mechanical outcome as the hoist but leaves the second call site as a maintenance hazard for future readers ("why is there a second no-op here?"). The hoist deletes the second call entirely, which is self-explanatory.
- **C** — Stash `node_modules` before the second merge and restore after. Rejected: added machinery for a mid-cycle re-merge that Q2-A already ruled out of scope.

## Decision 2 — retry loop stays above the hoisted call site (Q3-A)

**Decision**: `for (let i = ...; ...; i++) { ... i--; continue; ... }` re-enters phase `i` on retry; the guard bool is declared **inside** the for body, so it auto-resets each iteration. One merge per attempt.

**Rationale**:
- Q3-A states verbatim: "a retry is a new cycle; the install→validate pair re-runs from the hoisted call site, one merge per attempt." Placing the guard bool inside the for body (`let hasBaseMergedThisCycle = false;` right after `const phase = sequence[i]!;`) enforces this by construction — the bool cannot outlive an iteration.
- The alternative (B/C in Q3) would place the guard bool outside the for-body scope and require an explicit reset in retry paths. That is more code and more failure surface for zero behavioral gain.

**Alternatives considered**:
- **B** — Guard bool at method scope, cleared explicitly in retry branches. Rejected: two write sites (init + retry reset) is worse than one (block-scoped `let`).
- **C** — Skip merge on retry entirely. Rejected: would violate the invariant that validate runs against a merged tree — a base advance between the original attempt and the retry would go untested.

## Decision 3 — no drift detection between install and validate (Q2-A)

**Decision**: Accept the staler tree; ship no drift-warning log line.

**Rationale**:
- The drift window is bounded by install duration (typically seconds to a few minutes on cache-warm nodes). Cross-cycle staleness has a separate owner: #892's re-validate-on-base-advance mechanism re-runs validate when `origin/<base>` moves after a full cycle completes.
- A `warn` log with no operator action attached (option B) is a signal without a receiver — clutter, not information.

## Decision 4 — no orchestrator-level end-to-end fixture (Q4-A)

**Decision**: SC-005 is discharged by the SC-001 + SC-002 unit fixtures inside `phase-loop.merge.test.ts`. The smoke-test epic (generacy-ai/tetrad-development#92) exercises the snappoll#4 sequence by construction as standing practice.

**Rationale**:
- The failure surface here is entirely inside `PhaseLoop`'s validate branch; a unit fixture that drives the loop with a fake `BaseMergeRunner` and a fake `cliSpawner` that records event order and file-touch state reproduces the bug's exact shape without an orchestrator process, a real git tree, or a real Docker sandbox.
- The next smoke-test epic's P1 scaffold-plus-siblings phase reproduces the snappoll#4 sequence by construction; its ledger records the outcome post-merge, giving the e2e evidence for free without blocking this PR.

## Decision 5 — general guard, not narrow branch removal (Q5-B)

**Decision**: Wrap **all** `runPre*BaseMerge` call sites in the guard, not only the validate ones.

**Rationale**:
- Implement's pre-phase merge already fires once (there is no double-merge shape in the implement branch today). Wrapping it in the guard is a zero-behavior-change immunization against a future edit that adds a second pre-implement hook (e.g., a "pre-install for implement" that mirrors the pre-validate install shape).
- The regression test "implement phase — single merge (symmetry case per Q5-B)" catches such a future regression by construction.
- FR-006's atomic-PR constraint holds: the guard lives inside `PhaseLoop` and the change is one file + one test file.

## Sources / references

- Spec §Observed and §Fix (this feature).
- `packages/orchestrator/src/worker/phase-loop.ts:263-325` (the double-merge site).
- `packages/orchestrator/src/worker/base-merge.ts:98-107` (the destructive reset/clean prelude — unchanged by this fix).
- `packages/orchestrator/src/worker/__tests__/phase-loop.merge.test.ts:342-367` (the test that currently asserts the buggy behavior — flipped by this PR).
- `specs/864-found-during-cockpit-v1/plan.md` (originating design for the pre-phase base-merge; establishes the "reset-at-start is the crash-safety story" invariant).
- `specs/892-*` (re-validate-on-base-advance — the cross-cycle drift owner, referenced by Q2-A).
- generacy-ai/tetrad-development#92 (the smoke-test epic that exercises the snappoll#4 sequence as standing practice — referenced by Q4-A).

# Implementation Plan: Found during the cockpit v1

**Feature**: Surface the server-side PR-feedback loop as `issue-transition` events on the cockpit event plane, and close the `agent:in-progress` under-cleaned-terminal-state leak on every `pr-feedback-handler.ts` exit path.
**Branch**: `926-found-during-cockpit-v1`
**Status**: Complete

## Summary

Two-part fix. **(1)** Promote `waiting-for:address-pr-feedback` to **index 1** of `WAITING_PIPELINE_ORDER` in `packages/cockpit/src/state/precedence.ts` — immediately after `blocked:stuck-feedback-loop`, ahead of every other `waiting-for:*` gate. Under Q1→A, this applies #883's precedent verbatim ("surface the more-specific active state first when both coexist") to `address-pr-feedback` vs. **any** listed passive gate, not just the documented `implementation-review` co-occurrent. With the promotion, the add and remove edges of `waiting-for:address-pr-feedback` each emit exactly one `issue-transition` event; the existing auto playbook D.3 / D.4 dispatch rules fire correctly with zero playbook change. **(2)** Refactor `pr-feedback-handler.ts` so `agent:in-progress` is cleared **structurally** at a single shared exit path (try / `finally`) covering all four terminal returns (Case A line 222, Case B line 232, blocked-stuck lines 302 / 337, happy line 357). On the happy path, the clear collapses into a single `removeLabels(['waiting-for:address-pr-feedback', 'agent:in-progress'])` call (Q3→A). Also produces the FR-010 plan-phase audit (see `data-model.md` §Audit table) for the six other unlisted `waiting-for:*` gates: one gate (`waiting-for:sibling-review`) is confirmed to reproduce this same "no transition" failure mode with a listed gate and gets its own follow-up; the other five have no demonstrated co-occurrence and stay as-is with the finding recorded.

## Technical Context

- **Language**: TypeScript (ESM, Node ≥ 22).
- **Primary packages touched**:
  - `packages/cockpit` — classifier + precedence table (source of the curated state).
  - `packages/orchestrator` — `worker/pr-feedback-handler.ts` structural exit refactor.
- **Test frameworks**: `vitest` (existing suites at `packages/cockpit/src/__tests__/classifier.test.ts`, `packages/orchestrator/src/worker/__tests__/`).
- **No new runtime dependencies.** The whole change is source-file edits + tests.
- **No wire-format changes.** `issue-transition` event payload shape is unchanged (see FR-011 Out-of-Scope in spec).
- **No cross-package interface changes.** `GitHubClient` API (`addLabels` / `removeLabels`) unchanged; the FR-006 "single combined edit" is a caller-side coalescing, not an API change.
- **Concurrency**: relies on #879's single-in-flight-per-issue rule — the handler is the sole legitimate writer of `agent:in-progress` on this issue at return time, so a structural clear at every exit cannot race a concurrent legitimate writer (recorded in spec Assumptions).

## Project Structure

```
packages/cockpit/
├── src/
│   └── state/
│       └── precedence.ts                          # FR-001 edit: insert 'waiting-for:address-pr-feedback' at index 1
└── src/__tests__/
    └── classifier.test.ts                         # SC-001 — classifier tests for the new co-occurrence

packages/orchestrator/
├── src/worker/
│   └── pr-feedback-handler.ts                     # FR-005 + FR-006 — structural exit refactor + coalesced happy-path removeLabels
└── src/worker/__tests__/
    └── pr-feedback-handler.test.ts                # SC-004 — four handler-completion tests, one per exit path
                                                    # (create if absent; existing test path per repo convention)

packages/cockpit/                                  # SC-002 — event-stream tests (add / remove edge emits exactly one transition)
└── src/__tests__/
    └── event-stream.test.ts                       # location per existing test layout; may be a new file or extended

specs/926-found-during-cockpit-v1/
├── spec.md                                        # (read-only)
├── clarifications.md                              # (read-only)
├── plan.md                                        # this file
├── research.md                                    # rationale, alternatives considered
├── data-model.md                                  # entities + FR-010 audit table
├── contracts/
│   └── classifier-precedence.md                   # classifier behavior contract
└── quickstart.md                                  # how to verify the fix locally
```

**Files changed by the implementation phase (expected count: 2 production + 2–3 test files + this plan bundle).**

## Constitution Check

`.specify/memory/constitution.md` is **absent** from this repo (`specs/*` uses per-feature spec + plan + tasks without a project-wide constitution). The invariants this change respects are documented in-line:

- **#883 precedent** — "surface the more-specific active state first when both coexist" — applied verbatim (Q1→A).
- **#902 terminal-outcome invariant** — no under-cleaned terminal label pair on any handler exit — applied structurally, not per-site (Q2→C).
- **#879 single-in-flight-per-issue rule** — no legitimate concurrent `agent:in-progress` writer, so a structural clear at every exit is safe.
- **Efficiency contract (post-#403)** — do NOT reintroduce "re-check live state on every event". This fix restores the *actual* transition signal, not incidental redundancy (spec Out of Scope).
- **Wire-format stability** — no changes to `cockpit_await_events` payload shape (spec Out of Scope).
- **Minimum writes, minimum intermediate states** — FR-008 rejects the review-pair re-cycle alternative (spec §Fix); FR-006 collapses the happy-path exit into a single client invocation.

Constitution gate: **PASS** (all constraints structurally satisfied by the design, not by convention alone).

## Design Overview

### Part 1 — Precedence one-line change

Edit `packages/cockpit/src/state/precedence.ts` `WAITING_PIPELINE_ORDER`:

**Before** (lines 26–36):
```ts
export const WAITING_PIPELINE_ORDER: string[] = [
  'blocked:stuck-feedback-loop',
  'waiting-for:spec-review',
  'waiting-for:clarification',
  'waiting-for:plan-review',
  'waiting-for:tasks-review',
  'waiting-for:implementation-review',
  'waiting-for:manual-validation',
];
```

**After**:
```ts
export const WAITING_PIPELINE_ORDER: string[] = [
  'blocked:stuck-feedback-loop',
  // #926: `waiting-for:address-pr-feedback` outranks every waiting-for:*
  // gate — an actively-rewriting-code state is more-specific than any
  // passive gate it can coexist with (Q1→A, following #883's precedent).
  'waiting-for:address-pr-feedback',
  'waiting-for:spec-review',
  'waiting-for:clarification',
  'waiting-for:plan-review',
  'waiting-for:tasks-review',
  'waiting-for:implementation-review',
  'waiting-for:manual-validation',
];
```

Also update the docstring at lines 20–25 to move `address-pr-feedback` out of the "unlisted, falls back to `WORKFLOW_LABELS` index" list, and cross-reference the FR-010 audit for the remaining six.

**Why index 1, not "before `implementation-review`" (Q1→B)**: The precedent principle ("surface the more-specific active state first") doesn't mention `implementation-review` specifically. `address-pr-feedback` means a worker is *actively rewriting code right now*, which is more-specific than **any** passive gate it might coexist with. Index 1 keeps the only ordering that must still win (`blocked:stuck-feedback-loop` outranking it — pause trumps activity) intact.

### Part 2 — Handler structural exit refactor

Refactor `packages/orchestrator/src/worker/pr-feedback-handler.ts` `handle(item, checkoutPath)` so `agent:in-progress` is cleared at a **single shared exit path**. Two implementation options — the tasks phase picks one:

**Option A — `try/finally`** (recommended, matches spec §Fix wording):
```ts
async handle(item: QueueItem, checkoutPath: string): Promise<void> {
  const { owner, repo, issueNumber } = item;
  // ...existing setup...
  try {
    // existing body (Cases A / B / blocked-stuck / happy) — see below for
    // the happy-path coalescing change
  } finally {
    await this.clearInProgressLabel(github, owner, repo, issueNumber);
  }
}
```

Where `clearInProgressLabel` is a new private method mirroring the existing `removeFeedbackLabel` shape (non-fatal on failure, logged).

**Coalescing on the happy path (FR-006 / Q3→A)**: replace the two-call sequence at line 357 (`removeFeedbackLabel` → then `finally` clears `agent:in-progress`) with a **single** `removeLabels([...])` call inside the happy-path branch, and skip the `finally` clear when the happy-path path already coalesced it (idempotency-guarded by a local flag, or the `finally` becomes best-effort `try` around a redundant call — GitHub's API is idempotent on remove, so a second remove of an already-absent label is a no-op).

Concrete shape:

```ts
private async removeFeedbackAndInProgressLabels(...): Promise<void> {
  try {
    await github.removeLabels(owner, repo, issueNumber,
      ['waiting-for:address-pr-feedback', 'agent:in-progress']);
    this.logger.info(...);
  } catch (error) { /* non-fatal */ }
}

// Happy path calls removeFeedbackAndInProgressLabels(...)
// Cases A / B / blocked-stuck call the existing site + the finally clears in-progress
// (Case A already removes waiting-for; Case B / blocked-stuck retain waiting-for by design).
```

**Structural single-point requirement (SC-005)**: the string literal `'agent:in-progress'` MUST appear at exactly one code site inside `pr-feedback-handler.ts` after the refactor (either the coalesced `removeLabels` call **or** the `finally` clear, but the two sites must be a single logical clear-point — the tasks phase decides whether to inline the coalescing or route the happy path through the same shared exit). The grep guard (SC-005) enforces this: exactly one match for `agent:in-progress` inside this file.

**Assumption verified**: #879 guarantees no other worker holds `in-progress` on this issue at return time; the structural clear cannot race a concurrent legitimate writer.

### Test additions

| Test | Location | Requirement |
|------|----------|-------------|
| Classifier: `{implementation-review, address-pr-feedback}` → `address-pr-feedback` | `packages/cockpit/src/__tests__/classifier.test.ts` (extend) | SC-001 |
| Classifier: removing `address-pr-feedback` → `implementation-review` | same | SC-001 |
| Event stream: add edge emits exactly one `issue-transition` | `packages/cockpit/src/__tests__/event-stream.test.ts` (new or extended) | SC-002 |
| Event stream: remove edge emits exactly one `issue-transition` | same | SC-002 |
| End-to-end fixture: request-changes → feedback loop → completion → consumer sees completion | `packages/cockpit/src/__tests__/*.test.ts` (fixture-driven) | SC-003 |
| Handler completion: happy path — `agent:in-progress` absent, `implementation-review + paused` remain | `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.test.ts` | SC-004 |
| Handler completion: Case A — `agent:in-progress` absent | same | SC-004 |
| Handler completion: Case B — `agent:in-progress` absent, `address-pr-feedback` retained | same | SC-004 |
| Handler completion: blocked-stuck (both dispositions) — `agent:in-progress` absent, `blocked:stuck-feedback-loop + address-pr-feedback` present | same | SC-004 |
| Structural single-point check | code review / grep in CI | SC-005 |

## Risks & Mitigations

- **Risk**: promoting `address-pr-feedback` above `spec-review` / `clarification` shifts the curated state on any hypothetical issue that carries both. **Mitigation**: no writer in-tree produces such a combination (see FR-010 audit — `clarification` runs before `implement`, `spec-review` runs before both; neither co-occurs with an actively-rewriting-code state in the speckit-feature lifecycle). Real-world exposure surface is limited to `implementation-review` + `address-pr-feedback` (the observed case), which is exactly the case the fix targets. Any surprise co-occurrence surfaces as a test failure, not a silent regression.
- **Risk**: the `finally` clear at Case B could obscure the retained `address-pr-feedback` label if a reader assumes "handler cleared everything". **Mitigation**: SC-004 Case B assertion pins the retained label; the `finally` only clears `agent:in-progress`. Comment at the `finally` documents this.
- **Risk**: FR-006 coalesced call fails partway (network drop between `removeLabels` HTTP frame send and ACK) — GitHub API has no true atomic multi-label edit. **Mitigation**: acknowledged in FR-006 and spec Assumptions ("partial failure no worse than two sequential calls with a crash between them"). The `finally` is a backstop — if the coalesced call fails to clear `agent:in-progress`, the shared exit path re-attempts (idempotent).
- **Risk**: FR-010 audit misses a co-occurrence path introduced after this PR merges. **Mitigation**: audit records the writer sites and evidence; future PRs adding a new writer to any of the six audited gates are on notice to re-run the co-occurrence check (documented in `data-model.md` §Audit).

## Next Step

Run `/speckit:tasks` (or your `/tasks` skill) to generate the task list from this plan.

---

*Generated by speckit*

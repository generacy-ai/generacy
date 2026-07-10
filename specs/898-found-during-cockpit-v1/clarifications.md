# Clarifications: #898 — waiting-for:merge-conflicts dead-end gate

## Batch 1 — 2026-07-10

### Q1: Ships bundling and delivery order
**Context**: The spec proposes "Two ships": Ship 1 (self-describing pause comment + label-protocol docs) as the interim unblocker, Ship 2 (engine-side handler) as the primary v1. This is a single issue/branch, so it is unclear whether the plan phase should produce one bundled implementation, two sequential PRs on the same branch, or split Ship 2 off into a follow-up issue. This decides scope for the tasks/implement phases downstream.
**Question**: How should Ship 1 and Ship 2 be delivered from this issue?
**Options**:
- A: Single PR bundling both ships. Plan/tasks/implement produce one PR that adds FR-011/FR-012/FR-013 (Ship 1) and FR-001–FR-010 (Ship 2) together.
- B: Two sequential PRs on this branch. Ship 1 lands first (fast interim), Ship 2 lands second on the same branch before merge.
- C: Ship 1 only in this issue; Ship 2 becomes a follow-up issue filed at end of implement. Matches #864's own deferral pattern but re-creates the missed-follow-up risk that produced #898.
- D: Ship 2 only in this issue; Ship 1 is filed as a separate hot-fix issue landed independently before Ship 2. Reflects the P0/P1 tension in FR-014.

**Answer**: A — single PR, both ships. Ship 1's content isn't throwaway interim: the self-describing pause comment stays permanently load-bearing as the escalation surface for `blocked:stuck-merge-conflicts` (when the handler's one attempt fails, the operator needs exactly that manual path). So there's no sequencing value in splitting, and C is explicitly the missed-follow-up failure mode this issue exists to document — the option text says so itself.

### Q2: Label-monitor trigger mechanism and re-enqueue dedupe
**Context**: FR-001 says label-monitor "MUST recognize `waiting-for:merge-conflicts` + `agent:paused` on an issue as an enqueue trigger, analogous to `waiting-for:address-pr-feedback`." The `PrFeedbackHandler` path is poll-based; on each poll interval every issue in the pause state would re-enqueue unless a dedupe key gates it. #849 introduced a paired resume-dedupe pattern (`phase-tracker:...:resume:<gate>`) cleared at pause time by `LabelManager.onGateHit`. Whether the merge-conflicts trigger uses the same dedupe key namespace (and paired-clear on pause) determines re-arm behavior after a failed attempt when an operator later removes `blocked:stuck-merge-conflicts`.
**Question**: What dedupe/re-enqueue semantics apply to the `resolve-merge-conflicts` enqueue trigger?
**Options**:
- A: Poll-based detection with #849-style paired dedupe. Key `phase-tracker:<o>:<r>:<i>:resume:merge-conflicts` (24h TTL) is set when the handler enqueues; cleared when `LabelManager.onGateHit('*', 'merge-conflicts')` fires (next pause). This means one attempt per pause cycle; a fresh pause re-arms detection.
- B: Poll-based detection with no dedupe. Every poll re-enqueues the same item; the worker/handler itself must no-op if already in progress or if `blocked:stuck-merge-conflicts` is already applied. Higher runtime cost, simpler code.
- C: Event-based detection (webhook on label-add). Label-monitor listens only for the `waiting-for:merge-conflicts` label-add event and enqueues exactly once per label-add. Removes the dedupe question entirely but adds a webhook dependency.
- D: Poll-based detection with dedupe *and* explicit re-arm on `blocked:stuck-merge-conflicts` removal. Same as A, plus: when an operator removes the `blocked` label the dedupe key is cleared so the next poll re-attempts (matches #883's block-removal semantics).

**Answer**: None of the listed shapes — use the #862/#879 in-flight dedupe. Options A and D resurrect the `phase-tracker:*:resume:*` key pattern that #862 retired and #879 finished deleting; do not reintroduce it. The enqueue goes through `enqueueIfAbsent` on the itemKey like every other path: poll detects the pause state → enqueue-if-absent (webhook+poll races collapse; in-flight collisions drop with the structured reason line) → handler completion self-clears. Blocked-state gating per #883's semantics: the monitor skips enqueue while `blocked:stuck-merge-conflicts` is present, and removing the label re-enables the next poll naturally — D's re-arm behavior with no keys to clear and no TTLs to tune.

### Q3: Sibling scope-guard detection mechanic (FR-005)
**Context**: FR-005 requires the resolver "MUST NOT resolve by taking that sibling's file wholesale" when a conflicted file "is also modified by a sibling issue whose PR is still open." Assumptions §6 points at `linkedPRs` (#692) + `siblingWorkdirs` (#687), but the concrete detection mechanic is not specified. This is a load-bearing correctness requirement for multi-repo workflows and needs a precise algorithm to test.
**Question**: How does the handler detect that a conflicted file falls under the sibling scope guard?
**Options**:
- A: Per-conflicted-file check against `linkedPRs` file lists. For each conflicted path, query `gh pr view --json files` for every open PR in `context.linkedPRs` (state=OPEN); if the path appears in any sibling's file list, tag the file as "sibling-owned" and pass that constraint into the agent prompt. The agent must NOT take-theirs on those files.
- B: Coarse-grained repo-level guard. If ANY open sibling PR exists in `linkedPRs`, the guard applies to ALL conflicted files uniformly — the agent must produce a merged resolution (three-way) and cannot resort to `git checkout --theirs` or `--ours` on any file. Simpler but stricter.
- C: No detection — advisory-only. The scope guard is expressed only as a prompt-level instruction to the agent CLI ("respect sibling PR changes if any"); no programmatic pre-check is done. Trusts the agent's judgment.
- D: Single-repo pass-through. If `context.linkedPRs` is empty (single-repo issue), the guard is a no-op and the agent may resolve freely. Multi-repo cases use option A.

**Answer**: A, with the enumeration corrected — per-conflicted-file check, but enumerate **open PRs targeting the same base branch in the repo** (the #892 Q4 mechanic), not only `context.linkedPRs`: `linkedPRs` is the multi-repo linkage and misses same-repo siblings, which is precisely the observed case (sibling issues #6/#7/#8). Tag matching paths sibling-owned in the agent prompt and forbid take-theirs/take-ours on them; C's advisory-only version of a MUST-NOT is not a guard.

### Q4: Termination-discipline unit — what counts as "one autonomous attempt" (FR-004)
**Context**: FR-004 requires "one autonomous agent attempt; the agent must either produce a conflict-free committed merge or stop with evidence." The handler's flow is: (1) `git merge origin/<base>` (expected to conflict), (2) agent-CLI invocation, (3) verify committed merge, (4) push. Which of these steps count against the single-attempt budget is unclear — a spurious git-merge failure (network flake, index lock) that fails before agent invocation could either abort with `blocked:*` or retry step 1. This decides SC-002/SC-003 measurability.
**Question**: What operation exactly is the "one autonomous attempt" budget scoped to?
**Options**:
- A: One agent-CLI invocation. Pre-agent git operations (fetch, initial `git merge origin/<base>`) may retry on transient errors (network, index lock) up to a small handler-internal budget without spending the "attempt". The attempt is spent when the CLI is actually invoked; CLI-internal retries are the agent's problem.
- B: The entire handler run, end-to-end. Any failure at any step (fetch, initial merge, agent CLI, push) burns the attempt and moves to `blocked:stuck-merge-conflicts`. No pre-agent retries. Simplest budget accounting.
- C: One `resolve-merge-conflicts` queue-item dequeue. The queue item can retry internally (with backoff) as long as it stays enqueued; the "attempt" is the completion of that queue item. Aligns with worker-level retry patterns elsewhere.
- D: One agent-CLI invocation + bounded pre/post-agent retries per operation class. Pre-agent transient errors (git network/lock) retry up to 3× with backoff; the agent CLI runs exactly once; post-agent push retries up to 3× on network errors. Attempt = agent-CLI invocation only.

**Answer**: D — the attempt is the agent-CLI invocation, exactly once; transient git/network operations get small per-class retry budgets on both sides (fetch/merge 3× with backoff before, push 3× after). An index lock burning the one attempt (B) converts infrastructure noise into `blocked:*` states an operator has to clear — the same transient/terminal distinction #889's Q3 settled.

### Q5: FR-014 priority resolution (P0 vs P1 Ship 1)
**Context**: The Functional Requirements table marks FR-011/FR-012 (Ship 1's self-describing pause comment) as **P1**, but FR-014 (the meta-requirement that Ship 1 is the sole path forward until Ship 2 lands) is marked **P0**. If FR-014 is P0 then Ship 1's content requirements must effectively be P0 too — otherwise the guarantee has no P0 substance. This determines whether Ship 1 gates merge on this issue's PR.
**Question**: What is the correct effective priority for Ship 1's content requirements (FR-011, FR-012, FR-013)?
**Options**:
- A: All of FR-011, FR-012, FR-013 are P0. Ship 1 is the immediate unblocker; without the self-describing pause comment, operators have no path forward. Ship 2 (P1) may land later. FR-014 stands.
- B: FR-011 and FR-012 promote to P0 (comment + conflicted-paths list); FR-013 stays P2 (docs are lower urgency than the runtime comment). Ship 2 stays P1.
- C: FR-014 is a summary/relationship requirement (informational), not itself P0. All of Ship 1 stays P1 alongside Ship 2. FR-014 should be re-marked P2 or dropped.
- D: Ship 1 is entirely P0 including FR-013 docs; Ship 2 is P1. Documentation ships in the same interim window as the runtime comment because operators reading the label-protocol doc need the remedy too.

**Answer**: D, noting Q1 = A makes it mostly moot — with a single PR everything lands together anyway, but label the requirements truthfully: Ship 1 entirely P0 (the pause comment *and* the label-protocol docs — agency#396's audit reads that doc, so it's load-bearing, not deferred polish), Ship 2 P1. That keeps FR-014 coherent instead of a P0 pointer at P1 substance.

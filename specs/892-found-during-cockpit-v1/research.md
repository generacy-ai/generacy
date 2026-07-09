# Research: Base-advance re-validate + bounded validate-fix cycle

**Feature**: `892-found-during-cockpit-v1`
**Companion**: [spec.md](./spec.md), [clarifications.md](./clarifications.md)

## Empirical anchor — finding #43

The design is derived from a concrete reproduction, not a theorized failure. Cockpit v1.5 auto-mode smoke test (tetrad-development#92) hit three P2 issues stranding at `failed:validate`. On christrudelpw/sniplink#8 the validate red reproduces exactly: `next build` type-check fails with `Cannot find module '@/components/CopyButton'`, because `CopyButton` is created by sibling #7 (per the "one creates, one reuses" epic convention). At validate time no sibling had merged, so the merge-preview (#864) equaled the branch tip and the import couldn't resolve.

**Verification of the "stale evidence" hypothesis**: re-running #8's validate against a merge-preview that includes #7 (i.e., today's `origin/develop` after #7 merged) passes 34/34 tests + build. Same code, same worker, same role — different base SHA. This is what makes the "not agent-fixable" argument empirical: the branch's own tree is green; the red was an artifact of the base.

## Decision log

### D1. Epic scoping (Q1)

**Chosen**: Base-branch match — enumerate every open speckit-workflow issue whose PR targets the same base branch as the just-advanced ref. No "epic membership" construct.

**Rationale**:
- Merge-preview staleness is defined *by* the base branch, not by any parent/milestone/label construct. Rescoping by anything else creates an under-scan failure mode (an unrelated PR advances the base and unblocks a stranded red, but the monitor doesn't notice because the two aren't "in the same epic").
- Over-scan is cheap: re-validating a red whose preview didn't materially change is a no-op that comes back red with the same evidence hash, feeding the existing bound.
- Orchestrator does not currently maintain sub-issue / milestone / epic-label indexes. Adding one just to scope this monitor would be a large refactor for zero correctness gain.

**Alternatives rejected**:
- **A: GitHub parent/sub-issue relation** — requires a new GitHub GraphQL call per cycle, adds an under-scan failure mode when parent link is missing/mis-set. Sub-issue relation is a soft convention, not a load-bearing invariant.
- **B: Milestone** — same under-scan failure mode; milestones drift across epic boundaries in practice.
- **C: `epic:<id>` label** — would work if the label were guaranteed present on every speckit-workflow issue, but it isn't; over-scan (D) is cheaper than a new labeling invariant.

**Source**: clarifications.md Q1→D.

### D2. Trigger source (Q2)

**Chosen**: Poll base-branch head SHA on ~60 s cadence (matches existing `LabelMonitorService.pollIntervalMs`). Any SHA change is a "base advance" — sibling merges, external merges, direct pushes.

**Rationale**:
- Local clusters have no webhook infrastructure by design; the orchestrator is poll-based for `LabelMonitorService` and `PrFeedbackMonitorService` today.
- One `gh api commits/{ref}` call per unique `(repo, base)` group per cycle is effectively free — for a typical project with 1–3 base branches active, that's 1–3 calls per minute.
- The SHA change *is* the event. No separate arm-per-source event correlation, no dedupe across event types. The new SHA is both the trigger and the natural dedupe key.
- Q2→A (webhook) silently misses external merges and direct pushes to `develop`. Q2→C (hybrid) adds infrastructure — webhook receiver, correlation logic — for zero benefit over the poll-only path.

**Alternatives rejected**:
- **A: Webhook on `pull_request.closed`** — sibling merges only; external merges + direct pushes are exactly the case SC-004 ("no phantom integration-red fixes") worries about. Also requires infrastructure not present in local clusters.
- **C: Hybrid webhook + poll** — adds two failure modes (webhook receiver crashes, correlation drift) for a marginal latency win that doesn't matter for a 60 s cadence.

**Source**: clarifications.md Q2→B.

### D3. Evidence hash canonicalization (Q3)

**Chosen**: SHA-256 of a **structured extract** — sorted list of `{failing_test_name | failing_module_path}` + first error line per failure, with ANSI escapes / timestamps / absolute paths / per-run identifiers normalized. Full stdout still flows into the fix prompt (FR-005 payload); the hash is identity only.

**Rationale**:
- Whole-transcript hashing (Q3→A) survives most normalizations but *not* durations, progress counters, and compile timings — these vary per run and leak the one-attempt bound.
- Raw hashing (Q3→C) accepts leak from cosmetic differences and relies on #883 termination discipline as the retry-loop bound. Works in principle, but the one-attempt bound is the primary correctness lever for this feature (not a nice-to-have); handing it off to a distant subsystem is fragile.
- Structured extract collapses cosmetic re-runs to the same hash while keeping genuinely different failures distinct. Sorting the failure list makes the hash independent of failure-emission order.
- Collision safety: if two truly different reds happen to normalize to the same hash, the failure mode is "second red is escalated instead of getting its own attempt" — a human sees it, not a silent retry loop. Q3→B "err safe" is preserved.
- Fallback path (`SHA-256 first 16 hex of normalized transcript` when no known error pattern matches): keeps the hash defined for exotic CLIs; extraction is additive.

**Alternatives rejected**:
- **A: Whole normalized transcript** — timing / count differences leak; observed in practice on `next build` (compile times vary 10–30%).
- **C: Raw stdout** — cosmetic differences (ANSI, timestamps) mint new hashes on every run; the one-attempt bound leaks.

**Source**: clarifications.md Q3→B.

### D4. Sibling-duplication guard scope (Q4)

**Chosen**: On-demand `gh pr diff --name-only` across **every open PR targeting the same base branch** (matching D1). No phase-label filter. No cached manifest.

**Rationale**:
- Fix-cycle spawns are rare (only when a red persists on a fresh preview). N small `gh` calls per spawn is cheap.
- Always-current matters exactly here: the file-owning sibling may have opened a PR seconds ago and *may sit in a different speckit phase*. Filtering by phase label (Q4→B) misses this case.
- Cached manifest (Q4→C) adds coherence machinery (invalidate on push, on PR open, on PR close) with a stale-window that lets sibling duplication slip through. The savings don't apply — the calls are rare and cheap.

**Alternatives rejected**:
- **B: Phase-label filter** — misses cross-phase file ownership.
- **C: Queue-side cached manifest** — coherence cost > lookup cost; stale window is exactly the failure mode we're trying to prevent.

**Source**: clarifications.md Q4→A (with Q1 rescoping to "base branch" instead of "epic").

### D5. Fix-cycle agent identity (Q5)

**Chosen**: Fresh worker on the *same* role as the validate that produced the red. Inherits `credentialRole`, tools, and prompt shell. Implementation shares `PrFeedbackHandler`'s spawn→commit→push→re-check plumbing.

**Rationale**:
- The fix is workflow work on the workflow's own branch. The security boundary is defined by the role's tool allowlist; the validate role already has the tools needed to fix the code it validated.
- A dedicated `validate-fixer` role (Q5→B) means new credential wiring, new tool allowlist, new rate-limit accounting for zero security-boundary gain.
- `merge-fixer` (Q5→C) is a plugin-side subagent, not a server-side role. Reusing "the merge-fixer role" is not architecturally possible.
- Observability comes from a distinct event tag (`cluster.validate-fix`), not a distinct identity. FR-012 requirement is met by tagging, not role-splitting.

**Alternatives rejected**:
- **B: Dedicated `validate-fixer` role** — new credential wiring, new tool allowlist for no security-boundary gain.
- **C: Reuse `merge-fixer` role verbatim** — doesn't exist server-side to reuse.

**Source**: clarifications.md Q5→A.

### D6. Redis key layout for base-advance dedupe

**Chosen**: New key namespace `base-advance-tracker:<owner>:<repo>:<issue>:<baseSha>` with TTL 24 h. Sits alongside `phase-tracker:<owner>:<repo>:<issue>:<phase>`. `PhaseTrackerService` gets two thin passthroughs (`isDuplicateRaw`, `markProcessedRaw`) that accept pre-built keys.

**Rationale**:
- Base-advance dedupe is NOT phase-scoped in the workflow sense. A single issue can be re-armed for many different base SHAs across its lifetime. Encoding this as a phase (e.g., `phase = base-advance:<sha>`) pollutes the phase-scoped semantics and makes it easy to accidentally clear the wrong thing.
- Separate namespace makes the two dedupe surfaces greppable and independently rollback-able. Storm-recovery runbook can `redis-cli --scan --pattern 'base-advance-tracker:*'` without affecting phase-tracker keys.
- Same TTL (24 h) as existing dedupe — long enough to survive a full day of no cluster activity, short enough that a botched deploy self-heals.
- Thin passthroughs (not a new interface split) preserve `PhaseTrackerService`'s single point of control for Redis ops, atomic set-NX semantics, and graceful-degradation on Redis unavailability.

**Alternatives rejected**:
- **Compound phase argument (`isDuplicate('base-advance', baseSha)`)** — pollutes the phase namespace, re-introduces the ambiguity the namespace split is trying to shed.
- **New `BaseAdvanceTrackerService`** — duplicates 90% of `PhaseTrackerService`'s code for a namespace change. Two thin passthroughs cover it.

**Source**: D2 (SHA-as-key) + `packages/orchestrator/src/services/phase-tracker-service.ts` existing surface analysis (Explore agent findings §7).

### D7. Fix cycle invocation site (ordering invariant)

**Chosen**: `ValidateFixHandler.handle()` invoked *only* from `PhaseLoop`'s validate `catch` block when `WorkerContext.resumeReason === 'base-advance'`. First-time validate reds go straight to `LabelManager.onError('validate')` (existing behavior); the fix cycle is a re-run behavior.

**Rationale**:
- Structural enforcement of the ordering invariant. The handler cannot be invoked without the "we already re-validated on a fresh base" precondition.
- Zero API surface for future call sites to accidentally violate the invariant. Reviewer checklist: any new `ValidateFixHandler` call site is a spec violation.
- Alternative (invoke from monitor directly) risks firing on the first red, before the base has advanced, breaking the "must have run (a) first" ordering.

**Source**: spec §Proposal(b) ordering note + plan §Ordering invariant.

### D8. `getRefHeadSha` placement on `GitHubClient` interface

**Chosen**: Add `getRefHeadSha(owner, repo, ref): Promise<string>` to the `GitHubClient` interface in `packages/workflow-engine/src/actions/github/client/interface.ts`. Implementation in `gh-cli.ts` via `gh api repos/{o}/{r}/commits/{ref} --jq .sha`.

**Rationale**:
- Base-advance monitor is not the only future consumer. Dashboard "current base SHA" display, epic-completion attribution ("was this merge the base advance that unblocked X?"), and manual operator debugging all want this call.
- Placing it on the interface (not as a private helper in the monitor) gives future callers a single stable entrypoint.
- 401 handling flows through the same `GhAuthError` path as other methods (per #762 auth-health backstop). No new error taxonomy.

**Alternatives rejected**:
- **Private helper in monitor** — future re-implementation drift; no reuse.
- **Direct `executeCommand` from monitor** — bypasses `GhCliGitHubClient`'s `GhAuthError` mapping.

**Source**: Explore agent findings §10 + #762 auth-health pattern.

### D9. Sibling-guard enforcement mechanism (prompt vs. filesystem)

**Chosen**: Prompt-side "do-not-create" file list. Post-commit `git diff --name-only` ∩ `siblingFiles` check as a defense-in-depth guard (revert + escalation on overlap) — implementation deferred to Phase 2 tasks pending empirical evidence.

**Rationale**:
- Filesystem-side block (create `.git/hooks/pre-commit` or mutate the checkout) breaks `PrFeedbackHandler`'s clean spawn model and creates a new failure mode (hook fails to install → duplication slips through anyway).
- Agents historically respect well-scoped prompt constraints — the "do not create files in this list" instruction is far stronger than a general "avoid duplicates" hint because the list is short and concrete.
- Post-hoc `git diff` intersection is a cheap belt-and-suspenders that catches the failure without adding a spawn-time failure mode. Deferred because it may prove unnecessary; land the prompt-only version first, add the check if empirical evidence shows leakage.

**Alternatives rejected**:
- **Filesystem-side create-block** — breaks spawn model, adds install failure mode.
- **Prompt-only, no post-hoc check** — insufficient defense-in-depth; a single agent misinterpretation could duplicate a file.

**Source**: plan §Design Overview `ValidateFixHandler.collectSiblingOwnedFiles` note.

## Implementation patterns

- **Monitor lifecycle**: mirror `LabelMonitorService`/`PrFeedbackMonitorService` — `startPolling()` / `stopPolling()` / `pollCycle()` / `pollRepo()`, `AbortController`, semaphore-limited per-repo concurrency, `authHealth.recordResult` on 401 (#762 pattern).
- **Handler spawn**: mirror `PrFeedbackHandler` — `agentLauncher.launch({ intent, cwd, env, credentials })`, `handle.process.exitPromise`, `commitAndPushChanges()` with no-diff detection (#883 termination), `applyStuckLabel` on failure.
- **Dedupe**: mirror `PhaseTrackerService` atomic set-NX pattern. Add `Raw` passthroughs for pre-built keys.
- **Event emission**: mirror `cluster.credentials` / `cluster.audit` — `emitEvent?.('cluster.validate-fix', payload)` via the `POST /internal/relay-events` IPC route (#594, #598, #600).

## Key sources / references

- `packages/orchestrator/src/services/label-monitor-service.ts` — monitor loop pattern (~line 456).
- `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` — alternative monitor loop pattern.
- `packages/orchestrator/src/worker/pr-feedback-handler.ts` — spawn→commit→push→re-check plumbing reference (line 73, spawn at line 423, no-diff guard at line 292).
- `packages/orchestrator/src/worker/label-manager.ts` — `onError('validate')` → `failed:validate` writer (line 104).
- `packages/orchestrator/src/services/phase-tracker-service.ts` — dedupe key layout (line 36) + atomic set-NX (line 81).
- `packages/orchestrator/src/worker/base-merge.ts` — merge-preview construction (#864 companion).
- `packages/workflow-engine/src/actions/github/client/gh-cli.ts` — `GhCliGitHubClient` + `GhAuthError` (#762 pattern).
- `packages/cockpit/src/gh/wrapper.ts:1167` — `prDiffNames` existing implementation.
- CLAUDE.md #849 — `LabelManager` paired-clear pattern (adjacent completed epic).
- CLAUDE.md #762 — `AuthHealthSink` cluster-side auth-health backstop.
- CLAUDE.md #883 — termination discipline (no-diff → stop) reference implementation.
- clarifications.md Q1–Q5 — clarifying answers, quoted verbatim in decisions D1–D5.

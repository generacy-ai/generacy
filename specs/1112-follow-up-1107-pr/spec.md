# Feature Specification: phase-start-ref key migration + unresolvable-ref handling (follow-up to #1107)

**Branch**: `1112-follow-up-1107-pr` | **Date**: 2026-08-19 | **Status**: Draft
**Issue**: [generacy-ai/generacy#1112](https://github.com/generacy-ai/generacy/issues/1112) | **Workflow**: `speckit-bugfix`

## Summary

Follow-up to #1107 / PR #1110 (merged as `d533b41e`). Two non-blocking findings were identified in review and deferred rather than blocking the merge. Both **fail closed** (a legitimate implement phase that wrote and pushed real product code is falsely failed as "no product-code changes" or "product-diff detection failed"), recoverable only by an operator advance — which is consistent with the Q1=A fail-closed decision accepted on #1107, but each is a *false* failure the guard was never meant to produce. This fix removes both false-failure paths so the #1107 product-diff guard fires only on genuinely empty implement phases.

Both defects live in the phase-start-ref capture/reuse block introduced by #1110 at `packages/orchestrator/src/worker/phase-loop.ts:363-394`, which persists a Redis ref (`phase-start-ref:<owner>:<repo>:<issue>:<branch>:<phase>`, 7-day TTL) so the #1107 phase-scoped product-diff window (`git log --first-parent --no-merges <ref>..HEAD`) spans all pre-restart increments of an implement phase.

## 1. Key-format change orphans in-flight phase-start refs across the upgrade

`packages/orchestrator/src/worker/phase-loop.ts:366`

#1110 changed the persisted Redis key from `phase-start-ref:<owner>:<repo>:<issue>:<phase>` to `phase-start-ref:<owner>:<repo>:<issue>:<branch>:<phase>`. Refs written by the **currently-deployed** build are never read or cleared by the new build, and linger for the full 7-day TTL.

**Failure scenario (one-time, at rollout):**
1. A cluster on the pre-#1110 build persists `phase-start-ref:owner:repo:1107:implement` = `S` at implement entry.
2. The implement CLI writes all its product code.
3. The worker restarts (npm refresh / `generacy update`) before the phase completes.
4. The new build reads `phase-start-ref:owner:repo:1107:<branch>:implement` → null → re-captures `S'` = current HEAD, **already past the product commits**.
5. The resumed increment writes only spec files → `git log S'..HEAD` yields spec-only paths → a legitimate implement phase is failed as "no product-code changes".

**Suggested fix:** on a miss, read through to the legacy key format once (and clear it), or drain legacy keys at startup.

## 2. Reused persisted ref is shape-validated but never checked to resolve in the current checkout

`packages/orchestrator/src/worker/phase-loop.ts:370`

`isValidCommitSha` confirms the ref is SHA-shaped, but not that the commit exists in this checkout.

**Failure scenario:**
1. Attempt 1 on branch `B`: step 2b `performBaseMerge` commits merge `M` (after `git reset --hard origin/B`); step 2c persists `S = M`.
2. The implement CLI dies (timeout/abort) before step 5 `commitPushAndEnsurePr`, so `M` is **never pushed** and the key is deliberately retained.
3. Re-entry lands on a different worker/container with a fresh clone where `M` does not exist.
4. `M` passes `isValidCommitSha` → `getFilesChangedByOwnCommits(M)` runs `git log --first-parent --no-merges M..HEAD` → exit != 0, `fatal: bad revision` → throw → `product-diff detection failed` + `onError('implement')` escalation — **even though the phase just wrote and pushed real product code at step 5**.

Same-checkout re-entry is unaffected (the walk stops at `M`'s first parent).

**Suggested fix:** verify the reused ref resolves (`git cat-file -e <sha>^{commit}`) before use; on failure, treat as absent and re-capture.

## Not in scope here

FR-006 (zero-tasks-checked net) remains deferred per the Q2=A decision on #1107 and is tracked separately.

## User Stories

### US1: In-flight implement phases survive a build upgrade that changed the ref key (P1)

**As an** operator whose clusters auto-upgrade (npm refresh / `generacy update`) mid-workflow,
**I want** an implement phase whose phase-start ref was persisted under the pre-#1110 key format to still be read after the upgrade,
**So that** a worker restart between the CLI's product commits and phase completion does not re-capture a start ref that is already *past* those commits and then falsely fail the phase as "no product-code changes".

The pre-#1110 build writes `phase-start-ref:<owner>:<repo>:<issue>:<phase>`; #1110's build reads `phase-start-ref:<owner>:<repo>:<issue>:<branch>:<phase>`. Across the rollout the legacy ref is orphaned — never read, never cleared — for its full 7-day TTL, and the new build re-captures a HEAD that has already moved past the phase's own commits.

**Acceptance Criteria**:
- [ ] On a miss against the branch-scoped key, the capture logic reads through to the legacy key format (`phase-start-ref:<owner>:<repo>:<issue>:<phase>`) exactly once, inline (lazy read-through, not a startup drain), and, if a valid SHA is found, reuses it as the phase-start ref.
- [ ] A successfully-migrated legacy ref is re-persisted under the branch-scoped key (fresh 7-day TTL) so later same-phase restarts read it there; the branch-scoped write happens before the legacy key is cleared.
- [ ] A legacy key that is read is cleared regardless of outcome (accepted, shape-invalid, or unresolvable) so it cannot be re-read by a later cycle or linger to its TTL.
- [ ] When both the branch-scoped key and the legacy key miss, behavior is unchanged from today (capture current HEAD and persist under the branch-scoped key).
- [ ] A legacy value that fails SHA-shape validation is treated as absent (same guard as the branch-scoped key today), never used as a diff base.

### US2: A reused ref that does not exist in this checkout is re-captured, not escalated (P1)

**As an** operator running speckit implement phases that can resume on a different worker/container,
**I want** a persisted phase-start ref that does not resolve in the current checkout to be treated as absent and re-captured,
**So that** a phase that dies before its merge commit is pushed and then re-enters on a fresh clone does not throw `fatal: bad revision` from `git log <ref>..HEAD` and escalate a phase that just wrote and pushed real product code.

`isValidCommitSha` confirms a ref is 40-hex-shaped but not that the commit is reachable in the working checkout. A pre-phase base merge commit `M` persisted at step 2c, never pushed (CLI died before step 5), is unreachable after re-entry on a fresh clone — yet passes the shape check, so `getFilesChangedByOwnCommits(M)` runs `git log --first-parent --no-merges M..HEAD` → non-zero exit → throw → `product-diff-error` classifier + `onError('implement')` escalation.

**Acceptance Criteria**:
- [ ] Before a persisted (or legacy-migrated) ref is used as the diff base, its existence in the current checkout is verified with `git rev-parse --verify --quiet <sha>^{commit}` (not `git cat-file -e`, which exits 128 for both missing-object and environment faults on git 2.52.0 and cannot disambiguate them).
- [ ] Only a **commit-missing** result (rev-parse exit 1) is treated as absent: a fresh HEAD is captured and persisted under the branch-scoped key, and the phase proceeds normally.
- [ ] A non-commit-missing git failure (rev-parse exit 128, e.g. corrupt/inaccessible git dir) is NOT treated as absent and surfaces via the existing error path.
- [ ] Same-checkout re-entry, where the ref *does* resolve, is unchanged — the reused ref is honored exactly as today.
- [ ] A genuine diff-computation failure unrelated to an unresolvable base ref still surfaces via the existing `product-diff-error` detection path (the fallback does not swallow real errors).

### US3: Healthy runs are unaffected (P2)

**As an** operator,
**I want** implement phases with a valid, resolvable, same-format ref to behave exactly as they do today,
**So that** the two migration/verification guards introduce no new false failures or behavior changes on the common path.

**Acceptance Criteria**:
- [ ] A phase whose branch-scoped ref is present and resolves incurs no legacy read-through and no re-capture — the reused ref is used directly.
- [ ] The phase-start-ref TTL, key namespace, and persist-once-per-phase semantics from #1110 are preserved.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | On a miss against the branch-scoped key (`phase-start-ref:<owner>:<repo>:<issue>:<branch>:<phase>`), the capture logic MUST fall back to reading the legacy key (`phase-start-ref:<owner>:<repo>:<issue>:<phase>`) once, inline, before capturing a fresh HEAD. | P1 | Migration path for refs written by the pre-#1110 build. Legacy value is subject to the same `isValidCommitSha` shape check. **Clarified (Q2=A): lazy read-through, not a startup drain** — a boot-time drain cannot supply the branch component (only knowable from `context.branch` in the phase loop), would only be able to DELETE legacy refs an in-flight phase still needs, and is unsafe across the 7 multi-worker replicas sharing one Redis. |
| FR-002 | A legacy ref that is successfully migrated MUST be (a) re-persisted under the branch-scoped key with a fresh 7-day TTL and (b) cleared from its legacy key, so it survives later same-phase restarts *and* is consumed exactly once. Clearing applies to **any** legacy read — accepted, shape-invalid, or unresolvable (consume-once). | P1 | `PhaseTracker.clearRaw`/`setValueRaw` already exist (#1107). **Clarified (Q1=A):** without the re-persist, a second restart misses both keys and re-arms the past-the-commits window — converting a one-time upgrade hazard into an every-restart hazard (violates #1107 Q5=B). Order writes so the legacy key is cleared only after the branch-scoped write succeeds. **Clarified (Q3=A):** clear on any read — post-#1110 nothing constructs the unbranched key, so a rejected legacy value can never become valid and would otherwise linger to TTL / stay eligible after a cross-branch re-entry. |
| FR-003 | Before any persisted ref (branch-scoped or legacy-migrated) is used as the diff base, its existence in the current checkout MUST be verified. A ref that resolves as **commit-missing** MUST be treated as absent; any **other** git failure MUST NOT be treated as absent and MUST surface via the existing error path (per FR-005). | P1 | **Clarified (Q4=B) + implementation caveat:** the `git cat-file -e <sha>^{commit}` probe named on the issue does **not** work — on git 2.52.0 it exits `128` (not 1) for a missing object *and* for "not a git repository", so it cannot distinguish the two. Use **`git rev-parse --verify --quiet <sha>^{commit}`**: exit `1` = commit missing (both full and abbreviated sha; `isValidCommitSha` accepts 7-40 hex), exit `128` = environment fault → genuine error. Requires a new "commit exists in checkout" capability on the git/GitHub client — none exists today (only `getCurrentCommitSha`). |
| FR-004 | When a ref is treated as absent (legacy miss, shape-invalid, or unresolvable), the guard MUST re-capture current HEAD, persist it under the branch-scoped key, and proceed — never throw or escalate on the missing-ref path. | P1 | Reuses the existing capture/persist path at `phase-loop.ts:377-384`. |
| FR-005 | The `product-diff-error` detection-failure path (#1107 SC-005) MUST remain intact for genuine diff-computation failures unrelated to an unresolvable base ref. | P2 | The FR-003 verification is additive; it must not mask real errors from `getFilesChangedByOwnCommits`. |
| FR-006 | Migration/verification diagnostics SHOULD be logged (legacy read-through hit/miss, ref-unresolvable re-capture) at a level consistent with the existing capture-failure `warn` at `phase-loop.ts:388-392`. | P2 | So a rollout-window false-failure, if any, is diagnosable from logs. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Upgrade rollout: legacy ref `S` written under the old key, worker restarts on new build, resumed increment writes only spec files | Phase reuses `S` via legacy read-through; `git log S..HEAD` still contains the earlier product commits; phase passes | Unit/integration test around the capture block with a mocked `PhaseTracker` returning a value only on the legacy key |
| SC-002 | Legacy key consumed exactly once | After a successful legacy read-through, the legacy key is cleared and a second read returns null | Test asserts `clearRaw(legacyKey)` is called |
| SC-003 | Unresolvable ref: persisted `M` does not exist in a fresh checkout | Ref treated as absent, fresh HEAD captured, phase proceeds; no `fatal: bad revision`, no `product-diff-error`, no escalation | Test with a client whose commit-exists check returns false for `M` |
| SC-004 | Same-checkout re-entry with a resolvable ref | Ref reused directly; no legacy read-through, no re-capture; behavior identical to today | Existing #1107 phase-loop / product-diff tests stay green; new test for the resolvable path |
| SC-005 | Genuine detection failure preserved | `product-diff-error` classifier still raised when diff computation throws for reasons other than an unresolvable base ref | Existing #1107 SC-005 test unchanged |

## Assumptions

- Redis is available on every cluster (same assumption as #1107/#1110); the phase-tracker `getValueRaw`/`setValueRaw`/`clearRaw` raw-key API from #1107 is the persistence mechanism.
- The legacy key format is exactly `phase-start-ref:<owner>:<repo>:<issue>:<phase>` (pre-#1110), as changed in PR #1110.
- The migration is a one-time rollout concern: once all in-flight pre-#1110 refs age out (≤7 days) or are drained, the legacy read-through is dead code but harmless. Whether to remove it later is a follow-up, not part of this fix.
- The commit-existence check operates on the local checkout (`context.checkoutPath`), consistent with how `getFilesChangedByOwnCommits` already runs git in `this.workdir`.
- Both defects are independent and each is individually sufficient to cause a false failure; the fix addresses both in the same capture/reuse block.

## Out of Scope

- FR-006 from #1107 (zero-tasks-checked net) — remains deferred per the #1107 Q2=A decision, tracked separately.
- Repairing clusters already stuck from either false-failure during the rollout window (operational — resolved by operator advance / `/cockpit:resume`, exactly as the fail-closed design intends).
- Changing the #1107 product-diff window semantics, exclusion lists, or `PHASES_REQUIRING_CHANGES` membership.
- Removing the legacy read-through after the rollout window (candidate follow-up once no pre-#1110 refs can remain).
- Any change to CLI-exit-code interpretation or the upstream "agent halted with a question, exited 0" defect (#1107 out-of-scope carries forward).

---

*Generated by speckit*

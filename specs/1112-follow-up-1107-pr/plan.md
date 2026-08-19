# Implementation Plan: phase-start-ref key migration + unresolvable-ref handling (#1112)

**Feature**: Remove two false-failure paths in the #1107 phase-scoped product-diff guard — (1) legacy Redis key orphaned by the #1110 key-format change, (2) a shape-valid persisted ref that does not resolve in the current checkout.
**Branch**: `1112-follow-up-1107-pr`
**Status**: Complete

## Summary

Two non-blocking findings deferred from the #1107/#1110 review both make the implement-phase product-diff guard *falsely* fail a phase that wrote and pushed real product code. Both live in the phase-start-ref capture/reuse block at `packages/orchestrator/src/worker/phase-loop.ts:363-394`.

1. **Legacy-key orphan (US1/FR-001/FR-002).** #1110 changed the persisted Redis key from `phase-start-ref:<owner>:<repo>:<issue>:<phase>` to `...:<issue>:<branch>:<phase>`. A ref written by the pre-#1110 build is never read by the new build and lingers for its 7-day TTL. If a worker restarts mid-implement, the new build misses the branch-scoped key, re-captures a HEAD already *past* the CLI's product commits, and fails the phase as "no product-code changes." Fix: on a branch-scoped miss, read through to the legacy key once (lazy, inline), migrate a valid value to the branch-scoped key, then clear the legacy key (consume-once, on any read).

2. **Unresolvable reused ref (US2/FR-003/FR-004).** `isValidCommitSha` confirms 7-40-hex shape but not that the commit exists in *this* checkout. A pre-phase base-merge commit `M` persisted at step 2c but never pushed (CLI died before step 5) is unreachable after re-entry on a fresh clone; it passes the shape check, so `git log --first-parent --no-merges M..HEAD` throws `fatal: bad revision` → `product-diff-error` + escalation. Fix: verify a reused ref with `git rev-parse --verify --quiet <sha>^{commit}` before using it; on **commit-missing (exit 1)** treat as absent and re-capture; on any **other** git failure (exit 128) do not swallow — let it surface via the existing detection-failure path.

Both fixes are contained in one capture/reuse block plus one new local-git capability (`commitExistsInCheckout`) on the `GitHubClient` interface. No change to the #1107 diff-window semantics, exclusion lists, escalation surface, or `PHASES_REQUIRING_CHANGES` membership. FR-006 from #1107 (zero-tasks-checked net) stays deferred.

## Technical Context

- **Language / runtime**: TypeScript, ESM, Node ≥22 (orchestrator + workflow-engine packages).
- **Packages touched**: `@generacy-ai/workflow-engine` (new `GitHubClient` method + `GhCliGitHubClient` impl), `@generacy-ai/orchestrator` (phase-loop capture-block rewrite).
- **Persistence**: Redis via `PhaseTracker` raw-key API (`getValueRaw` / `setValueRaw` / `clearRaw`, #1107). No schema change, no new keys — the legacy key format is pre-existing data being drained.
- **Git surface**: all new git runs execute in `GhCliGitHubClient.workdir` (== `context.checkoutPath`), consistent with `getCurrentCommitSha` / `getFilesChangedByOwnCommits`.
- **Testing**: Vitest. Unit tests around the capture block (mocked `PhaseTracker` + `context.github`) and around the new gh-cli method's exit-code mapping; existing #1107 tests must stay green (SC-004/SC-005).

### Load-bearing clarification decisions (from `clarifications.md`)

| Q | Decision | Consequence for this plan |
|---|----------|---------------------------|
| Q1=A | Re-persist a migrated legacy ref under the branch-scoped key (fresh TTL), then clear legacy — clear only *after* the branch write succeeds. | Migration writes branch-scoped key first, clears legacy second. A crash between them costs one legacy re-read, never a lost window. |
| Q2=A | Lazy per-phase read-through, **not** a startup drain. | Single targeted `getValueRaw(legacyKey)` on a branch-scoped miss. No `SCAN`, no new `PhaseTracker` surface. A drain cannot supply the branch component and is unsafe across the 7 Redis-sharing replicas. |
| Q3=A | Clear the legacy key on **any** read (accepted, shape-invalid, or unresolvable) — consume-once. | The legacy `clearRaw` fires whenever a legacy value was read at all; post-#1110 nothing re-creates the unbranched key, so a rejected value can never become valid. |
| Q4=B + caveat | Only **commit-missing** means absent; other git failures surface via the existing error path. The `git cat-file -e` probe named on the issue does **not** disambiguate on git 2.52.0. | Use `git rev-parse --verify --quiet <sha>^{commit}`: exit 0 = present, exit 1 = commit-missing → absent, exit 128 = environment fault → throw. |

## Fix Design

### A. New git capability — `commitExistsInCheckout` (FR-003)

No existing `GitHubClient` method answers "does this commit exist in the local checkout." Add one, mirroring the local-git methods already added by #1107.

`packages/workflow-engine/src/actions/github/client/interface.ts` — add to the interface (next to `getCurrentCommitSha` / `getFilesChangedByOwnCommits`):

```ts
/**
 * Whether `sha` resolves to a commit object in the local checkout (#1112).
 * Runs `git rev-parse --verify --quiet <sha>^{commit}` in the workdir.
 * @returns true when the commit exists (exit 0), false when it is missing
 *   (exit 1 — both full and abbreviated shas).
 * @throws Error on any other git failure (exit 128, e.g. corrupt/inaccessible
 *   git dir) so an environment fault is never mistaken for a missing commit.
 */
commitExistsInCheckout(sha: string): Promise<boolean>;
```

`packages/workflow-engine/src/actions/github/client/gh-cli.ts` — implementation (place beside `getFilesChangedByOwnCommits`, ~line 1431):

```ts
async commitExistsInCheckout(sha: string): Promise<boolean> {
  const result = await executeCommand('git', [
    'rev-parse', '--verify', '--quiet', `${sha}^{commit}`,
  ], { cwd: this.workdir });

  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false; // commit-missing (FR-003, Q4=B)
  throw new Error(
    `git rev-parse --verify --quiet ${sha}^{commit} failed ` +
      `(exit ${result.exitCode}): ${result.stderr.trim()}`,
  );
}
```

`GhCliGitHubClient` is the **only** implementer of `GitHubClient` (verified by grep for `implements GitHubClient`), so no other production impl needs updating. Every test that stubs `context.github` for the phase-loop guard must add `commitExistsInCheckout` (default `mockResolvedValue(true)`).

**Rationale for `rev-parse --verify --quiet` over `cat-file -e` (Q4 caveat, measured on git 2.52.0):** `git cat-file -e <sha>^{commit}` exits `128` for a plainly-missing object *and* for "not a git repository," so it cannot distinguish the two. The plain `cat-file -e <sha>` form exits `1` for a missing 40-hex object but `128` for a missing *abbreviated* sha, and `isValidCommitSha` accepts 7-40 hex — so it would misclassify short refs. `rev-parse --verify --quiet <sha>^{commit}` exits `1` for both full and abbreviated missing commits and `128` only on environment faults — the exact split FR-003/Q4=B requires.

### B. Capture/reuse block rewrite (FR-001, FR-002, FR-003, FR-004, FR-006)

Rewrite `phase-loop.ts:363-394`. Add a legacy key alongside the branch-scoped key, and thread the read → migrate → resolve-check → capture sequence. Structure (illustrative — final code follows repo style):

```ts
let phaseStartRef: string | undefined;
const phaseStartRefBranch = context.branch ?? 'no-branch';
const requiresChanges = PHASES_REQUIRING_CHANGES.has(phase);
const phaseStartRefKey = requiresChanges
  ? `phase-start-ref:${owner}:${repo}:${issue}:${phaseStartRefBranch}:${phase}`
  : undefined;
// Legacy (pre-#1110) key omits the branch component — drained lazily (FR-001).
const legacyPhaseStartRefKey = requiresChanges
  ? `phase-start-ref:${owner}:${repo}:${issue}:${phase}`
  : undefined;

if (phaseStartRefKey !== undefined) {
  try {
    const rawBranch = await deps.phaseTracker?.getValueRaw(phaseStartRefKey);
    let existing = isValidCommitSha(rawBranch) ? rawBranch : null;

    // FR-001/FR-002: legacy read-through on branch-scoped miss (consume-once).
    if (existing === null && legacyPhaseStartRefKey !== undefined) {
      const rawLegacy = await deps.phaseTracker?.getValueRaw(legacyPhaseStartRefKey);
      if (rawLegacy != null) {
        const legacyValid = isValidCommitSha(rawLegacy) ? rawLegacy : null;
        if (legacyValid !== null) {
          // Q1=A: re-persist under the branch-scoped key BEFORE clearing legacy.
          await deps.phaseTracker?.setValueRaw(
            phaseStartRefKey, legacyValid, PHASE_START_REF_TTL_SECONDS,
          );
          existing = legacyValid;
          this.logger.info({ phase }, 'migrated legacy phase-start-ref to branch-scoped key');
        } else {
          this.logger.warn({ phase }, 'legacy phase-start-ref failed SHA-shape check — discarding');
        }
        // Q3=A: clear on ANY legacy read (accepted or rejected), after the branch write.
        await deps.phaseTracker?.clearRaw(legacyPhaseStartRefKey);
      }
    }

    // FR-003/FR-004: verify a reused ref (branch-scoped or migrated) resolves here.
    if (existing !== null && !(await context.github.commitExistsInCheckout(existing))) {
      this.logger.warn(
        { phase, ref: existing },
        'persisted phase-start-ref does not resolve in this checkout — re-capturing',
      );
      existing = null; // commit-missing → treat as absent
    }

    if (existing === null) {
      const captured = await context.github.getCurrentCommitSha();
      if (!isValidCommitSha(captured)) {
        throw new Error(`getCurrentCommitSha returned a non-SHA value: ${JSON.stringify(captured)}`);
      }
      phaseStartRef = captured;
      await deps.phaseTracker?.setValueRaw(phaseStartRefKey, phaseStartRef, PHASE_START_REF_TTL_SECONDS);
    } else {
      phaseStartRef = existing;
    }
  } catch (err) {
    this.logger.warn(
      { phase, err: String(err) },
      'phase-start-ref capture failed — guard will treat as detection failure',
    );
  }
}
```

**Why FR-005 is preserved for free.** A non-commit-missing git fault makes `commitExistsInCheckout` throw. The throw is caught by the block's existing `try/catch`, which logs a warn and leaves `phaseStartRef === undefined`. Downstream at `phase-loop.ts:814-816`, `undefined` throws `phase-start ref was not captured before CLI spawn`, which the step-5b `try/catch` (`:821-848`) turns into the `product-diff-error` classifier + escalation — exactly #1107's SC-005 path. So an environment fault surfaces via the existing error channel with **no** new handling, and is never re-captured as if absent (Q4=B). This is the same "fail-to-undefined → detection-failure" contract #1107 already documents.

**Ordering guarantees.** Branch-scoped write precedes legacy clear (Q1=A). Legacy clear fires on any legacy read (Q3=A). The resolve-check runs after migration, so an unresolvable *migrated* value is re-captured and overwrites the branch-scoped key with fresh HEAD — the stale migrated write is harmlessly replaced.

**Unchanged.** The step-5b consumption (`:813-848`), the empty-`productFiles` escalation (`:850-892`), the pass-path `clearRaw(phaseStartRefKey)` (`:894-898`), the TTL constant, the key namespace, and persist-once semantics all stay as-is (US3/SC-004).

## Project Structure

```
packages/workflow-engine/src/actions/github/client/
  interface.ts                         # + commitExistsInCheckout on GitHubClient
  gh-cli.ts                            # + commitExistsInCheckout impl (rev-parse --verify --quiet)
  __tests__/gh-cli.commit-exists.test.ts   # NEW: exit 0/1/128 mapping (mock executeCommand)

packages/orchestrator/src/worker/
  phase-loop.ts                        # rewrite capture/reuse block :363-394
  __tests__/phase-loop.product-diff.test.ts  # + legacy migration / resolve-check cases;
                                             #   makeGithub() gains commitExistsInCheckout

.changeset/
  1112-phase-start-ref-migration.md    # NEW: workflow-engine minor, orchestrator patch
```

## Test Plan (maps to Success Criteria)

| SC | Test | Location |
|----|------|----------|
| SC-001 | Legacy `S` present only on the legacy key; branch-scoped miss → migrate + reuse `S`; `getFilesChangedByOwnCommits` still called with `S`; phase passes. Assert `setValueRaw(branchKey, S)` and `clearRaw(legacyKey)` fired. | `phase-loop.product-diff.test.ts` (mock `phaseTracker`) |
| SC-002 | After a legacy read-through, `clearRaw(legacyKey)` is called exactly once (accepted case) and also on the shape-invalid case. | `phase-loop.product-diff.test.ts` |
| SC-003 | `commitExistsInCheckout` returns `false` for the persisted ref → fresh HEAD captured, `setValueRaw(branchKey, HEAD)` written, phase proceeds; no throw, no `product-diff-error`, no escalation. | `phase-loop.product-diff.test.ts` |
| SC-004 | Branch-scoped ref present and `commitExistsInCheckout` → true → no legacy read, no re-capture, ref reused directly; existing #1107 tests unchanged. | existing suites + one new resolvable-path case |
| SC-005 | `commitExistsInCheckout` **throws** (exit 128) → `phaseStartRef` undefined → `product-diff-error` classifier + escalation still raised. Plus gh-cli exit-code unit test asserting exit 128 throws while exit 1 returns false. | `phase-loop.product-diff.test.ts` + `gh-cli.commit-exists.test.ts` |

All existing `phase-loop*.test.ts` / `product-diff.test.ts` stubs that reach the capture block with an injected `phaseTracker` must add `commitExistsInCheckout: vi.fn().mockResolvedValue(true)` to their `context.github` stub; stubs without `phaseTracker` are unaffected (getValueRaw undefined → fresh-capture path, no resolve-check).

## Constitution Check

No `.specify/memory/constitution.md` present — no project-constitution gates to evaluate. Changeset gate (CLAUDE.md): both touched packages ship non-test `src/` changes → one new `.changeset/*.md` required, bumps below.

## Changeset

`.changeset/1112-phase-start-ref-migration.md`:
- `@generacy-ai/workflow-engine` **minor** — new public `GitHubClient.commitExistsInCheckout` capability (new method on a public interface).
- `@generacy-ai/orchestrator` **patch** — internal defect fix in the phase-loop guard; no new public exports. (`workflow:speckit-bugfix`.)

Single file, both bumps — mirrors the `1107-implement-product-diff-guard.md` shape.

## Risks / Notes

- **Redis-down degradation**: `getValueRaw`/`setValueRaw`/`clearRaw` already degrade to null/no-op when Redis is unavailable (#1107). A legacy read that no-ops leaves nothing migrated → fresh capture path → same behavior as today. Consume-once is best-effort by design (Q3=A rationale).
- **Migration is transient**: once all pre-#1110 refs age out (≤7 days), the legacy read-through is dead but harmless. Removal is an explicit follow-up (Out of Scope), not this fix.
- **No cross-package export churn**: `commitExistsInCheckout` is consumed only via the already-imported `context.github: GitHubClient`; no new import edges.

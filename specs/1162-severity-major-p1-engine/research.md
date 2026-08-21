# Research: Keep engine bookkeeping sidecars out of PR branches

All decisions are pre-settled by `/clarify` (Q1–Q5). This document records the
*implementation-level* choices those clarifications imply, grounded in the code on this
branch.

## Decision 1 — Single source of truth for the three sidecar patterns

**Decision**: Add `ENGINE_SIDECAR_PREFIXES` + `isEngineSidecar(path)` to `product-diff.ts`
and consume it from BOTH the staging filter (FR-001) and the product-diff exclusion
(FR-004).

```
export const ENGINE_SIDECAR_PREFIXES = [
  '.generacy/review-findings-',
  '.generacy/review-candidate-',
  '.generacy/pause-context-',
] as const;
export function isEngineSidecar(p: string): boolean {
  return ENGINE_SIDECAR_PREFIXES.some((prefix) => p.startsWith(prefix));
}
export const EXCLUDED_PATH_PREFIXES = ['specs/', ...ENGINE_SIDECAR_PREFIXES];
```

**Rationale**: FR-001 and FR-004 must match the *same* set of paths. A single exported
constant guarantees they never drift. The prefixes are `startsWith` matches on the exact
filename stems the sidecar writers emit (`review-artifact.ts:23-24`, `pause-context.ts:25`),
so they match `<prefix><sanitized-id>.json` but never `.generacy/config.yaml` or
`.generacy/epics/*` (Q3 — verified legitimately tracked via `git ls-files`).

**Alternatives rejected**:
- *Blanket-ignore `.generacy/`* (Q3=B) — would stop tracking genuine `config.yaml` / `epics/*`.
- *Glob/regex matching* — `product-diff.ts` deliberately uses literal `startsWith` (no glob,
  no normalization). Staying literal keeps FR-001 and FR-004 identical in semantics.

## Decision 2 — Targeted staging replaces `git add -A`

**Decision**: In `PrManager.commitAndPush` (`pr-manager.ts:133-146`), replace
`await this.github.stageAll()` with:

```
const status = await this.github.getStatus();
if (status.has_changes) {
  const toStage = [...status.unstaged, ...status.untracked].filter((p) => !isEngineSidecar(p));
  await this.github.stageFiles(toStage);   // no-op if empty
  // commit only if something is actually staged (see caveat below)
}
```

`stageFiles(files: string[])` already exists (`gh-cli.ts`, `git add ...files`; no-op on
empty). Passing a deleted path to `git add` stages the deletion, so deletions reported in
`status.unstaged` are still committed.

**Caveat — empty stage after filtering**: if the only working-tree change is a sidecar,
`toStage` is empty and nothing should be committed. The existing code keys "committed" off
`status.has_changes`; the new code must instead key off whether `toStage` is non-empty
(and whether anything is actually staged) so a sidecar-only phase does not produce an empty
commit. The downstream unpushed-commit push logic (`pr-manager.ts:148-161`) is unchanged.

**Rationale**: Q2=A — root cause is the unscoped `git add -A`; `stageFiles` is the existing
scoped alternative.

**Alternatives rejected**:
- *`.gitignore` the patterns* (Q2=B) — broader/riskier; changes repo-tracked state and would
  also hide the files from any intentional `git add`.
- *Write sidecars outside the repo tree* (Q2=C) — couples to the rejected Q1=B and breaks the
  existing in-checkout sidecar readers.

## Decision 3 — Redis mirror lives at the phase-loop layer, not in the executor

**Decision**: Keep the on-disk sidecar as the working store (so every existing sync/async
reader — the gate's `readReviewArtifactSync`, the `remediateTrigger` seam — is unchanged),
and add a thin Redis mirror + reconcile at the **phase-loop** layer, which already holds
`deps.phaseTracker`.

- **Key**: `remediation-count:${owner}:${repo}:${issueNumber}:${branch}`, TTL
  `PHASE_START_REF_TTL_SECONDS` (7 days) — mirrors the `review-findings:` key shape at
  `phase-loop.ts:1985`. `branch = context.branch ?? 'no-branch'`.
- **Mirror (write)**: immediately after the remediate executor returns in the seam
  (`phase-loop.ts` ~:1751), read the post-bump disk count via `readReviewArtifactSync` and
  `await deps.phaseTracker?.setValueRaw(key, String(count), TTL)`. Best-effort — no-op when
  Redis is down.
- **Reset**: in the gate-resume branch (`phase-loop.ts:1545-1558`), alongside the existing
  `resetRemediationCount`, `await deps.phaseTracker?.clearRaw(key)` so a fresh budget also
  clears the durable value.
- **Reconcile (re-entry)**: at the top of the `on-remediation-limit` gate check
  (`phase-loop.ts:1428`, before `readReviewArtifactSync`), read the Redis value; if present
  and greater than the disk sidecar's `remediationCount`, seed the disk sidecar to that value
  via a new `seedRemediationCount(checkoutPath, workflowId, count)` helper. The subsequent
  synchronous read then observes the durable count — the gate reader stays byte-identical.

**Rationale**: Q1=A mandates Redis via `PhaseTracker`. The counter's *durability* is a
phase-loop concern (that layer owns `phaseTracker`, the reset, and the gate read); the disk
sidecar remains the *working* store consumed by the executor and the sync gate. Co-locating
all Redis I/O in the phase-loop keeps the fs helpers Redis-free and leaves the executor
completely untouched (minimal blast radius, no new deps threaded through
`RemediateExecutorDeps`).

**Reconcile policy — `max(disk, redis)`**: after a fresh re-clone the disk sidecar is absent
(count reads 0) while Redis holds the real count; after a same-container restart the disk
value is authoritative and equals Redis. Taking the max is safe in both directions and can
never *lower* a budget already spent — the remediation cap fires at the same effective attempt
count as before the fix (SC-003).

**Alternatives rejected**:
- *Thread `phaseTracker` into `RemediateExecutorDeps` and write Redis inside
  `bumpRemediationCount`* — widens the surface, couples a pure fs helper to Redis, and edits
  the executor. The phase-loop already owns the tracker + reset + gate read, so the mirror
  belongs there.
- *Move the counter entirely into Redis (drop the disk field)* — would force every sync reader
  (`readReviewArtifactSync`) to become async and re-plumb the `remediateTrigger` seam; out of
  scope and higher risk. The disk field stays; Redis is the durability mirror.

## Decision 4 — Pre-existing committed sidecars: documented manual cleanup

**Decision**: Ship `specs/1162-.../scripts/cleanup-committed-sidecars.sh` and document it in
`quickstart.md`. No automated engine action (Q4=C).

**Rationale**: An engine auto-`git rm` across shipped branches is intrusive history mutation
and scope creep (Q4=B rejected); a pure no-op leaves cruft (Q4=A rejected). The FR-004
product-diff exclusion already neutralizes pre-existing committed sidecars at review time, so
the manual script is a cleanliness step, not a correctness dependency.

## Open items / verification for `/tasks` and implement

- Confirm `GitStatus.unstaged` reports deletions the way `git add -A` would (so filtered
  staging still commits removals). If not, add explicit deletion handling in the staging filter.
- Confirm the empty-stage caveat is covered by a test (sidecar-only phase → no empty commit).
- Confirm `PhaseTracker.clearRaw` exists and is best-effort (it is referenced in `types/monitor.ts`).

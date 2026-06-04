# Clarifications

## Batch 1 — 2026-06-04

### Q1: SHA Exposure Mechanism
**Context**: FR-001 lists three candidate locations for the source SHA (version string suffix, `package.json#gitHead`, npm provenance metadata). The choice determines (a) the verification command shape for SC-002, (b) whether the published version string changes appearance, and (c) whether consumers can read the SHA without downloading the tarball. Provenance is the most rigorous but requires `npm view --json` and per-package attestation lookup; a version suffix is immediate but mutates the public version format; `gitHead` is conventional but is **not** automatically populated by `changeset version --snapshot` (it's set by `npm publish` from git tags, which snapshot mode bypasses).
**Question**: Which mechanism should be used to expose the source SHA on a published `preview` tarball?
**Options**:
- A: Append the short SHA to the version string (e.g., `0.0.0-preview-20260604120000-abc1234`). Visible via `npm view ... version`. Mutates the public version format.
- B: Explicitly write `gitHead` (or a custom field like `generacy.sourceSha`) into each `package.json` before publish. Queryable via `npm view ... gitHead`. Version string unchanged.
- C: Both A and B — short SHA in version for human visibility, full SHA in `package.json` for tooling.
- D: Rely on `--provenance` metadata only (no version/package.json change). Requires `npm view --json` + GitHub attestation lookup.

**Answer**: **C** — short SHA in the version string **and** full SHA in a `package.json` field. The version already carries a timestamp suffix, so appending `-<sha7>` is a minor, acceptable extension that makes "which commit?" immediately human-visible via `npm view … version`; the full SHA in `package.json` (`gitHead` or `generacy.sourceSha`) is what the staleness/ancestry check (Q2) should read — no short-SHA collision risk. Set **both** explicitly in the publish step (note: `gitHead` is *not* auto-populated under `changeset version --snapshot`, so write it yourself).

### Q2: Staleness Comparison Semantics
**Context**: FR-002 says the workflow MUST NOT publish a tarball whose source SHA is "older than" the current `@preview` tag's source SHA. "Older" can mean several things, with different failure modes: strict ancestry (`git merge-base --is-ancestor prev new` returning true means safe) is correct for a healthy linear `develop`, but fails if `develop` is force-pushed or if a hotfix lands on `main` and is later cherry-picked. Simple SHA-inequality plus committer-date comparison is robust to history rewrites but can let a force-pushed regression through.
**Question**: How should the workflow decide whether a candidate publish is "older than" the currently published `@preview`?
**Options**:
- A: Ancestry check — refuse to publish if `git merge-base --is-ancestor <candidate> <current-preview-sha>` returns true AND `candidate != current-preview-sha`. (Strict: candidate must be a descendant of, or equal to, current preview.)
- B: Timestamp check — refuse to publish if the candidate's committer date is earlier than the current preview's committer date.
- C: Equal-or-descendant on `develop` — refuse if `current-preview-sha` is not reachable from `candidate` on the `develop` history. (Branch-safe variant of A.)
- D: Simple SHA inequality only — refuse if `candidate == current-preview-sha` (republish of same SHA); allow anything else. (Trusts the trigger.)

**Answer**: **A** — ancestry: refuse to publish if `git merge-base --is-ancestor <candidate> <current-preview-sha>` is true AND `candidate != current-preview-sha` (i.e. the candidate must be a descendant of, or equal to, the current preview's SHA). This directly enforces "only move forward," which is exactly the regression that caused this issue (publishing a commit behind the merge). The force-push/cherry-pick edge is handled by the explicit operator override in Q5 rather than by weakening the default to timestamps.

### Q3: First-Publish / Missing-Baseline Behavior
**Context**: The first run after this feature ships will face an existing `@preview` tag that lacks the SHA field (whichever mechanism Q1 picks). Future republishes after the registry is wiped, or for a brand-new package added to the workspace, hit the same case. Fail-closed would block the rollout; fail-open lets the first publish "set" the baseline. There is no SC for first-publish behavior so this is genuinely ambiguous.
**Question**: When the current `@preview` tag does not exist, OR exists but does not carry the SHA field used for the staleness check, what should the workflow do?
**Options**:
- A: Publish unconditionally (treat as "no baseline to compare against"). The publish itself establishes the baseline for future runs.
- B: Refuse to publish and emit a clear log message ("no baseline SHA found; manually republish to bootstrap"). Requires one manual workflow_dispatch after rollout.
- C: Publish only if triggered by `push: develop` (the auto path is trusted); refuse on `workflow_dispatch` until baseline exists.

**Answer**: **A** — publish unconditionally when there is no baseline (no `@preview` tag, or it exists without the SHA field). There's nothing to be stale against, and the publish itself establishes the baseline. Refusing (B) would block the very first post-rollout publish and every registry-wipe/new-package case.

### Q4: Stale-Detection Failure Mode
**Context**: FR-003 says "the workflow MUST fail loudly" when a stale publish is detected and that "the auto-trigger on the new develop HEAD MUST still produce a valid preview tag." This implies recovery happens via the next `push: develop` event, but it does not say whether the failing run should (a) exit immediately, (b) re-resolve `develop` and retry within the same job, or (c) actively re-dispatch itself on the latest SHA. Option (a) requires that *some* push trigger be in flight or queued — if the staleness was caused by a merge that already finished its push event before this run started, no further auto-trigger will fire.
**Question**: When the workflow detects it is about to publish a stale tarball, what should it do?
**Options**:
- A: Fail the job immediately with a descriptive error; rely on the in-flight or next `push: develop` event to publish the fresh tip. Simplest; assumes pushes are not lost.
- B: Re-checkout `origin/develop` HEAD in the same job, rebuild, and re-run the staleness check (loop up to N times) before failing. Self-healing within a single run.
- C: Fail the job, then re-dispatch the same workflow against `develop` HEAD via `gh workflow run`. Decouples from the original trigger but adds API permissions.

**Answer**: **A** — fail the job immediately with a descriptive error and recover via the next `push: develop`. Pair this with the primary defense of building the **resolved `origin/develop` HEAD** at build time (not the stale event ref), so staleness detection only fires in genuine history-rewrite/rollback situations — where failing loudly is correct and auto-looping (B) or self-re-dispatch (C) would just thrash or mask a real history problem.

### Q5: Workflow Dispatch Ref Input
**Context**: Today, `workflow_dispatch` has no inputs and always builds the tip of the branch chosen in the UI. If an operator needs to roll back `@preview` to a known-good earlier SHA (e.g., after a broken merge), the staleness guard from FR-002 will refuse to publish anything older — which is the entire point, but also blocks legitimate rollback. The spec does not say whether intentional rollback is supported.
**Question**: Should `workflow_dispatch` gain an input (e.g., `force_rollback: boolean` or explicit `target_sha`) to allow operators to bypass the staleness guard for intentional rollback?
**Options**:
- A: No input — staleness guard is absolute. Rollback is out of scope (operators must merge a revert PR to `develop` instead).
- B: Add `force_rollback: boolean` input, default `false`. When true, log a warning and skip the staleness check.
- C: Add `target_sha` input. When provided, build and publish that SHA, with the staleness check still active (allows republishing the *same* SHA, e.g., to recover from a failed publish, but not to go backward).

**Answer**: **B** — add a `force_rollback: boolean` input (default `false`) that logs a warning and skips the staleness check. This gives operators a deliberate, auditable escape hatch for legitimate rollback during an incident without weakening the default guard. (C doesn't actually enable rollback — its guard still refuses to go backward; A forces a slower revert-PR-to-`develop`, which is bad during an incident.)

# Research: Changeset Check Implementation

**Feature**: #720 — Make Changeset Bot a Required, Blocking Check
**Date**: 2026-05-26

## Decisions

### D1: Use bash + `git diff` instead of `pnpm changeset status`

**Decision**: Implement the check as a bash script using `git diff --name-only $BASE $HEAD` for diff inspection.

**Rationale**:
- `pnpm changeset status --since=$BASE` reports whether a changeset was added but uses package-graph analysis rather than raw diff-filter semantics; it cannot easily express "added in *this* PR's diff" (Q1=A requirement).
- Bash + `git diff` has zero install cost. The current workflow performs `pnpm install --frozen-lockfile` (~20–30s) only to run a `find` command. After this change, the check needs nothing beyond `git`, so we can drop `pnpm/action-setup`, `actions/setup-node`, and `pnpm install`.
- Diff-based detection (`--diff-filter=A -- '.changeset/*.md'`) is the exact semantic the clarification (Q1=A) requires; there is no need for higher-level tooling.

**Alternatives considered**:
- `pnpm changeset status --since=origin/develop` — relies on tooling for what is a one-line `git diff`; doesn't naturally distinguish "added in this PR" vs "present on the branch".
- `git log --diff-filter=A --name-only $BASE..$HEAD -- '.changeset/*.md'` — equivalent to `git diff` for this use case; `git diff` is shorter and clearer.

### D2: `--diff-filter=A` (added-only), not `AM` (added or modified)

**Decision**: Match only added `.changeset/*.md` files (`--diff-filter=A`); modifications do not satisfy the check.

**Rationale**: Resolved in clarification Q1 — option C (accept modified) was rejected because each PR should carry its own discrete changeset describing its discrete change. If consolidation is needed, the author deletes and re-adds the file, which then appears as `A` in the diff.

### D3: Path predicates for in-scope and test-only classification

**Decision**:
- **In-scope**: regex `^packages/[^/]+/src/` against `git diff --name-only` output.
- **Test files**: regex `\.(test|spec)\.(ts|tsx)$` OR contains `/__tests__/`.
- **Test-only short-circuit**: filter to in-scope paths; if every remaining entry matches the test regex, exit 0 with a "test-only" log line. If any non-test in-scope file exists, require a changeset.

**Rationale**: Resolved in clarification Q2=A. The path patterns are stable across the repo: every publishable package follows `packages/*/src/` layout; tests use the `*.test.ts`/`*.spec.ts`/`__tests__/` conventions. `grep -E` is portable in `bash`; no jq/yq dependency.

**Alternatives considered**:
- Reading per-package `package.json` to discover which packages are publishable (vs `"private": true`). Rejected: more complex; the current convention (everything under `packages/*/src/` is publishable) is stable enough, and a private package being checked is a noop (empty changeset path is unblocked).
- `tsconfig` project references — overkill for path classification.

### D4: Drop `pnpm install` and node setup from the workflow

**Decision**: After the rewrite, the only tooling the check needs is `git`. Remove `pnpm/action-setup@v4`, `actions/setup-node@v4`, and `pnpm install --frozen-lockfile` from the job.

**Rationale**: Reduces job runtime from ~30s to ~5s; removes a network dependency (pnpm registry) from a required check. Eliminates a class of failure (registry hiccup blocks merge).

### D5: Branch-protection settings rollout sequencing

**Decision**: PR is merged first; the maintainer then adds `Changeset Bot / Changeset Check` as a required status check on `develop` and `main` in repo Settings → Branches.

**Rationale**: If the required check is added to branch protection *before* the workflow ships on the target branch, every open PR shows the check as "expected" but never runs, blocking all merges. Workflow-first, settings-second avoids this deadlock. The PR description must call out the manual step.

### D6: Workflow event triggers

**Decision**: Keep `on.pull_request.types: [opened, synchronize, reopened, ready_for_review]`. Extend `branches:` from `[develop]` to `[develop, main]`.

**Rationale**: Resolved in clarification Q3=B. The existing trigger types are correct — `ready_for_review` covers the draft-to-ready transition (Q5=A keeps the draft skip).

### D7: Drafts skipped (status-quo `if:` guard)

**Decision**: Preserve `if: github.event.pull_request.draft == false`.

**Rationale**: Resolved in clarification Q5=A. Drafts can't be merged into a protected branch anyway; gate fires at "ready for review", the same moment the author is finalizing the PR.

### D8: No bot exemption

**Decision**: No special-casing for `github.event.pull_request.user.type == 'Bot'`.

**Rationale**: Resolved in clarification Q4=A. No current bots touch `packages/*/src/`. If a future code-touching bot needs an exemption, escalate to a safe-list by login (option C in Q4).

## Sources / References

- [Existing workflow](../../../.github/workflows/changeset-bot.yml) — lines 23–30 (the current advisory check).
- [PR #719](https://github.com/generacy-ai/generacy/pull/719) — the bulk catch-up changeset that motivated this fix.
- [Commit 69989cd](https://github.com/generacy-ai/generacy/commit/69989cd) — precedent (May 19) — same drift pattern, also resolved by bulk catch-up.
- [GitHub docs: `pull_request` event payload](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request) — `pull_request.base.sha`, `pull_request.head.sha` field availability.
- [Changesets CLI: `--empty`](https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md) — escape-hatch for source changes that don't warrant a version bump.
- [`git diff --diff-filter`](https://git-scm.com/docs/git-diff#Documentation/git-diff.txt---diff-filterACDMRTUXB82308203) — `A` selects only added files.

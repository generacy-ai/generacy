# Feature Specification: ## Problem

The \`Changeset Bot\` workflow ([\`

**Branch**: `720-problem-changeset-bot-workflow` | **Date**: 2026-05-26 | **Status**: Draft

## Summary

## Problem

The \`Changeset Bot\` workflow ([\`.github/workflows/changeset-bot.yml\`](https://github.com/generacy-ai/generacy/blob/develop/.github/workflows/changeset-bot.yml)) currently emits a \`::warning::\` annotation when a PR doesn't include a changeset, but the job exits 0 regardless. The check shows up in the PR's "Checks" list as **passing**, so:

1. The warning is ignored in practice (it appears in the build log, not in the PR review UI by default).
2. The check can't be set as a "required status check" in branch protection — because requiring a passing check that always passes accomplishes nothing.

The downstream consequence: **~10 feature PRs from #707 to #717 (the entire worker-scale architecture) landed without changesets.** This left every relevant \`@generacy-ai/*\` package frozen on \`stable\` for ~6 days while preview got the new code. The drift was only caught by an end-user when \`npx -y @generacy-ai/generacy@stable launch …\` failed to prompt for workers — at which point I had to file [PR #719](https://github.com/generacy-ai/generacy/pull/719) to do a bulk catch-up changeset.

This is the second time this drift has happened in the repo's recent history (precedent: [\`69989cd\`](https://github.com/generacy-ai/generacy/commit/69989cd) on May 19 — also a bulk catch-up). The pattern is structural: with the workflow advisory-only, drift is inevitable on any multi-PR feature batch.

## Fix

Make the changeset check actually fail when a PR modifies a publishable package's source. The current check at lines 23-30 of the workflow:

\`\`\`yaml
- name: Check for changesets
  run: |
    CHANGESET_FILES=$(find .changeset -name '*.md' ! -name 'README.md' 2>/dev/null | head -1)
    if [ -z "$CHANGESET_FILES" ]; then
      echo "::warning::No changeset found. If this PR includes user-facing changes, run 'pnpm changeset' to add one."
    else
      echo "Changeset found — ready for release."
    fi
\`\`\`

becomes:

\`\`\`yaml
- name: Check for changesets when publishable code changed
  run: |
    BASE="\${{ github.event.pull_request.base.sha }}"
    HEAD="\${{ github.event.pull_request.head.sha }}"

    # Are any changes in publishable package sources?
    if ! git diff --name-only "\$BASE" "\$HEAD" | grep -qE '^packages/[^/]+/src/'; then
      echo "No publishable-package source files changed; skipping changeset check."
      exit 0
    fi

    CHANGESET_FILES=\$(find .changeset -name '*.md' ! -name 'README.md' 2>/dev/null | head -1)
    if [ -z "\$CHANGESET_FILES" ]; then
      echo "::error::This PR modifies packages/*/src/* but adds no changeset."
      echo "Run \`pnpm changeset\` from the repo root to add one before merging."
      echo "If this change genuinely doesn't need a version bump (e.g. comment-only,"
      echo "test-only), add an empty changeset with \`pnpm changeset --empty\`."
      exit 1
    fi

    echo "Changeset found — ready for release."
\`\`\`

Then in repo Settings → Branches → Branch protection rules for \`develop\`: add \`Changeset Bot / Changeset Check\` as a **required** status check.

## Why path-scoped, not blanket

Spec-driven PRs from the agent typically include large \`specs/<n>-*/\` directories alongside the code change. A blanket "every PR needs a changeset" rule would force changesets onto PRs that are pure docs / specs / CI / dependabot bumps. Scoping the gate to \`packages/*/src/\` keeps the check signal-rich: a PR with no source changes doesn't need a changeset and isn't blocked.

The empty-changeset escape hatch (\`pnpm changeset --empty\`) covers the rare case where source changed but no version bump is appropriate (e.g. typo fix in a comment, refactor that doesn't touch the public API). \`changesets/cli\` already supports this and the existing release workflow handles empty changesets fine — they get consumed without bumping versions.

## Files touched

- \`.github/workflows/changeset-bot.yml\` — the diff above.
- Repo Settings → Branches → \`develop\` branch protection — add the required status check (manual step, not a code change; called out in the PR description for whoever merges).

## Acceptance

- A PR that modifies \`packages/orchestrator/src/foo.ts\` without a changeset is **blocked** from merging into develop with a clear error pointing at \`pnpm changeset\`.
- A PR that only modifies \`specs/*\`, \`docs/*\`, \`.github/*\`, \`README.md\`, or other non-publishable paths **passes** the check without needing a changeset.
- A PR that intentionally has no version bump can use \`pnpm changeset --empty\` to satisfy the check.
- The next batch of feature PRs ships with changesets per-PR, no bulk catch-up needed.

## Out of scope

- Forcing changeset content quality (auto-rejecting one-liner changesets, etc.). The check is presence-based; content quality stays a review concern.
- Backfilling changesets for the PRs that landed without them (already handled by #719 via the bulk catch-up).
- Applying the same gate on \`generacy-cloud\` — separate repo, may or may not have the same problem; worth checking but file separately if so.

## Clarified Decisions (Batch 1 — 2026-05-26)

These resolve the five clarification questions; see \`clarifications.md\` for rationale.

- **Q1 → A — Diff-based changeset detection.** Replace the filesystem-presence check with `git diff base.sha..head.sha --diff-filter=A -- '.changeset/*.md'`. The changeset must be **added in this PR's diff**, not merely present on disk. This closes the cross-PR leak that caused the #707–#717 drift. (Workflow already has `fetch-depth: 0`.)
- **Q2 → A — Test-only diffs skip the check.** When every entry in the diff under `packages/*/src/` matches one of `*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.spec.tsx`, or contains `/__tests__/`, exit 0 with a "test-only" log line. If any non-test file is in scope, the changeset is required.
- **Q3 → B — Gate `develop` and `main`.** Extend the workflow's `on.pull_request.branches` to `[develop, main]` and add `Changeset Bot / Changeset Check` as a required status check on **both** branch-protection rules. Standard `develop → main` sync PRs satisfy the check (added changesets). `changeset-release/main` bot PRs exit early via the path-scoped guard (they don't touch `packages/*/src/`).
- **Q4 → A — No bot exemption.** Apply the gate uniformly regardless of `github.event.pull_request.user.type`. No current bots touch `packages/*/src/`; if a future code-touching bot needs an exemption, escalate to a safe-list (option C) at that time.
- **Q5 → A — Skip drafts.** Preserve the existing `if: github.event.pull_request.draft == false` guard. The gate fires at "ready for review" — the same moment the author finalizes the PR.

## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*

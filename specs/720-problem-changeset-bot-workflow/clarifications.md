# Clarifications — #720 Make Changeset Bot a Required, Blocking Check

## Batch 1 — 2026-05-26

### Q1: Cross-PR changeset leak
**Context**: The current workflow detects changesets via `find .changeset -name '*.md' ! -name 'README.md'` — i.e., **filesystem state at PR head**. If `.changeset/` already contains a markdown file from a different, still-unmerged PR (or one merged on another branch but present in the working tree), the current PR satisfies the check **without adding its own changeset**. The spec's US3 acceptance criterion ("contains an empty changeset file under `.changeset/`") preserves this filesystem-only behavior. This is the structural gap that allowed PRs #707–#717 to drift unnoticed once a single early changeset existed.
**Question**: Should the new blocking check require the changeset file to be **added in this PR's diff** (i.e., a `.changeset/*.md` file present in `git diff base.sha..head.sha --diff-filter=A`), rather than just present on disk?
**Options**:
- A: Yes — require a changeset added/modified in the PR diff (strictest; closes the leak that caused the original incident).
- B: No — filesystem presence is sufficient (matches spec as written; simpler check; relies on author discipline).
- C: Diff-based, but also accept *modified* (`AM`) changeset files in this PR's diff (catches "I updated the existing one" cases).

**Answer**: A — require the changeset to be added in *this PR's* diff. The structural fix. The original incident (PRs #707–#717 drifting unnoticed) was *caused* by the filesystem-presence check — one early changeset on the branch made every subsequent PR look fine. B preserves the bug and bets on author discipline; discipline alone has already failed at scale. C blurs the rule for marginal benefit — each PR should carry its own discrete changeset describing its discrete change; if consolidation is needed, delete and re-add (which shows as added in the diff and satisfies A). Diff against `base.sha..head.sha --diff-filter=A` is the right comparison surface; `pull_request` events expose both SHAs and the workflow already has `fetch-depth: 0`.

### Q2: Test-only changes under `packages/*/src/`
**Context**: The path scope `^packages/[^/]+/src/` matches **everything** under `src/`, including `*.test.ts`, `*.spec.ts`, and `__tests__/` files. Tests do not ship to consumers and never warrant a version bump. Forcing an empty changeset on every test-only PR adds noise but keeps the rule mechanically simple. Excluding tests adds complexity but matches release semantics.
**Question**: When the PR's diff under `packages/*/src/` consists **only** of test files (matching `*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.spec.tsx`, or paths containing `__tests__/`), should the check skip (exit 0 with a "test-only" log line) or still require a changeset (typically empty)?
**Options**:
- A: Skip — test-only diffs exit 0 without a changeset (less friction, matches "what ships" semantics).
- B: Require — test-only diffs still need at least an empty changeset (mechanically simpler; uniform rule; one extra command).
- C: Skip, but log a `::notice::` reminding the author they can still add an empty changeset if desired.

**Answer**: A — skip when the diff under `packages/*/src/` is test-only. Tests don't ship to consumers and never warrant a version bump; requiring an empty changeset on every test-only PR is mechanical busywork. Path predicates to use:
- Match `*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.spec.tsx`.
- Match any path containing `/__tests__/` (covers `packages/foo/src/__tests__/*` and nested `__tests__` dirs).

Algorithm: filter the diff to in-scope (`packages/*/src/`) paths, then check that every remaining entry matches one of the test patterns above. If yes → skip. If even one non-test file is in the diff → require. C (skip with `::notice::`) adds CI log noise without operational benefit.

### Q3: Branch protection scope (`develop` vs `develop` + `main`)
**Context**: FR-006 and SC-001 reference `develop` branch protection only. The current workflow's `on.pull_request.branches` is also `[develop]`. Release-please / promote PRs targeting `main` would not be evaluated by this check at all under that scope. If a manual hotfix PR were opened against `main`, it would bypass the gate entirely.
**Question**: Should the check (and branch-protection requirement) apply only to PRs targeting `develop`, or also to PRs targeting `main`?
**Options**:
- A: `develop` only — matches the spec as written; relies on release-please for `main` promotions (which carry their own changesets aggregated).
- B: `develop` and `main` — defense in depth against hotfix PRs and accidental direct-to-main work; small extra surface.
- C: `develop` only for now; file a follow-up issue if a `main`-bypass case is observed.

**Answer**: B — apply the gate to PRs targeting both `develop` and `main`. Catches the manual-hotfix-to-main case. Marginal extra surface; meaningful defense in depth.

Compatibility notes:
1. **`develop → main` sync PRs** (e.g. #718, #721, #724) work fine under B + Q1=A. They contain newly-added `.changeset/*.md` files relative to `main`; `git diff main..head --diff-filter=A -- '.changeset/*.md'` returns the added changesets; check passes.
2. **`changeset-release/main` PRs** (the bot-opened "Version Packages" PR — #722, #725) **delete** `.changeset/*.md` files (consuming them) and modify `package.json` + `CHANGELOG.md`. They don't touch `packages/*/src/`, so the path-scoped guard exits 0 before the changeset check fires. No special case needed.

Hotfix PRs that DO touch `packages/*/src/` get caught — which is exactly the intent. C defers the same way the original incident did.

### Q4: Bot-authored PRs (Dependabot / Renovate / etc.)
**Context**: Dependabot/Renovate PRs almost never touch `packages/*/src/` (they update `package.json` and lockfiles, which are outside the scope), so this is mostly hypothetical. But a future bot — e.g., an automated codemod, a translation bot, or an internal release bot — could open PRs that *do* touch `packages/*/src/` without a human author available to run `pnpm changeset`. The spec is silent on bot exemptions.
**Question**: Should the check exempt PRs whose author is a bot (`github.event.pull_request.user.type == 'Bot'`), or apply the gate uniformly?
**Options**:
- A: Apply uniformly — no bot exemption; if a bot touches `src/`, it must add a changeset (or the maintainer adds one before merging).
- B: Exempt bots — bot-authored PRs auto-pass with a log line indicating exemption.
- C: Exempt only specific bots by login (e.g., `dependabot[bot]`, `renovate[bot]`); fail others.

**Answer**: A — apply the gate uniformly; no bot exemption. No current bots touch `packages/*/src/` (Dependabot/Renovate stay in `package.json` / lockfiles, outside the gate's scope), so this is largely hypothetical. The operative principle for any code-touching bot is: if you produce code that ships, you produce a changeset. B is footgun-y (any service account / GitHub App could bypass by opening PRs under a bot identity). C is fine in principle but adds maintenance surface today for zero benefit. If/when a future codemod or translation bot lands and routinely touches `src/`, two paths remain open: extend the workflow to safe-list it (escalation to C), or have the bot's tooling include an empty changeset in its PR generation.

### Q5: Draft PR behavior
**Context**: The current workflow runs only on non-drafts (`if: github.event.pull_request.draft == false`). With the new exit-1 behavior, a draft author who later marks the PR ready-for-review will first see the failure at that transition, after they thought they were done. Running the check on drafts surfaces the requirement earlier but adds CI noise for in-progress work.
**Question**: Should the new blocking check run on draft PRs, or continue skipping them (status-quo)?
**Options**:
- A: Continue skipping drafts — matches current `if:` guard; only "ready for review" PRs are gated; aligns with branch-protection (drafts can't be merged anyway).
- B: Run on drafts too — surface the missing-changeset requirement on every push; author fixes it before ready-for-review.
- C: Run on drafts, but emit `::warning::` (advisory) instead of `::error::` (blocking) while draft; flip to blocking on ready-for-review.

**Answer**: A — continue skipping drafts (status-quo). Drafts can't be merged into a protected branch anyway, so the gate has nothing to enforce while a PR is in draft. The natural moment to add the changeset is at "ready for review" — same moment the author is finalizing the PR description, reviewers, etc. B creates a poor iteration UX (CI goes red on WIP commits; meanwhile the PR isn't mergeable). C is the most defensible middle ground but adds workflow complexity for a small UX win — if real-world authors report frustration with the "discovered at ready-for-review" timing, C is a clean follow-up.

# Research: `cockpit merge` head-branch deletion

**Issue**: [generacy-ai/generacy#859](https://github.com/generacy-ai/generacy/issues/859)

## Decisions

### D1: Delete mechanism — explicit `gh api -X DELETE` after merge (Q1→B)

**Chosen**: Two-step. `mergePullRequest` continues to pass `--delete-branch=false`; a new `deleteHeadRef` primitive runs `gh api -X DELETE repos/{owner}/{name}/git/refs/heads/{headRef}` after merge confirmation.

**Alternatives considered**:
- **A: `gh pr merge --delete-branch`** — single call, but folds all outcomes into gh's opaque success. On a repo with `delete_branch_on_merge` on, the delete happens twice (or not at all), and the caller can't tell. Silently succeeds on the "already deleted" case, which makes FR-003's distinguishable stdout impossible.
- **C: hybrid — ref delete when a subtle test permits, `--delete-branch` otherwise** — combinatorial explosion; two code paths to maintain.

**Rationale**: FR-003 (already-deleted), FR-004 (cross-fork skip), and FR-005 (delete-failed with reason) all require distinguishable outcomes at the caller. Only explicit DELETE gives distinct HTTP status codes (200 / 422 / 404 / 403 / 5xx). One extra ~200ms API call on the merge path is negligible compared to the merge itself (multi-second).

**Sources**:
- `packages/cockpit/src/gh/wrapper.ts:855-858` — precedent for wrapper method returning discriminated-union outcome instead of throwing on expected non-happy paths (`getRequiredCheckNames` returns `source: 'fallback-pr-checks'` on 403/404).
- GitHub REST API: `DELETE /repos/{owner}/{repo}/git/refs/{ref}` returns 422 with message `"Reference does not exist"` when the ref is absent (verified 2026-07 against a live repo).

### D2: Cross-fork detection — deterministic field on `PullRequestDetail` (Q2→A)

**Chosen**: Extend `PullRequestDetail` with `headRepositoryOwner: string | null` sourced from `headRepositoryOwner.login` in the `gh pr view --json` response. Caller compares against `issueRef.owner` (the base owner) — one-line field comparison.

**Alternatives considered**:
- **B: attempt delete unconditionally + pattern-match stderr for permission keywords** — the #855-class fragility this epic keeps rejecting. gh error message wording is not a stable API contract.
- **C: both** — a "safety net" that's a euphemism for the same fragility as B.

**Rationale**: FR-004 wants a deterministic skip. GitHub's PR object exposes `headRepositoryOwner.login` reliably (or `null` when the head fork was deleted). Comparing `pr.headRepositoryOwner !== issueRef.owner` is a total decision function. A residual permission-shape error after this pre-check passes (e.g. head fork was transferred to the base org but the token still lacks push perms) lands correctly in FR-005's `delete-failed` classification with the raw gh stderr on stdout — the operator sees the exact reason.

**`null` semantics**: The `headRepositoryOwner` field can be `null` when the head fork has been deleted after the PR was opened. In that case the caller cannot deterministically classify as cross-fork; it attempts the delete, and any resulting error surfaces as `delete-failed`. This is the correct behavior — we do NOT silently skip on ambiguity.

**Sources**:
- `packages/cockpit/src/gh/wrapper.ts:186-210` — `PullRequestDetailRawSchema` shape; extension pattern already used for other nullable/optional fields.
- GitHub REST API: `pull_request.head.repo.owner.login` field documented as nullable when the head repo is deleted.

### D3: Split — wrapper primitives, caller orchestrates (Q3→C-slimmed)

**Chosen**: Wrapper gains exactly two primitives — `PullRequestDetail.headRepositoryOwner` (data) and `deleteHeadRef` (side-effect). `runMerge` orchestrates: reads the field, does the cross-fork comparison, calls `deleteHeadRef`, classifies the outcome, composes the stdout suffix.

**Alternatives considered**:
- **A: everything inside `mergePullRequest`** — extend `MergeResult` with `branchDeletion` field; wrapper carries fork-detection and outcome classification. Pushes policy into plumbing.
- **B: wrapper unchanged; caller re-implements everything** — leaves `mergePullRequest`'s `--delete-branch=false` intact but forces every caller of "merge with delete" to re-implement fork detection and outcome classification.
- **C-full: wrapper exposes `isCrossForkPr(detail)` helper too** — the pre-check is a one-line field comparison; wrapping it in a helper adds test surface without adding clarity.

**Rationale**: The cockpit's decision-tree pattern deliberately keeps the wrapper thin. Outcome classification is policy (which stdout string to emit), not plumbing (how to call gh). Policy belongs where the rest of the decision tree lives — `runMerge`. The `isCrossForkPr` helper drop is the "no premature abstraction" pass: one comparison, one call site (for now), no helper.

**Sources**:
- `packages/generacy/src/cli/commands/cockpit/merge.ts:137-183` — existing decision-tree pattern (classification lives in the caller, wrapper primitives are thin).
- CLAUDE.md norm: "Three similar lines is better than a premature abstraction."

### D4: Canonical stdout for the four deterministic variants (Q4→C)

**Chosen**: Byte-exact strings for the four deterministic outcomes; canonical PREFIX for the delete-failed variant with wrapped gh stderr free-form.

**Strings** (byte-exact — `\n` terminated):
- `merged and branch deleted\n`
- `merged (branch was already deleted)\n`
- `merged (branch delete skipped: cross-fork PR)\n`
- `merged (branch delete failed: <stderr>)\n`

**Alternatives considered**:
- **A: all four canonical, delete-failed also byte-exact** — impossible; the stderr content varies.
- **B: flexible — implementer picks phrasing, tests assert on substrings** — invites the wording drift that #857 byte-exactness precedent exists to prevent.

**Rationale**: Tests assert byte-exact for the three deterministic strings (SC-101/SC-102/SC-103) and prefix-plus-substring for the delete-failed line (SC-104). Downstream scrapers (if any) can grep for the fixed prefixes. #857's `no checks configured and none required — proceeding on completed:validate\n` set the precedent for canonical merge-side stdout.

**Encoding**: All ASCII. No em-dashes or non-ASCII characters in the four deletion strings (avoids the U+2014 fixture-hex-dump concern that #857 had to address).

### D5: No `--keep-branch` opt-out flag (Q5→C)

**Chosen**: Ship without a flag. Deletion is unconditional on merge success (subject to the cross-fork skip).

**Alternatives considered**:
- **A: no flag now, `gh pr merge` for the old behavior** — same as chosen; A and C differ only in phrasing.
- **B: `--keep-branch` from day one** — adds an option with no requesting consumer.

**Rationale**: GitHub's "Restore branch" button makes unwanted deletion a one-click recovery. A flag with no requester is dead surface. If a workflow surfaces (follow-up review on the merged head), add `--keep-branch` then, with the requester attached.

### D6: `runMerge` deletion runs on BOTH success branches

**Decision**: The post-merge deletion helper is invoked identically from the vacuous-green branch (finding #22 / #857) AND the classify-passing branch. Two call sites, one helper.

**Rationale**: Both branches call `gh.mergePullRequest(...)` and reach exit code 0. The deletion policy is identical. Skipping on vacuous-green would leave finding #24's residual-branch symptom on precisely the CI-less unprotected repos that #857 unblocked — the two fixes must compose.

### D7: Exit code stays 0 on `delete-failed`

**Decision**: `delete-failed` emits a visible stdout suffix + `logger.warn`, but exit code stays 0. The merge itself succeeded.

**Rationale**: Spec's "Handle gracefully" clause explicitly permits this. Deletion is a hygiene step, not a merge invariant. Downstream consumers of `cockpit merge`'s exit code (CI pipelines, cockpit's own merge verb wrapper) treat exit 0 as "merged; check stdout for outcome details" — consistent with the vacuous-green precedent's stdout note.

## Implementation patterns

### Following #855's structured-error precedent

`getPullRequestCheckRuns` (post-#855) emits `logger.warn({ repo, prNumber, ghStderr }, 'gh pr checks failed')` before throwing. `deleteHeadRef` mirrors the pattern for the `delete-failed` outcome — but returns instead of throwing, because outcome semantics are what the caller wants (per D3 rationale).

### Following #857's stdout-suffix pattern

The vacuous-green fix (#857) added `no checks configured and none required — proceeding on completed:validate\n` as a canonical stdout string, greppable and byte-exact. #859's four deletion strings adopt the same pattern — canonical, `\n`-terminated, byte-exact for the deterministic variants.

### Following the "thin wrapper" precedent

`getRequiredCheckNames` returns `{ source, names }` — data-only, no policy. `mergePullRequest` returns `{ merged, commitSha? }` — data-only, no policy. `deleteHeadRef` follows the same pattern: returns `{ outcome, stderr? }` — data-only. All policy (which stdout string) lives in `runMerge`.

## Sources / references

- **Spec**: `specs/859-found-during-cockpit-v1/spec.md`
- **Clarifications**: `specs/859-found-during-cockpit-v1/clarifications.md`
- **Precedent (structured errors)**: `packages/cockpit/src/gh/wrapper.ts` (#855 fix at `getPullRequestCheckRuns`)
- **Precedent (canonical stdout note)**: `packages/generacy/src/cli/commands/cockpit/merge.ts:154-159` (#857 vacuous-green note)
- **Precedent (thin wrapper primitive)**: `packages/cockpit/src/gh/wrapper.ts:841-883` (`getRequiredCheckNames`)
- **GitHub API**: `DELETE /repos/{owner}/{repo}/git/refs/{ref}` — 422 on missing ref, 200 on success, 403/404 on permission/lookup failure.
- **Live repro**: christrudelpw/sniplink PR #16 (first cockpit v1 successful squash-merge, finding #24 of generacy-ai/tetrad-development#88).

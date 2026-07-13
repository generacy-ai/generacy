# Research: cockpit merge + review-context (G1.3)

## R1. Engine API extension vs. CLI shell-outs

**Decision**: Extend `GhCliWrapper` with `resolveIssueToPR`, `getPullRequest`, `mergePullRequest`, and `getRequiredCheckNames`.

**Why**:

- SC-005 enforces "0 direct `gh` calls outside the engine layer." A grep for `\bgh\s+` across the new files must return empty hits.
- `GhCliWrapper` already takes an injected `CommandRunner` (see `packages/cockpit/src/gh/command-runner.ts`), so unit-test mocking is free.
- `cockpit watch` (#787, G1.1) needs the same `resolveIssueToPR` / `getPullRequest`; defining them in the engine means one tested implementation, not two.

**Alternatives considered**:

- *Shell out from the verb directly.* Rejected — fails SC-005 and duplicates logic across this PR and #787.
- *Hybrid (resolve via engine, merge via shell-out).* Rejected — every direct `gh` call outside the engine is a maintenance hazard; making merging the *only* engine-mediated mutation would be more surprising than a clean uniform rule.

## R2. Issue → PR resolution strategy

**Decision**: Use `gh pr list --search "linked:<issue>" --state open --json number,url,state,headRefName --limit 1` against the target repo. If empty, fall back to `gh issue view <issue> --json closedByPullRequestsReferences --jq '.closedByPullRequestsReferences[0]'` (covers issues closed by a now-merged PR). Surface as `resolveIssueToPR` returning `PullRequestRef | null`.

**Why**:

- GitHub's "closed by" relationship covers the common case (PR contains "Closes #N").
- For multi-issue PRs (out of scope per spec assumption), the first match is deterministic.
- Returning `null` rather than throwing lets the verb produce `reason: "unresolved"` instead of an uncaught error.

**Alternatives considered**:

- *Pure body-text scraping for `#N` references.* Rejected — fragile against `Fixes #N (eventually)` and similar phrasings.
- *Timeline events API.* Rejected — slower and overkill for the single-PR happy path.

## R3. Required-check set discovery

**Decision**: `gh api repos/{owner}/{repo}/branches/develop/protection` → read `required_status_checks.contexts[]`. On 403 (token lacks `Administration: read`), return `{ source: 'fallback-pr-checks', names: null }` and let the caller treat every PR check as required (with a stderr warning).

**Why** (per Q3):

- Branch protection is the authoritative source of truth — relying on whatever the PR happens to have leaves a gap for forgotten / removed required checks.
- 403 is a routine condition on tight-scoped tokens and must not block normal merge usage; the fallback degrades safely (still red on failing checks; just can't detect *missing* required ones).

**API path note**: `GET /repos/{owner}/{repo}/branches/{branch}/protection` returns 404 when no protection is configured at all. This is treated identically to 403 (fallback + warn) because both mean "we can't enumerate required checks."

**Alternatives considered**:

- *Configurable list under `.generacy/cockpit.yaml`.* Deferred (could be added in a later issue without breaking changes); not needed for v1.
- *Trust whatever GitHub's `pr checks` returns.* This is the fallback, not the primary — see Q3.

## R4. Pending-check behavior

**Decision**: Fail-fast. Any check whose normalized state is `PENDING` (which already collapses `PENDING` / `IN_PROGRESS` / `QUEUED` per `normalizeCheckState` in `wrapper.ts`) → exit red immediately with the failing-check JSON.

**Why** (per Q4):

- Re-trying the merge once green is `cockpit watch`'s job (#787). Two separate verbs each with their own polling logic would duplicate work and produce conflicting backoff behavior.
- Fail-fast keeps `cockpit merge` cheap to invoke; the caller decides whether to retry.

## R5. Failing-check JSON shape (Q2)

**Decision**: `{ status: "red", reason: "checks-failing" | "missing-label" | "unresolved", pr: { number, url } | null, failingChecks: [{ name, state, url? }] }`. `pr` is `null` only when `reason === "unresolved"` and even the PR ref couldn't be obtained.

**Why**:

- The `reason` discriminator routes the consumer (`/cockpit:merge` skill) to the right next action: fixer subagent (`checks-failing`), human notification (`missing-label`), or fail-loud error (`unresolved`).
- Including `pr.number` + `pr.url` on the red path means automation can deep-link without re-running issue→PR resolution.
- `failingChecks` is always an array — empty for `missing-label` / `unresolved`, populated for `checks-failing`. Uniform shape eases JSON-schema validation.

## R6. `review-context` shape (Q5)

**Decision**: `{ pr: { number, title, url, base, head, body, author, state, draft }, diff: "<unified diff text>", checks: [{ name, state, conclusion?, url? }] }`.

**Why**:

- The `/code-review` skill currently consumes a unified diff blob (not a per-file structured array), so option A matches the existing consumer contract.
- `reviewComments` and `commits` are deferred — they can be added later as optional fields without breaking the shape.

**Diff cap**: 256 KiB. Truncation marker is appended verbatim so consumers can detect it via substring match.

## R7. Merge strategy

**Decision**: Squash-only. Implemented as `gh pr merge <pr> --repo <repo> --squash --delete-branch=false`.

**Why**:

- Spec says squash. `--delete-branch=false` keeps deletion behavior a repo-policy decision (some Generacy repos have "automatically delete head branches" enabled, others don't).
- No `--auto`: that would queue the merge and `gh` would return 0 even if the merge later fails on red checks. We've already verified green before calling, so a direct merge is correct.

## R8. Test pattern

**Decision**: Reuse the `stubRunner` pattern from `packages/cockpit/src/__tests__/gh-wrapper.test.ts` for engine-method tests. For verb tests, inject a fake `GhWrapper` directly into the verb's exported handler — the verb's `action()` thin-wraps the handler so unit tests bypass Commander.

**Why**:

- The repo's existing test conventions already follow this pattern (see `gh-wrapper.test.ts`). Adopting it keeps test review fast.
- Direct-handler injection avoids spinning up Commander in tests; SC-001 / SC-002 / SC-004 are properties of the handler, not of the CLI wiring.

## R9. Logging discipline

**Decision**: All logger output (Pino) goes to **stderr** (default). Stdout is reserved for the JSON payload (red path on `merge`, always on `review-context`). On the green `merge` path, stdout is empty.

**Why**:

- Downstream automation pipes stdout into `jq` or similar. Mixing log output with JSON breaks parsing.
- Matches the convention used by `packages/generacy/src/cli/commands/app-config/show.ts`, which already separates JSON payload (stdout) from progress logging (stderr).

## Key Sources

- `packages/cockpit/src/gh/wrapper.ts` — engine layer (shipped in #786 / G0.1).
- `packages/cockpit/src/__tests__/gh-wrapper.test.ts` — `stubRunner` pattern.
- `packages/workflow-engine/src/actions/github/label-definitions.ts` — `WORKFLOW_LABELS` source of truth for `completed:validate`.
- `packages/generacy/src/cli/commands/app-config/show.ts` — JSON-on-stdout, logs-on-stderr precedent.
- GitHub REST: `GET /repos/{owner}/{repo}/branches/{branch}/protection` for required checks (Q3).
- `gh pr merge --squash` (gh CLI 2.x) for the merge primitive.
- `gh pr diff <number>` for raw unified diff text (Q5).

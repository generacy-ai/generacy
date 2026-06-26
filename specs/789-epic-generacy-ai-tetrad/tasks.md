# Tasks: cockpit merge + review-context (G1.3)

**Input**: Design documents from `/specs/789-epic-generacy-ai-tetrad/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = merge, US2 = review-context)

## Phase 1: Engine Foundation (`packages/cockpit/src/gh/wrapper.ts`)

Extend `GhCliWrapper` / `GhWrapper` with the four methods both verbs depend on. All Phase 1 tasks touch the same file (`wrapper.ts`) and the same test file (`gh-wrapper.test.ts`), so they are **sequential** within this phase.

- [X] T001 Add types `PullRequestRef`, `PullRequestDetail`, `MergeResult`, `RequiredChecksResult` and the four new `GhWrapper` interface signatures (`resolveIssueToPR`, `getPullRequest`, `mergePullRequest`, `getRequiredCheckNames`) to `packages/cockpit/src/gh/wrapper.ts`. Use Zod parsers consistent with the existing raw-→schema-→typed pattern. Export the new types from the cockpit package barrel.

- [X] T002 [US1][US2] Implement `GhCliWrapper.resolveIssueToPR(repo, issue)` in `packages/cockpit/src/gh/wrapper.ts`: try `gh pr list --search "linked:<issue>" --state open --json number,url,state,headRefName --limit 1`; fall back to `gh issue view <issue> --json closedByPullRequestsReferences --jq '.closedByPullRequestsReferences[0]'`. Normalize `state` to upper-case. Return `null` (not throw) when no PR is found. Add stub-runner tests in `packages/cockpit/src/__tests__/gh-wrapper.test.ts` covering: found-via-search, found-via-fallback, none-found → `null`.

- [X] T003 [US1][US2] Implement `GhCliWrapper.getPullRequest(repo, prNumber)` in `packages/cockpit/src/gh/wrapper.ts`: call `gh pr view <n> --repo <repo> --json number,title,url,baseRefName,headRefName,body,author,state,isDraft,labels` for metadata, then `gh pr diff <n> --repo <repo>` for the unified-diff text. Apply the 256 KiB cap **at the engine boundary** with the trailing truncation marker, and set `diffTruncated` accordingly. Add stub-runner tests in `gh-wrapper.test.ts` covering: full metadata round-trip, sub-cap diff, over-cap diff (`diffTruncated: true`, marker present, exact byte length ≤ cap + marker).

- [X] T004 [US1] Implement `GhCliWrapper.mergePullRequest(repo, prNumber, { squash: true })` in `packages/cockpit/src/gh/wrapper.ts`: call `gh pr merge <n> --repo <repo> --squash --delete-branch=false`; on success, follow up with `gh pr view <n> --json mergeCommit` to populate `commitSha`. Throw on non-zero `gh` exit (no soft-failure semantics). Add stub-runner tests covering: success path (returns `{ merged: true, commitSha }`), non-zero exit → throws.

- [X] T005 [US1] Implement `GhCliWrapper.getRequiredCheckNames(repo, branch)` in `packages/cockpit/src/gh/wrapper.ts`: call `gh api repos/{owner}/{repo}/branches/{branch}/protection`, read `required_status_checks.contexts[]`, return `{ source: 'branch-protection', names }`. On HTTP 403 or 404, return `{ source: 'fallback-pr-checks', names: null }` (no throw). Add stub-runner tests covering: 200 success, 403 fallback, 404 fallback, other error → throws.

## Phase 2: Shared CLI Utilities (`packages/generacy/src/cli/commands/cockpit/shared/`)

These four shared modules are independent of one another (each owns its own file) but all depend on Phase 1. **All four can run in parallel.**

- [X] T006 [P] [US1][US2] Create `packages/generacy/src/cli/commands/cockpit/shared/resolve-context.ts`. Export `resolveContext({ issue, repo? })` → `{ repo, issue, gh }`: infer `repo` from cwd via the existing `cluster-context.ts` pattern when absent; construct a `GhCliWrapper` with the default `CommandRunner`. No tests required (pure wiring; covered by verb tests).

- [X] T007 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/shared/required-checks.ts`. Export `classifyChecks({ required, actual })` returning `{ failingChecks: FailingCheck[]; ok: boolean }`. Inputs: `RequiredChecksResult` and `CheckRunSummary[]`. Behavior: when `required.source === 'branch-protection'`, any required name not present in `actual` becomes `{ name, state: 'MISSING' }`; any non-`SUCCESS` actual check (including `PENDING`) becomes a `FailingCheck` carrying its normalized `state` and `url`. When `required.source === 'fallback-pr-checks'`, treat every actual check as required (no `MISSING` synthesis). Add `packages/generacy/src/cli/commands/cockpit/__tests__/required-checks.test.ts` covering: all-green branch-protection, missing required → `MISSING`, pending actual → `PENDING`, fallback mode all-green, fallback mode failure.

- [X] T008 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/shared/failing-check-json.ts`. Export `FailingCheckPayload`, `RedReason`, `FailingCheck` types (per data-model § 2), plus `serializeFailingCheckJson(payload)` (`JSON.stringify` + final `\n`) and `buildFailingCheckPayload({ reason, pr, failingChecks? })` that enforces the schema invariants (`unresolved` allows `pr: null`, empty `failingChecks`; `missing-label` requires non-null `pr`, empty `failingChecks`; `checks-failing` requires non-null `pr` AND non-empty `failingChecks`). Throw at build time on invariant violation (defensive — never reaches stdout in a malformed state). Add `packages/generacy/src/cli/commands/cockpit/__tests__/failing-check-json.test.ts` covering each `reason` and the schema-validation pass against `contracts/failing-check.schema.json` (use Ajv against the contract file).

- [X] T009 [P] [US2] Create `packages/generacy/src/cli/commands/cockpit/shared/review-context-json.ts`. Export `ReviewContextPayload` type (per data-model § 2) and `buildReviewContextPayload({ pr, checks })` that maps `PullRequestDetail` + `CheckRunSummary[]` into the on-wire shape (compresses `author.login` → string-or-null, propagates `diffTruncated`). Export `DIFF_BYTE_CAP = 256 * 1024` as a constant. Schema-validation test against `contracts/review-context.schema.json` lives with the verb test (T012) — no separate unit-test file required.

## Phase 3: CLI Verbs (`packages/generacy/src/cli/commands/cockpit/`)

The cockpit command group and the two verbs depend on Phase 2. The two verbs are in different files and can run in parallel; both must complete before the registration task T013.

- [X] T010 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/merge.ts`. Export `cockpitMergeCommand()` (Commander) and `runMerge({ gh, issue, repo, logger })` (the directly-testable handler). Gate order — **short-circuit on first failure**:
  1. `resolveIssueToPR` → if `null` OR PR `state !== 'OPEN'`: emit red `reason: 'unresolved'` and exit `1`.
  2. `getPullRequest` → if `labels` does not include `WORKFLOW_LABELS.completed.validate`: emit red `reason: 'missing-label'` and exit `1`.
  3. `getRequiredCheckNames` + `getPullRequestCheckRuns` → `classifyChecks`. If `required.source === 'fallback-pr-checks'`, log a `warn` to stderr (Q3 mandated message: "required-check set derived from PR check list; token cannot read branch protection"). If `failingChecks.length > 0`: emit red `reason: 'checks-failing'` and exit `1`.
  4. Otherwise: call `mergePullRequest(repo, pr, { squash: true })`; on success exit `0` with empty stdout. Stderr-only logging via Pino. No `--force` flag.

- [X] T011 [P] [US2] Create `packages/generacy/src/cli/commands/cockpit/review-context.ts`. Export `cockpitReviewContextCommand()` (Commander) and `runReviewContext({ gh, issue, repo, logger })`. Flow:
  1. `resolveIssueToPR` → if `null`: log error to stderr and exit non-zero (per FR-010, never emit empty stdout silently).
  2. `getPullRequest(repo, ref.number)` and `getPullRequestCheckRuns(repo, ref.number)` in parallel.
  3. `buildReviewContextPayload(...)` and write `JSON.stringify(payload) + '\n'` to stdout. Exit `0` even when checks are red.

- [X] T012 [US1][US2] Create the two verb test files:
  - `packages/generacy/src/cli/commands/cockpit/__tests__/merge.test.ts` — inject a fake `GhWrapper` directly into `runMerge`. Cover SC-001 (green + `completed:validate` → `mergePullRequest` called, exit 0), SC-002 (failing/pending/missing check / missing label / unresolved → `mergePullRequest` NOT called, exit non-zero), SC-003 (red stdout parses + validates against the failing-check schema for each reason; missing-label and unresolved emit empty `failingChecks`; checks-failing populates them; `MISSING` synthesis path).
  - `packages/generacy/src/cli/commands/cockpit/__tests__/review-context.test.ts` — fake `GhWrapper`. Cover SC-004 (PR metadata + diff + checks all present, exit 0 even with red checks, schema-validate stdout against `contracts/review-context.schema.json`), FR-010 (unresolved → stderr error + non-zero exit, no JSON on stdout), `diffTruncated: true` propagation.

- [X] T013 [US1][US2] Create `packages/generacy/src/cli/commands/cockpit/index.ts`. Export `cockpitCommand()` Commander group registering both `merge` and `review-context` subcommands. Register it in `packages/generacy/src/cli/index.ts` via `program.addCommand(cockpitCommand())`. Confirm SC-005 by greppping new files: `rg -n '\\bgh\\s+' packages/generacy/src/cli/commands/cockpit/` must return zero hits (only the engine touches `gh`).

## Phase 4: Polish

- [X] T014 [US1][US2] Run `pnpm --filter @generacy-ai/cockpit build`, `pnpm --filter @generacy-ai/generacy build`, `pnpm --filter @generacy-ai/cockpit test`, `pnpm --filter @generacy-ai/generacy test`. Fix any regressions. Confirm SC-005 grep returns empty.

- [ ] T015 [US1][US2] Execute the manual smoke check from `quickstart.md` against a sandbox PR: drive a PR to `completed:validate` + green, run `generacy cockpit merge <issue>` (verify exit 0 + PR merged + empty stdout), then `generacy cockpit review-context <issue>` (verify schema-valid stdout, exit 0). Document the run in the PR description.

## Dependencies & Execution Order

```
Phase 1 (engine, sequential — same file)
   T001 → T002 → T003 → T004 → T005
                                   ↓
Phase 2 (shared utils, parallel)
   T006 [P]   T007 [P]   T008 [P]   T009 [P]
                                                 ↓
Phase 3 (verbs)
   T010 [P]   T011 [P]
        ↓        ↓
        T012  ← (both verb tests)
           ↓
        T013  ← (registration / wiring; SC-005 check)
                                                  ↓
Phase 4 (polish, sequential)
   T014 → T015
```

**Parallel opportunities**:

- T006, T007, T008, T009 (Phase 2): all touch different files; can run concurrently.
- T010, T011 (Phase 3): different verb files; can run concurrently.

**Critical dependencies**:

- T002–T005 must precede any Phase 2 / Phase 3 work — the verbs depend on the engine API surface.
- T012 must wait for T010 + T011 (it tests them via fake-`GhWrapper` injection).
- T013 must wait for T010 + T011 (it registers them).

**Coordination with #787 (G1.1, `cockpit watch`)**: `resolveIssueToPR`, `getPullRequest`, and `RequiredChecksResult` defined in Phase 1 are also consumed by #787. If #787 lands first, T002 / T003 / T005 become "verify the existing methods cover this issue's requirements" rather than fresh implementations.

# Implementation Plan: cockpit merge + review-context (G1.3)

**Feature**: Epic: generacy-ai/tetrad-development#85 | Phase: P1 | Tier: v1-core | Issue: G1.3
**Branch**: `789-epic-generacy-ai-tetrad`
**Status**: Complete

## Summary

Two new CLI verbs under `packages/generacy/src/cli/commands/cockpit/`:

- `generacy cockpit merge <issue>` — squash-merges the PR for `<issue>` into `develop` **iff** the PR carries `completed:validate` and every required check is green. On any red condition (failing/pending/missing checks, missing label, unresolved issue→PR), exits non-zero and emits the failing-check JSON (Q2 shape) to stdout. No `--force` override.
- `generacy cockpit review-context <issue>` — emits a single JSON object to stdout containing PR metadata, full unified diff (capped), and check results — the canonical input the review skill consumes.

To stay inside SC-005 ("no `gh` shell-outs outside the engine layer"), this PR extends the existing `GhCliWrapper` (`packages/cockpit/src/gh/wrapper.ts`, shipped in #786 / G0.1) with three new methods — `resolveIssueToPR`, `getPullRequest`, `mergePullRequest` — and reuses the existing `getPullRequestCheckRuns`. The `resolveIssueToPR` and `getPullRequest` additions are coordinated with #787 (G1.1, `cockpit watch`), which also needs them — defined once here, consumed there.

## Technical Context

- **Language / runtime**: TypeScript, Node.js ≥ 22, ESM.
- **CLI framework**: Commander.js (matches every other verb under `packages/generacy/src/cli/commands/`).
- **Engine package**: `@generacy-ai/cockpit` (in-repo, `packages/cockpit/`). Already exports `GhCliWrapper`, `GhWrapper`, `CommandRunner`, `WORKFLOW_LABELS` (re-exported via consumers). New methods land on `GhCliWrapper` / `GhWrapper`.
- **Test runner**: Vitest. Engine tests use the stubbed `CommandRunner` pattern from `packages/cockpit/src/__tests__/gh-wrapper.test.ts`. CLI verb tests inject a fake `GhWrapper` directly.
- **Validation**: Zod, in line with the rest of `gh/wrapper.ts` (raw → schema → typed surface).
- **Workflow label constant**: `completed:validate` is read from `WORKFLOW_LABELS` (`@generacy-ai/workflow-engine`'s `actions/github/label-definitions.ts`), not hardcoded in the verb (FR-003).
- **Logging**: `getLogger()` from `packages/generacy/src/cli/utils/logger.ts` (Pino). Stdout is reserved for the JSON payload; everything else goes to stderr/logger.
- **No new runtime dependencies**.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  packages/generacy/src/cli/                                      │
│                                                                  │
│   index.ts                                                       │
│     └─ program.addCommand(cockpitCommand())                      │
│                                                                  │
│   commands/cockpit/                                              │
│     ├─ index.ts                     ← command group: 'cockpit'   │
│     ├─ merge.ts                     ← FR-001..007 — never merges │
│     │                                  on red, JSON payload      │
│     ├─ review-context.ts            ← FR-008..010 — PR+diff+chk  │
│     ├─ shared/                                                   │
│     │   ├─ resolve-context.ts       ← cwd → repo, gh wrapper     │
│     │   ├─ required-checks.ts       ← Q3: branch-protection +   │
│     │   │                              403 fallback              │
│     │   ├─ failing-check-json.ts    ← Q2 schema + serializer     │
│     │   └─ review-context-json.ts   ← Q5 schema + serializer     │
│     └─ __tests__/                                                │
│         ├─ merge.test.ts            ← SC-001/002/003 unit cov.   │
│         ├─ review-context.test.ts   ← SC-004                     │
│         ├─ required-checks.test.ts                               │
│         └─ failing-check-json.test.ts                            │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  packages/cockpit/src/gh/wrapper.ts (extended in this PR)        │
│                                                                  │
│    GhWrapper                                                     │
│      + resolveIssueToPR(repo, issue): Promise<PullRequestRef|null>│
│      + getPullRequest(repo, pr): Promise<PullRequestDetail>      │
│      + mergePullRequest(repo, pr, {squash}): Promise<MergeResult>│
│      + getRequiredCheckNames(repo, branch):                      │
│            Promise<RequiredChecksResult>  ← Q3 (403 fallback)    │
│                                                                  │
│    All existing methods unchanged. Coordinated with #787.        │
└──────────────────────────────────────────────────────────────────┘
```

### Why "extend the engine" (Q1 option A) over "shell out from the verb"

SC-005 requires zero direct `gh` shell-outs outside the engine layer. The existing engine already injects `CommandRunner` for testability; adding methods there keeps the same shape and lets both `merge` / `review-context` and `watch` (#787) share one tested code path. The alternative — shelling out from the verb — would create two copies of PR-resolution and diff-fetching logic and fail SC-005's grep check.

### Red path

The red path is a discriminated union on `reason`:

| `reason`           | When                                                                | Exit |
|--------------------|---------------------------------------------------------------------|------|
| `"unresolved"`     | `resolveIssueToPR` returns `null`, or PR is in a non-mergeable state (closed, already merged). | non-zero |
| `"missing-label"`  | PR is open but does not carry `completed:validate`.                | non-zero |
| `"checks-failing"` | One or more required checks are missing / pending / failing.        | non-zero |

The `merge` verb runs these three gates in **exactly that order** and emits the first that fails — short-circuit semantics, no further work is done. The JSON shape (Q2) is uniform across all three so downstream automation parses one shape.

### Required-check resolution (Q3)

`getRequiredCheckNames(repo, 'develop')` calls `gh api repos/{owner}/{repo}/branches/develop/protection` and returns:

- `{ source: 'branch-protection', names: string[] }` on success.
- `{ source: 'fallback-pr-checks', names: null }` on 403 (token lacks `Administration: read` on the repo). The verb then treats every check present on the PR as required, and emits a `warn`-level log message ("required-check set derived from PR check list; token cannot read branch protection") to stderr.

"Missing" = required name not present in the PR's check-run list. Missing required checks are emitted in `failingChecks` with `state: "PENDING"` and a synthetic `name`. Pending / in-progress / queued real checks are also red (Q4).

### `review-context` diff cap

Diff text is fetched via `gh pr view --json files`+`gh pr diff <n>` (in `getPullRequest`). The text blob is capped at **256 KiB** by default; over-cap diffs are truncated with a trailing `\n... [diff truncated at 256 KiB] ...\n` marker. No flag in this scope — value is a constant in `review-context-json.ts`.

### `merge` is non-interactive

No prompts, no spinners, no progress output on stdout. Stdout is **exclusively** the failing-check JSON (red path) or empty (green path, the merge commit is the side effect). This matches what `/cockpit:merge` (the skill consumer) expects.

## Project Structure

```
packages/cockpit/
├── src/
│   ├── gh/
│   │   └── wrapper.ts                ← extend with 4 methods
│   └── __tests__/
│       └── gh-wrapper.test.ts        ← add cases for new methods
│
packages/generacy/
├── src/cli/
│   ├── index.ts                       ← register cockpitCommand()
│   └── commands/cockpit/              ← NEW DIRECTORY
│       ├── index.ts                   ← command group
│       ├── merge.ts                   ← FR-001..007
│       ├── review-context.ts          ← FR-008..010
│       ├── shared/
│       │   ├── resolve-context.ts
│       │   ├── required-checks.ts
│       │   ├── failing-check-json.ts
│       │   └── review-context-json.ts
│       └── __tests__/
│           ├── merge.test.ts
│           ├── review-context.test.ts
│           ├── required-checks.test.ts
│           └── failing-check-json.test.ts

specs/789-epic-generacy-ai-tetrad/
├── spec.md                            ← unchanged (read-only)
├── clarifications.md                  ← Batch 1 complete
├── plan.md                            ← this file
├── research.md
├── data-model.md
├── quickstart.md
└── contracts/
    ├── failing-check.schema.json
    └── review-context.schema.json
```

## Constitution Check

No `.specify/memory/constitution.md` is present in this repo, so no project-level governance rules apply at this layer. Repo-level constraints honored:

- **CLAUDE.md "no comments" rule**: implementation will avoid commentary; the only docstring-like text will be CLI `--description` strings.
- **CLAUDE.md "no backwards-compat hacks"**: no feature flag for the new verbs; cockpit command group is registered unconditionally because `@generacy-ai/cockpit` is a workspace dep.
- **CLAUDE.md "tests only verify code correctness"**: SC-001 ("end-to-end squash-merge") is not provable from unit tests; it is verified by the in-PR validation against a fixture PR on a test repo and recorded in the quickstart (manual smoke check).
- **Isolation (spec line 12)**: the only file touched outside `packages/generacy/src/cli/commands/cockpit/` is `packages/cockpit/src/gh/wrapper.ts` (engine API surface, explicitly permitted by Q1) and `packages/generacy/src/cli/index.ts` (mandatory wiring).

## Key Design Decisions (Cross-Reference to Clarifications)

| Decision                                     | Source | Where Applied                                    |
|----------------------------------------------|--------|--------------------------------------------------|
| Extend `GhCliWrapper` in cockpit engine      | Q1 / A | `packages/cockpit/src/gh/wrapper.ts`             |
| Failing-check JSON discriminated by `reason` | Q2 / A | `contracts/failing-check.schema.json`, `shared/failing-check-json.ts` |
| Required-checks from branch protection       | Q3 / A | `shared/required-checks.ts`                      |
| 403 fallback to "all PR checks must be green"| Q3 fallback | `shared/required-checks.ts`                  |
| Fail-fast on pending checks (no polling)     | Q4 / A | `merge.ts` (single pass, no retry loop)          |
| Single JSON object for review-context        | Q5 / A | `contracts/review-context.schema.json`, `shared/review-context-json.ts` |
| 256 KiB diff cap                             | Q5 (implied "max-bytes") | `shared/review-context-json.ts` constant |

## Coordination with #787 (G1.1, `cockpit watch`)

`resolveIssueToPR` and `getPullRequest` are defined here and **must not** be redefined in #787. If #787 lands first, this PR consumes them as-is; if this PR lands first, #787 imports them unchanged. The discriminated `RequiredChecksResult` shape from `getRequiredCheckNames` is also shared — `watch` will use the same fallback semantics for its check-run roll-up.

## Risks

| Risk                                                                    | Mitigation                                                                                     |
|-------------------------------------------------------------------------|------------------------------------------------------------------------------------------------|
| Branch-protection 403 silently produces a weaker required-check set     | Explicit `warn` log line + `source: 'fallback-pr-checks'` carried through `failingChecks` so the consumer can detect it. |
| Multi-PR issues (issue closed by 2+ PRs)                                | Out of scope per spec assumption; `resolveIssueToPR` returns the first open PR and the verb proceeds. Documented in quickstart. |
| `gh pr merge --squash` succeeds but the post-merge HTTP roundtrip fails | Merge is the last step; the merge itself is the source of truth. Verb exits 0 if `gh` exit is 0; transient API errors after are non-fatal. |
| Diff cap truncates important context                                    | 256 KiB is generous for a single feature PR; reviewer can re-run with the standard `gh pr diff` for the full text. |

## Next Step

`/speckit:tasks` to generate the dependency-ordered task list.

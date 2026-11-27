# Implementation Plan: getStatus rename/copy entries break staging and silently lose phase work

**Feature**: Fix `getStatus()` porcelain parsing for rename/copy entries and surface staging/commit failures as a visible phase outcome
**Branch**: `1239-summary-getstatus-generacy-ai`
**Status**: Complete
**Issue**: [#1239](https://github.com/generacy-ai/generacy/issues/1239) | **Workflow**: `workflow:speckit-bugfix`

## Summary

Two coordinated changes:

1. **Parsing fix (FR-001–FR-004, workflow-engine)** — `GhCliGitHubClient.getStatus()`
   (`packages/workflow-engine/src/actions/github/client/gh-cli.ts:1315`) switches from
   line-splitting `git status --porcelain` to NUL-splitting
   `git status --porcelain -z --untracked-files=all`. In `-z` format a rename/copy entry
   emits the **destination** path in the entry field and the **source** path as the next
   NUL-separated field, with no quoting of special characters. The parser consumes the
   extra field whenever the index or working status letter is `R` or `C` and contributes
   **both** paths to the appropriate list, so `stageFiles` records the source deletion and
   destination addition instead of running `git add 'old -> new'` (exit 128).

2. **Error surfacing (FR-005, orchestrator)** — `PrManager.commitAndPush`
   (`packages/orchestrator/src/worker/pr-manager.ts:127`) gains a narrow try/catch around
   the `getStatus` → `stageFiles` → `commit` span only, producing a new
   `{ kind: 'commit-error' }` variant of `CommitAndPushOutcome`.
   `commitPushAndEnsurePr` short-circuits it (no `ensureDraftPr`) into a new
   `CommitResult.commitError` field, and every phase-loop site that checks
   `pushRefused` aborts identically on `commitError` — the phase fails visibly with a
   commit-error reason and the normal retry policy applies (Q1: A). Push and
   remote-query failures keep today's non-fatal log-and-`no-changes` behavior via the
   existing outer catch (Q2: A).

## Technical Context

- **Language**: TypeScript (ESM, Node >= 22)
- **Packages touched**:
  - `@generacy-ai/workflow-engine` — `src/actions/github/client/gh-cli.ts` (parser)
  - `@generacy-ai/orchestrator` — `src/worker/pr-manager.ts`, `src/worker/types.ts`,
    `src/worker/phase-loop.ts` (outcome union, `CommitResult`, abort handling)
- **Interface stability**: `GitStatus` shape is unchanged (`staged`/`unstaged`/`untracked`
  remain `string[]`); rename entries now contribute two path strings.
- **Test framework**: vitest. Mock-level tests use the `vi.mock('../../../cli-utils.js')`
  pattern; integration-style tests use real temp git repos
  (`gh-cli.revert-paths.test.ts` pattern — `mkdtempSync` + `execFileSync('git', …)`).
- **Build order**: orchestrator imports workflow-engine's built `dist/` — rebuild
  workflow-engine before typechecking/testing orchestrator.

## Design decisions

### D1 — porcelain v1 `-z`, not `--porcelain=v2`

`-z` keeps the existing two-letter `XY` prefix logic (`line[0]`/`line[1]`) intact and
changes only the tokenization: entries are NUL-terminated, a rename/copy entry is
followed by one extra NUL field (the source path), and no C-style quoting is applied to
paths (fixes FR-004 for free). `v2` would be a full rewrite of the classifier for the
same information. See research.md R1.

### D2 — parser shape

Split stdout on `\0`, drop the trailing empty token, and walk with an index:

- entry = `XY<space><path>`; `X = entry[0]`, `Y = entry[1]`, dest path = `entry.slice(3)`
- `?? path` → `untracked` (unchanged, `--untracked-files=all` preserved — FR-003/#1162)
- if `X === 'R' || X === 'C' || Y === 'R' || Y === 'C'` → consume the next token as the
  source path
- classification per FR-002:
  - `X` non-space/non-`?` → push dest to `staged`; if `X` is `R`/`C`, also push source
  - `Y` non-space/non-`?` → push dest to `unstaged`; if `Y` is `R`/`C`, also push source
- `has_changes` = entry count > 0 (entries, not raw tokens — a rename is one entry)

This covers `R ` (both paths staged), `RM` (both staged + dest unstaged), ` R`
(both unstaged), and `C*` symmetrically. Downstream, `pr-manager` dedupes via
`new Set`, filters sidecars, stages both paths, and commits with the explicit
pathspec — `git add <old> <new>` after a `git mv` correctly records the delete + add,
and `git commit -- <old> <new>` includes both sides of the rename.

### D3 — `commit-error` outcome, mirrored on the `refused` plumbing

- `CommitAndPushOutcome` gains `{ kind: 'commit-error'; message: string }`.
- Inner try/catch wraps **only** `pr-manager.ts:151-191` (status read, sidecar/agent-context
  filtering, `stageFiles`, `commit`). The agent-context revert (`revertPaths`, already
  has its own non-fatal catch), remote-branch queries, push guard, and push stay under
  the existing outer catch → still collapse to `no-changes` (Q2: A).
- `commitPushAndEnsurePr` returns early with
  `{ hasChanges: false, commitError: { message } }` — no `ensureDraftPr`, mirroring the
  `refused` short-circuit.
- `CommitResult` (`orchestrator/src/worker/types.ts:573`) gains optional
  `commitError?: { message: string }` beside `pushRefused`.
- Every `phase-loop.ts` site that checks `outcome.pushRefused` (main completion ~:1630,
  WIP/pause ~:1134 and ~:2557, partial ~:1326, retry ~:1369, remediate ~:1532 and
  ~:2365) gets a parallel `commitError` check with the same control-flow exit
  (abort, `completed: false`, no `onPhaseComplete`, no advancement) and a distinct log
  message naming the commit-error reason. Normal retry policy then applies (Q1: A).

### D4 — tests

- **SC-002 (unit)**: extend `gh-cli.get-status.test.ts` — assert the new
  `['status', '--porcelain', '-z', '--untracked-files=all']` invocation; feed simulated
  `-z` output containing `R `, `RM`, ` M`, `??`, and a path with spaces; assert real
  paths, no `->` substring, source+dest both present. Existing mocked status fixtures in
  `gh-cli.get-status.test.ts` and `tests/actions/github/unpushed-detection.test.ts`
  are updated from `\n`- to `\0`-separated stdout.
- **SC-001 (integration, Q3: B)**: new
  `gh-cli.rename-status.test.ts` beside `gh-cli.revert-paths.test.ts` — real temp repo,
  `git mv old.ts new.ts` + append (yielding `RM`), plus a plain ` M` file; run
  `getStatus()` → `stageFiles(status lists)` → `commit(…)`; assert the commit contains
  both source and destination paths and the tree is clean.
- **FR-005**: pr-manager unit tests — a throwing `stageFiles`/`commit` mock yields
  `commitError` (and no `ensureDraftPr` call); a throwing `push` mock still yields
  `hasChanges`-style `no-changes` behavior. Phase-loop test mirroring the existing
  `pushRefused` abort test (`phase-loop.manual-validation.test.ts:266` pattern).
- **SC-003 (regression)**: `pnpm --filter @generacy-ai/workflow-engine test` and
  orchestrator suite; the real-repo tests
  (`get-status-untracked-dir.integration.test.ts`, revert-paths) pass unmodified.

## Project Structure

```
packages/workflow-engine/src/actions/github/client/
├── gh-cli.ts                                  # getStatus(): -z tokenizer + rename/copy handling
└── __tests__/
    ├── gh-cli.get-status.test.ts              # updated mocks + new rename/space cases (SC-002)
    └── gh-cli.rename-status.test.ts           # NEW: temp-repo getStatus→stageFiles→commit (SC-001)

packages/workflow-engine/tests/actions/github/
└── unpushed-detection.test.ts                 # status stdout fixtures → NUL-separated

packages/orchestrator/src/worker/
├── pr-manager.ts                              # inner try/catch; commit-error variant; short-circuit
├── types.ts                                   # CommitResult.commitError
├── phase-loop.ts                              # abort on commitError at pushRefused check sites
└── __tests__/                                 # pr-manager + phase-loop commit-error tests

.changeset/1239-getstatus-rename-parsing.md    # patch: workflow-engine + orchestrator
specs/1239-summary-getstatus-generacy-ai/      # this plan + research/data-model/quickstart/stack
```

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo. Checked instead against
`CLAUDE.md` standing invariants:

- **Changeset gate**: non-test `src/` changes in two packages → one new changeset file
  listing **both** `@generacy-ai/workflow-engine` and `@generacy-ai/orchestrator` at
  `patch` (bugfix). ✅ planned
- **#1162 invariant**: `--untracked-files=all` retained; untracked classification
  unchanged. ✅
- **#1218 invariant**: staging filter semantics (`EXCLUDED_EXACT_PATHS`, sidecar filter)
  untouched — only the error envelope around the span changes. ✅
- **Build order**: rebuild workflow-engine `dist/` before orchestrator typecheck/tests. ✅
- Spec-stage phase commits never touch repo-root agent-context files. ✅

## Risks

- **Fixture churn**: any test that mocks `git status --porcelain` stdout with `\n`
  separators must move to `\0`. Known sites: `gh-cli.get-status.test.ts`,
  `unpushed-detection.test.ts`. Other `getStatus()` consumers (sibling-fanout,
  preflight, review-changes, commit-and-push action, merge-from-base) mock the
  *client*, not the subprocess, so they are unaffected.
- **Phase-loop touch points**: seven `pushRefused` sites; a missed one would let a
  commit-error silently complete a phase. Mitigated by grepping for `pushRefused` in
  the implement phase and by the phase-loop test.

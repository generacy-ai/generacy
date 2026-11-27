# Research: getStatus rename/copy parsing fix (#1239)

## R1 — Parse format: porcelain v1 `-z` vs `--porcelain=v2`

**Decision**: `git status --porcelain -z --untracked-files=all` (porcelain v1, NUL-separated).

**Rationale**:
- The existing classifier keys off the two-letter `XY` field (`line[0]`, `line[1]`,
  path at offset 3). The v1 `-z` form keeps that layout per entry and changes only the
  separator: entries end in NUL, and a rename/copy entry is followed by exactly one
  extra NUL-terminated field carrying the **source** path (the entry field itself holds
  the **destination**). Minimal diff, maximal preservation of #1162 behavior.
- `-z` disables C-style quoting entirely, so paths with spaces, quotes, or non-ASCII
  round-trip byte-exact (FR-004). Porcelain v1 text form would require a de-quoter.
- `--porcelain=v2` encodes renames as `2 XY sub mH mI mW hH hI X<score> path<sep>origPath`
  — strictly more information (scores, modes) than needed, at the cost of rewriting the
  whole parser and all mocked fixtures into an unfamiliar format.

**Alternatives considered**:
- *v2 (`--porcelain=v2 -z`)*: rejected — larger rewrite for no additional requirement
  coverage; v1 `-z` fully satisfies FR-001/FR-002/FR-004.
- *Post-hoc splitting of `old -> new` on the literal arrow*: rejected — ambiguous when a
  path itself contains ` -> `, and still subject to v1 text quoting.
- *`git diff --name-only` supplements*: rejected — a second subprocess with its own
  racing view of the tree; status must stay a single consistent snapshot.

**Verified behavior** (git 2.x, reproduced locally per spec repro):
```
git status --porcelain      → RM old.ts -> new.ts          (one text line)
git status --porcelain -z   → RM new.ts\0old.ts\0          (dest entry + source field)
```
Note the field order in `-z`: **destination first** (in the `XY ` entry), source as the
following bare field. Untracked (`??`) and ordinary entries have no extra field.

## R2 — Which status letters carry a second field

Index (`X`) or working-tree (`Y`) values `R` (rename) and `C` (copy) each imply the
extra source field. In practice:

| Entry | Meaning | Lists (per FR-002) |
|-------|---------|--------------------|
| `R  new␀old␀` | rename staged, tree clean | staged: old, new |
| `RM new␀old␀` | rename staged, dest modified | staged: old, new; unstaged: new |
| ` R new␀old␀` | rename in working tree (rare; e.g. staged delete + unstaged similar add) | unstaged: old, new |
| `C  new␀old␀` | copy staged | staged: old, new |
| ` M path␀` | ordinary modify | unstaged: path |
| `?? path␀` | untracked | untracked: path |

`C` in the working-tree column is effectively unreachable with default git config but
handled by the same branch for symmetry — the parser keys on the letter, not on which
column it appears in.

## R3 — Why both paths must be staged

After `git mv old new`, the index already holds the rename, but `pr-manager` commits
with an explicit pathspec (`git commit -m <msg> -- <paths>`, #1162). A pathspec commit
only records paths named in it: naming only `new` would commit the addition but leave
the deletion of `old` out of the commit. Staging and committing **both** `old` and
`new` records the full rename (git re-detects it as `R` at diff time). This drives
FR-002's "both source and destination" requirement and SC-001's assertion that the
commit contains both paths.

## R4 — Error-surfacing pattern: reuse the `refused` plumbing

**Decision**: new `{ kind: 'commit-error' }` variant in the internal
`CommitAndPushOutcome` union → new optional `CommitResult.commitError` field → abort
checks in `phase-loop.ts` beside every existing `pushRefused` check.

**Rationale**:
- PR #1052 already built exactly this channel for `refused` ("distinguish a
  caller-visible abort from `no-changes`"), including the invariant that the
  short-circuit happens **before** `ensureDraftPr`. Commit-error reuses the shape, so
  the phase loop's abort semantics (no `onPhaseComplete`, no advancement,
  `completed: false`, retry policy applies) come for free (clarify Q1: A).
- The inner try/catch covers only `getStatus` → filter → `stageFiles` → `commit`
  (`pr-manager.ts:151-191`). Everything after — `revertPaths` bookkeeping (already has
  its own catch), remote queries, push guard, push — remains under the outer catch and
  keeps the non-fatal log-and-`no-changes` collapse (clarify Q2: A): a failed push loses
  nothing because the local commit is found via `hasUnpushed` on the next cycle.

**Alternatives considered**:
- *Observability-only (log, keep going)*: rejected in clarify Q1 — for `implement` the
  phase still dies downstream as `no-product-code-changes` with the misleading
  "Own-commit files: []" symptom.
- *Whole-body coverage*: rejected in clarify Q2 — would turn routine transient push
  failures into phase failures.
- *Throwing from `commitAndPush`*: rejected — every call site would need its own
  try/catch; the discriminated-union pattern is the established convention here.

## R5 — Test patterns

- **Mock-level** (`gh-cli.get-status.test.ts`): `vi.mock('../../../cli-utils.js')`,
  sequence `branch → status → rev-list` mocks. Fixtures become NUL-joined strings.
- **Real-repo integration** (`gh-cli.revert-paths.test.ts`,
  `tests/actions/github/get-status-untracked-dir.integration.test.ts`): `mkdtempSync` +
  `execFileSync('git', …)` with `user.email`/`user.name`/`commit.gpgsign=false` config.
  SC-001's new test follows this exactly (clarify Q3: B) — it pins the cross-package
  contract (parser output feeding `stageFiles`/`commit`) that mock-level pr-manager
  tests cannot see.
- **Phase-loop abort** (`phase-loop.manual-validation.test.ts:266`): existing
  `pushRefused` abort test is the template for the `commitError` abort test.

## Key sources

- `git-status(1)`, "Porcelain Format Version 1": "If the file was renamed or copied,
  the entry is followed by the original path name… In the `-z` format, the status field
  is followed by the target path, a NUL, then the original path."
- #1162 (untracked-files=all invariant), #1218 (staging-filter semantics, temp-repo test
  pattern), PR #1052 (refused outcome plumbing), #1107 (product-code guard that turns
  the swallowed failure into `no-product-code-changes`).

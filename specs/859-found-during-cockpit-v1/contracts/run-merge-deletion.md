# Contract: `runMerge` post-merge deletion classifier

**Location**: `packages/generacy/src/cli/commands/cockpit/merge.ts:40-184`.

## Trigger

Runs after `gh.mergePullRequest(...)` returns successfully. Two call sites — both success branches of `runMerge`:

1. **Vacuous-green branch** (`merge.ts:153-160`, added in #857): fires when both `actualChecks[]` and required-check names are empty. Existing stdout is the vacuous-green note.
2. **Classify-passing branch** (`merge.ts:181-183`): fires when `classifyChecks` returns `ok: true`. Existing stdout is `''`.

## Classifier

```typescript
async function classifyAndDeleteBranch(ctx: {
  gh: GhWrapper;
  pr: PullRequestDetail;
  issueRef: IssueRefWithState;
  logger: Logger;
}): Promise<string>;
```

**Returns**: the canonical stdout suffix (one line, `\n`-terminated).

**Decision tree**:

```text
┌──────────────────────────────────────────────────────┐
│ pr.headRepositoryOwner != null                       │
│   && pr.headRepositoryOwner !== issueRef.owner       │
└─────────────────┬─────────────────┬──────────────────┘
                  │ true            │ false
                  ▼                 ▼
    ┌─────────────────────┐  ┌────────────────────────────┐
    │ skipped-cross-fork  │  │ gh.deleteHeadRef(repo, ref) │
    │ (info log)          │  └───────────┬────────────────┘
    └─────────────────────┘              │
                                         ▼
                              ┌─────────────────────────┐
                              │ outcome === 'deleted'   │─► 'merged and branch deleted\n'
                              │ outcome === 'already-   │─► 'merged (branch was already deleted)\n' + info log
                              │            gone'        │
                              │ outcome === 'delete-    │─► 'merged (branch delete failed: <stderr>)\n' + warn log
                              │            failed'      │
                              └─────────────────────────┘
```

## Stdout composition

**Vacuous-green branch**:
```text
'no checks configured and none required — proceeding on completed:validate\n'
  + <deletion suffix>
```
Net stdout: two lines, each `\n`-terminated. The vacuous-green note is unchanged; the suffix is appended.

**Classify-passing branch**:
```text
<deletion suffix>
```
Net stdout: one line, `\n`-terminated. Previously `''`.

## Canonical suffixes (byte-exact)

| Outcome            | Suffix                                                                 |
|--------------------|------------------------------------------------------------------------|
| `deleted`          | `merged and branch deleted\n`                                          |
| `already-gone`     | `merged (branch was already deleted)\n`                                |
| `skipped-cross-fork`| `merged (branch delete skipped: cross-fork PR)\n`                     |
| `delete-failed`    | `merged (branch delete failed: <stderr>)\n`                            |

The first three are byte-exact and asserted as such in SC-101/102/103. The fourth has a canonical prefix (`merged (branch delete failed: `) and canonical suffix (`)\n`), with the wrapped gh stderr free-form between them.

## Exit code

Always `0` for all four outcomes (the merge itself succeeded). `delete-failed` is loud on stdout + warn log, but does not fail the verb.

## Log lines

| Outcome            | Level | Msg                                       | Bindings                                  |
|--------------------|-------|-------------------------------------------|-------------------------------------------|
| `deleted`          | —     | (none)                                    | —                                         |
| `already-gone`     | info  | `branch was already deleted`              | `{ pr, headRef }`                         |
| `skipped-cross-fork`| info | `branch deletion skipped: cross-fork PR`  | `{ pr, headRef, headOwner }`              |
| `delete-failed`    | warn  | `branch deletion failed`                  | `{ pr, repo, headRef, stderr }`           |

## Test fixtures (SC pins)

### SC-101 — deleted, classify-passing branch

Input: PR has one green required check, `pr.headRepositoryOwner === issueRef.owner`, wrapper's `deleteHeadRef` returns `{ outcome: 'deleted' }`.
Expected: `exitCode === 0`, `stdout === 'merged and branch deleted\n'`, `mergePullRequest` called once, `deleteHeadRef` called once with `(repo, pr.head)`.

### SC-102 — already-gone, vacuous-green branch

Input: PR has no checks, no required checks, `pr.headRepositoryOwner === issueRef.owner`, wrapper's `deleteHeadRef` returns `{ outcome: 'already-gone' }`.
Expected: `exitCode === 0`, `stdout === 'no checks configured and none required — proceeding on completed:validate\nmerged (branch was already deleted)\n'`, `logger.info(..., 'branch was already deleted')` fired once.

### SC-103 — cross-fork skip, classify-passing branch

Input: PR has one green required check, `pr.headRepositoryOwner === 'contributor42'`, `issueRef.owner === 'acme'`.
Expected: `exitCode === 0`, `stdout === 'merged (branch delete skipped: cross-fork PR)\n'`, `deleteHeadRef` NOT called, `logger.info(..., 'branch deletion skipped: cross-fork PR')` fired once.

### SC-104 — delete-failed, classify-passing branch

Input: PR has one green required check, `pr.headRepositoryOwner === issueRef.owner`, wrapper's `deleteHeadRef` returns `{ outcome: 'delete-failed', stderr: 'HTTP 403: Resource not accessible by integration' }`.
Expected: `exitCode === 0`, `stdout === 'merged (branch delete failed: HTTP 403: Resource not accessible by integration)\n'`, `logger.warn({ ..., stderr }, 'branch deletion failed')` fired once.

### SC-105 — deleted composes on vacuous-green

Input: PR has no checks, no required checks, `pr.headRepositoryOwner === null` (deleted head fork), wrapper's `deleteHeadRef` returns `{ outcome: 'deleted' }` (fell through pre-check, DELETE succeeded).
Expected: `exitCode === 0`, `stdout === 'no checks configured and none required — proceeding on completed:validate\nmerged and branch deleted\n'`.

## Non-changes

- Does NOT alter pre-merge classify-checks decision tree. The "never merge on RED" invariant is preserved.
- Does NOT alter `mergePullRequest`'s `--delete-branch=false` flag (Q1→B: the two-step design requires the flag stays so the delete is caller-controlled).
- Does NOT introduce a retry loop. `deleteHeadRef` is single-shot.
- Does NOT add a `--keep-branch` flag (Q5→C).

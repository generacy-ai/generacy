# Contract: `runMerge` — decision tree

**File**: `packages/generacy/src/cli/commands/cockpit/merge.ts`

## Signature (unchanged)

```ts
export interface RunMergeInput {
  gh: GhWrapper;
  issue: number;
  repo: string;
  logger: Logger;
}

export interface RunMergeResult {
  exitCode: 0 | 1;
  stdout: string;
}

export async function runMerge(input: RunMergeInput): Promise<RunMergeResult>
```

## Decision tree (post-fix)

```
1. Resolve issue → PR (existing path).
   ├─ no PR resolved → red ({ reason: 'unresolved', pr: null })
   └─ PR resolved
2. PR state check (existing path).
   ├─ not OPEN → red ({ reason: 'unresolved' })
   └─ OPEN
3. Fetch PR detail (existing path).
4. Fetch issue state (existing path).
   ├─ CLOSED → red ({ reason: 'unresolved' })
   └─ OPEN
5. `completed:validate` label check (existing path).
   ├─ missing → red ({ reason: 'missing-label' })
   └─ present
6. Parallel fetch: getRequiredCheckNames, getPullRequestCheckRuns (existing).

   ┌── NEW BRANCH (Q1→A + FR-002/FR-003 + FR-005) ───────────────────────────┐
   │                                                                          │
   │  const noActual = actualChecks.length === 0;                            │
   │  const noRequired = required.source === 'branch-protection'             │
   │    ? (required.names?.length ?? 0) === 0                                │
   │    : true; // fallback-source has no authoritative required set         │
   │                                                                          │
   │  if (noActual && noRequired) {                                          │
   │    // Vacuously green: nothing to fail on.                              │
   │    await gh.mergePullRequest(repo, pr.number, { squash: true });        │
   │    logger.info({ pr: pr.number }, 'PR merged');                         │
   │    return {                                                              │
   │      exitCode: 0,                                                        │
   │      stdout: 'no checks configured and none required — proceeding on completed:validate\n', │
   │    };                                                                    │
   │  }                                                                       │
   │                                                                          │
   └──────────────────────────────────────────────────────────────────────────┘

7. classifyChecks({ required, actual: actualChecks }) (existing path).
   ├─ !ok → red ({ reason: 'checks-failing', failingChecks })
   │        // failingChecks includes state:'MISSING' entries when required-set
   │        // is non-empty and required contexts are absent from actual.
   └─ ok  → mergePullRequest (existing green path).
             return { exitCode: 0, stdout: '' }
```

## Behavior matrix

| `required.source`      | `required.names` | `actualChecks.length` | `completed:validate` | Outcome                                                  |
|------------------------|------------------|-----------------------|----------------------|----------------------------------------------------------|
| `branch-protection`    | `[]`             | 0                     | present              | Vacuous green + FR-003 note → merge + exit 0             |
| `branch-protection`    | `['a', 'b']`     | 0                     | present              | Red: `MISSING` per required context → exit 1             |
| `branch-protection`    | `['a']`          | `[{name:'a', SUCCESS}]` | present            | Green (existing path) → merge + exit 0, `stdout === ''`  |
| `branch-protection`    | `['a']`          | `[{name:'a', FAILURE}]` | present            | Red: `FAILURE` on 'a' → exit 1                           |
| `fallback-pr-checks`   | `null`           | 0                     | present              | Vacuous green + FR-003 note → merge + exit 0             |
| `fallback-pr-checks`   | `null`           | `[…SUCCESS]`          | present              | Green (existing path) → merge + exit 0, `stdout === ''`  |
| `fallback-pr-checks`   | `null`           | `[…FAILURE]`          | present              | Red: `FAILURE` → exit 1                                  |
| (any)                  | (any)            | (any)                 | absent               | Red: `missing-label` (existing path) → exit 1            |

## Byte-exact FR-003 stdout note

```
no checks configured and none required — proceeding on completed:validate\n
```

- Single line.
- Terminating `\n`.
- Em-dash character `—` = U+2014 (not `--` or `-`).
- Lowercase throughout.
- No leading/trailing whitespace besides the terminating newline.
- UTF-8 byte length: 72 bytes (`no checks configured and none required ` = 40 bytes, `— ` = 4 bytes, `proceeding on completed:validate\n` = 33 bytes). Test fixture stores the literal, not an escaped sequence.

## Preserved contracts

- `RunMergeResult` shape unchanged.
- Red-payload JSON envelope unchanged (`{ status: 'red', reason, pr, failingChecks, issue }`).
- CLI wrapper at `merge.ts:189-191` untouched (`if (result.stdout.length > 0) process.stdout.write(result.stdout)` still delivers the note).
- `logger.info({ pr: pr.number }, 'PR merged')` still fires on both green paths (vacuous and non-vacuous).
- Squash-merge semantics unchanged (`{ squash: true }`).

## Regression tests (in `packages/generacy/src/cli/commands/cockpit/__tests__/merge.test.ts`)

Per FR-011:

- **(a)** CI-less unprotected repo + `completed:validate` → merges with FR-003 stdout note, exit 0.
- **(b)** Repo with required contexts and no runs reported → red with the missing contexts named in `failingChecks[]`, exit 1.
- **(c)** Failing checks unchanged path → red + `failingChecks` entry with `state: 'FAILURE'`, exit 1.

Each test uses a `fakeGh` fixture matching the wrapper's post-fix shape (empty list, not throw, for the no-checks case).

## Not in scope

- Changes to `classifyChecks` (unchanged).
- Changes to `serializeFailingCheckJson` / `buildFailingCheckPayload` (unchanged).
- Changes to `resolveIssueContext` / `parseIssueRef` (unchanged).
- Changes to `mergePullRequest` (unchanged).

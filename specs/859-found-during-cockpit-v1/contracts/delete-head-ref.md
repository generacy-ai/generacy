# Contract: `GhWrapper.deleteHeadRef`

**Location**: `packages/cockpit/src/gh/wrapper.ts` (new method on `GhWrapper` interface + `GhCliWrapper` impl).

## Signature

```typescript
deleteHeadRef(
  repo: string,
  headRef: string,
): Promise<DeleteHeadRefResult>;

export interface DeleteHeadRefResult {
  outcome: 'deleted' | 'already-gone' | 'delete-failed';
  stderr?: string;
}
```

## Input

| Field    | Type   | Contract                                                     |
|----------|--------|--------------------------------------------------------------|
| `repo`   | string | `"owner/name"`. Throws `Error` if split fails.               |
| `headRef`| string | Raw branch name (unencoded; e.g. `feature/x`, `002-phase-1`). |

## Output

`DeleteHeadRefResult` — closed union on `outcome`:

| `outcome`         | When emitted                                                                                          | `stderr`         |
|-------------------|-------------------------------------------------------------------------------------------------------|------------------|
| `deleted`         | Underlying `gh api -X DELETE …/git/refs/heads/<headRef>` exits 0.                                    | omitted          |
| `already-gone`    | Non-zero exit AND stderr matches `/HTTP\s+422\|HTTP\s+404/`.                                          | omitted          |
| `delete-failed`   | Any other non-zero exit.                                                                              | trimmed gh stderr|

## Behavior

**Underlying gh call**:
```
gh api -X DELETE repos/<owner>/<name>/git/refs/heads/<headRef>
```

**Success (exit 0)**: The DELETE returned 204. The ref no longer exists.

**Already-gone (exit non-zero + `HTTP 422` OR `HTTP 404` in stderr)**:
- 422 is GitHub's response when the ref does not exist (`{"message":"Reference does not exist","documentation_url":"…"}`).
- 404 is GitHub's response when the repo lookup misses (rare — repo deleted between merge and DELETE).
- Both cases are semantically "ref is not there" and should NOT be treated as errors.

**Delete-failed (exit non-zero + any other stderr)**:
- 403 (permission denied — token lacks perms, or head fork disallows).
- 5xx (GitHub transient outage).
- Any other unexpected error surface.
- Returns `{ outcome: 'delete-failed', stderr: trimmedStderr }`. Caller renders the stderr on stdout via the FR-005 suffix and emits `logger.warn`.

**Never throws** for expected non-happy paths (only for malformed `repo` input; see below).

## Error handling

- **Malformed `repo`** (missing `/` or empty owner/name) → throws `Error('deleteHeadRef: repo must be "owner/name", got: <repo>')`.
- **All gh-side failures** → mapped to `DeleteHeadRefResult` outcome. No exception propagation to caller.

## Stderr regex

```typescript
/HTTP\s+422|HTTP\s+404/
```

- Matches `HTTP 422`, `HTTP 404` (case-sensitive uppercase — mirrors `getRequiredCheckNames`'s existing pattern at `wrapper.ts:857`).
- Does NOT match `422`, `404` in isolation — avoids false positives from timestamps or ref names containing those substrings.

## Test fixtures (SC pins)

### SC-101 — success

Fake runner returns `{ exitCode: 0, stdout: '', stderr: '' }`.
Expected: `deleteHeadRef('o/r', 'feature/x')` resolves to `{ outcome: 'deleted' }`.

### SC-102 — already gone (422)

Fake runner returns:
```
{
  exitCode: 1,
  stdout: '',
  stderr: 'HTTP 422: Reference does not exist (https://api.github.com/repos/o/r/git/refs/heads/feature%2Fx)\n{"message":"Reference does not exist","documentation_url":"https://docs.github.com/rest/git/refs#delete-a-reference","status":"422"}'
}
```
Expected: `{ outcome: 'already-gone' }`. `stderr` field omitted.

### SC-103 — already gone (404)

Fake runner returns:
```
{ exitCode: 1, stdout: '', stderr: 'HTTP 404: Not Found (https://api.github.com/repos/o/r/git/refs/heads/gone)' }
```
Expected: `{ outcome: 'already-gone' }`. `stderr` omitted.

### SC-104 — delete failed

Fake runner returns:
```
{ exitCode: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible by integration' }
```
Expected: `{ outcome: 'delete-failed', stderr: 'HTTP 403: Resource not accessible by integration' }`.

## Non-changes

- Does NOT emit `logger.warn` from within the wrapper (the caller decides observability). This diverges from `getPullRequestCheckRuns`'s pattern deliberately — that method throws, so warning at the wrapper is the last chance; `deleteHeadRef` returns a structured outcome, so the caller has full information and can decide.
- Does NOT retry. Single-shot.
- Does NOT accept an optional `logger` parameter — outcome-based return values make it unnecessary.

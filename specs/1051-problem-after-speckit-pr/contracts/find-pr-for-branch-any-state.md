# Contract: `GhCliGitHubClient.findPRForBranchAnyState`

## Public surface

New method on `GitHubClient` interface:

```ts
async findPRForBranchAnyState(
  owner: string,
  repo: string,
  branch: string,
): Promise<PullRequest | null>;
```

## Semantics

Mirrors `findPRForBranch` (`gh-cli.ts:890-926`) **but** passes `--state all` to `gh pr list`.

Implementation shape (drop into `gh-cli.ts` immediately after `findPRForBranch`):

```ts
async findPRForBranchAnyState(owner: string, repo: string, branch: string): Promise<PullRequest | null> {
  const result = await this.executeGh([
    'pr', 'list',
    '-R', `${owner}/${repo}`,
    '--head', branch,
    '--state', 'all',   // ← the only difference from findPRForBranch
    '--json', 'number,title,body,state,isDraft,headRefName,baseRefName,labels,createdAt,updatedAt',
    '--limit', '1',
  ]);

  if (result.exitCode !== 0) {
    return null;
  }

  const data = parseJSONSafe(result.stdout) as Array<Record<string, unknown>> | null;
  if (!data || data.length === 0) {
    return null;
  }

  const pr = data[0]!;
  return {
    number: pr['number'] as number,
    title: pr['title'] as string,
    body: pr['body'] as string ?? '',
    state: this.mapState(pr['state']),
    draft: pr['isDraft'] as boolean ?? false,
    head: { ref: pr['headRefName'] as string, sha: '', repo: `${owner}/${repo}` },
    base: { ref: pr['baseRefName'] as string, sha: '', repo: `${owner}/${repo}` },
    labels: ((pr['labels'] as Array<{ name: string; color: string }>) ?? []).map(l => ({
      name: l.name,
      color: l.color,
    })),
    createdAt: pr['createdAt'] as string,
    updatedAt: pr['updatedAt'] as string,
  };
}
```

**State mapping**: unlike `findPRForBranch`, this method returns PRs in `merged` and `closed` states — the caller (push-guard) discriminates on state. Preserve the existing lowercase normalization:

- `MERGED` → `'merged'`
- `CLOSED` → `'closed'`
- `OPEN`   → `'open'`

If a private helper `mapState` does not yet exist, inline the mapping — do not extract in this PR.

**Ordering / merged-precedence** (PR #1052 review Finding 7): `--limit 10` (raised from `--limit 1`) plus a caller-side scan for the first row with `state === 'merged'` — if any exists, return it. Otherwise return the newest row. Rationale: `gh pr list` sorts by `created_at DESC`; `--limit 1` would drop a MERGED PR that sits behind a newer CLOSED PR on the same branch (verified live against `884-problem-refreshaccesstoken`), causing the guard to emit `reason: 'pr-closed'` at the less-diagnostic row rather than `reason: 'pr-merged'` at row 1. Preserving `--limit 1` was an implementation compromise that defeated the guard's stated intent.

**Failure behavior** (PR #1052 review Finding 4): the method MUST **throw** on non-zero exit rather than returning `null`. `null` is reserved for "no PR exists in any state" (an operationally-meaningful fact). Silent null-on-error is the wrong contract for a safety-gate input: a rate-limited `gh` call reclassified as "no PR ever" would let `push-guard.ts` allow the exact resurrection push it exists to block. The guard's own decision matrix distinguishes throw (refuse `pr-lookup-failed`) from `null` (allow first-push case).

## Non-goals

- MUST NOT modify `findPRForBranch`.
- MUST NOT introduce a `state?: string` parameter on `findPRForBranch` (Q2 clarification — five call sites depend on the open-only default).
- MUST NOT paginate or return an array (the guard only needs one; more would inflate the call cost).

## Test surface

Cases the new unit test MUST cover:

- `gh pr list` returns empty array → `null`.
- `gh pr list` returns an `OPEN` PR → object with `state === 'open'`.
- `gh pr list` returns a `MERGED` PR → object with `state === 'merged'`.
- `gh pr list` returns a `CLOSED` PR → object with `state === 'closed'`.
- `gh pr list` returns `[CLOSED_new, MERGED_old]` → object with `state === 'merged'` (Finding 7).
- `executeGh` exits non-zero → **throws** (Finding 4).
- `--state all` is present in the argv passed to `executeGh` — static argv assertion.
- `--limit` value in argv is `> 1` (Finding 7 — enables merged-precedence).

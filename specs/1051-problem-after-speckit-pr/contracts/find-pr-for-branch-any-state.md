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

**Ordering**: `--limit 1` returns the most recent PR by GitHub's default ordering (`created_at DESC`). Rationale: if a repo has multiple historical PRs for the same head branch (rare — usually only after manual branch recreation), the newest is the most diagnostic. Merged/closed PRs are the situation we want to detect; picking the newest merged PR over a stale older one is correct.

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
- `executeGh` exits non-zero → `null` (matches `findPRForBranch` failure shape).
- `--state all` is present in the argv passed to `executeGh` — static argv assertion.

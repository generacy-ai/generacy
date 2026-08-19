# Contract: `GitHubClient.commitExistsInCheckout` (#1112)

New local-git capability on the `GitHubClient` interface, implemented by
`GhCliGitHubClient`. Answers "does this commit object exist in the local
checkout?" so the phase-start-ref guard can distinguish a reusable ref from one
that does not resolve after a re-entry on a fresh clone.

## Signature

```ts
/**
 * Whether `sha` resolves to a commit object in the local checkout (#1112).
 * Runs `git rev-parse --verify --quiet <sha>^{commit}` in the workdir.
 *
 * @param sha A 7-40 hex commit ref (as accepted by isValidCommitSha).
 * @returns true when the commit exists (git exit 0); false when it is missing
 *   (git exit 1 — for both full and abbreviated shas).
 * @throws Error on any other git exit (e.g. 128 — corrupt/inaccessible git dir,
 *   not a repository) with the exit code and stderr, so an environment fault is
 *   never mistaken for a missing commit.
 */
commitExistsInCheckout(sha: string): Promise<boolean>;
```

## Behavior contract

| git exit | Meaning | Method result |
|----------|---------|---------------|
| 0 | Object exists and peels to a commit | `return true` |
| 1 | Commit missing (full or abbreviated sha) | `return false` |
| 128 (any other non-zero) | Environment fault (not-a-repo, corrupt object store, ...) | `throw Error` |

- Runs in `this.workdir`, identical to `getCurrentCommitSha` / `getFilesChangedByOwnCommits`.
- No network, no `gh` — pure local git.
- The `^{commit}` peel guarantees a tag or tree with the same name does not count as a matching commit.

## Why not `git cat-file -e` (measured, git 2.52.0)

`git cat-file -e <sha>^{commit}` exits **128** for a missing object *and* for
"not a git repository," so it cannot separate the FR-003 absent case from the
FR-005 environment-fault case. The plain `cat-file -e <sha>` form exits 1 for a
missing 40-hex object but 128 for a missing *abbreviated* sha — misclassifying
short refs. `rev-parse --verify --quiet <sha>^{commit}` is the only form that
returns exit 1 for both full and abbreviated missing commits and reserves 128
for genuine faults.

## Consumer contract (phase-loop)

- Called only for a reused ref (branch-scoped hit or legacy-migrated value),
  before it is used as the `git log <ref>..HEAD` base.
- `false` → the ref is treated as absent: capture fresh HEAD, persist under the
  branch-scoped key, proceed (FR-004). No throw, no escalation.
- A thrown error is caught by the capture block's existing `try/catch`, leaving
  `phaseStartRef` undefined; the downstream undefined-guard then routes to the
  `product-diff-error` classifier + escalation (FR-005 / SC-005) — the same
  fail-to-undefined contract #1107 already relies on.

## Reference implementation

```ts
async commitExistsInCheckout(sha: string): Promise<boolean> {
  const result = await executeCommand('git', [
    'rev-parse', '--verify', '--quiet', `${sha}^{commit}`,
  ], { cwd: this.workdir });

  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new Error(
    `git rev-parse --verify --quiet ${sha}^{commit} failed ` +
      `(exit ${result.exitCode}): ${result.stderr.trim()}`,
  );
}
```

# Contract: `gh` CLI wrapper

A thin, testable wrapper over the `gh` CLI covering the read + label-mutation + check-run subset the cockpit needs.

## Construction

```ts
class GhCliWrapper implements GhWrapper {
  constructor(runner: CommandRunner = defaultRunner);
}
```

`CommandRunner` is injected so unit tests pass a stub that returns canned stdout — no real process spawning in tests.

```ts
export interface CommandRunner {
  (
    cmd: string,
    args: string[],
    opts?: { env?: Record<string, string>; cwd?: string; timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}
```

The default runner uses `node:child_process.execFile` with a 30s timeout.

## Methods

### `listIssues(query, options?)`

```ts
listIssues(query: string, options?: { limit?: number; repo?: string }): Promise<Issue[]>;
```

- Runs `gh search issues "<query>" --json number,title,state,labels,url,body,author --limit <limit>` (default `limit: 100`).
- If `options.repo` is provided, scopes the search to that repo via `--repo <owner>/<repo>` flag (when supported by the command shape) or appends `repo:<owner>/<repo>` to the query.
- Parses JSON; validates each entry; flattens `labels[].name` into `string[]`.
- Returns `Issue[]` (empty array if no matches).

### `addLabels(repo, issue, labels)` / `removeLabels(repo, issue, labels)`

```ts
addLabels(repo: string, issue: number, labels: string[]): Promise<void>;
removeLabels(repo: string, issue: number, labels: string[]): Promise<void>;
```

- Each wraps `gh issue edit <issue> --repo <repo> --add-label <l1> --add-label <l2> ...` (or `--remove-label`).
- Idempotent on the `gh` side; the wrapper does not pre-check current state.
- Throws on non-zero exit code, with stderr included in the error message.

### `getPullRequestCheckRuns(repo, prNumber)`

```ts
getPullRequestCheckRuns(repo: string, prNumber: number): Promise<CheckRunSummary[]>;
```

- Runs `gh pr checks <prNumber> --repo <repo> --json name,state,conclusion,detailsUrl`.
- Validates JSON shape; returns `CheckRunSummary[]`.

## Error modes

- Non-zero exit code on any `gh` invocation → throws `Error` with stderr in the message. Callers may catch and decide.
- Malformed JSON output → throws with a snippet of the offending payload.
- Missing `gh` binary → propagates the system `ENOENT` from the runner.

## Invariants

- The wrapper performs no network I/O directly — all GitHub access goes through `gh`.
- No ambient `GH_TOKEN` override. The wrapper does not inject env vars (caller's environment is used). Authentication is the caller's responsibility (`gh auth login` or `GH_TOKEN` set in the caller's environment).

## Test approach

- Unit tests construct a `GhCliWrapper` with a stub runner that records invocations and returns canned `{ stdout, stderr, exitCode }` values.
- Tests assert: (a) the constructed `gh` command + args, (b) the parsed return value, (c) error propagation on non-zero exit.
- Zero real `gh` invocations in tests.

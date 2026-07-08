# Contract: `GhCliWrapper.getPullRequestCheckRuns` (post-#855)

**Module**: `packages/cockpit/src/gh/wrapper.ts`
**Method**: `getPullRequestCheckRuns(repo: string, prNumber: number): Promise<CheckRunSummary[]>`
**Delta reason**: Pre-#855 field list `'name,state,conclusion,detailsUrl'` failed on every gh version (client-side `--json` rejection). Fix swaps to `'name,state,bucket,link'`, wires a wrapper-level warn log with structured fields on failure, and preserves rethrow semantics so `merge` still hard-fails.

## Signature (unchanged)

```ts
async getPullRequestCheckRuns(repo: string, prNumber: number): Promise<CheckRunSummary[]>;
```

## gh invocation

```
gh pr checks <prNumber> --repo <repo> --json name,state,bucket,link
```

Field list is the single string literal `'name,state,bucket,link'`. No dynamic composition; enforced by the drift suite (`json-field-drift.test.ts`).

## Happy path

1. Runner spawns gh with the args above.
2. gh returns exit 0 with a JSON array of `{ name, state, bucket, link, … }` per check-run on stdout.
3. `parseCheckRuns` parses stdout, validates against `CheckRunRawSchema` (Zod), and maps each entry:
   - `name` → `CheckRunSummary.name`
   - `normalizeCheckState({raw.state, raw.bucket, raw.status})` → `CheckRunSummary.state`
   - `raw.link` → `CheckRunSummary.url`
4. Returns `CheckRunSummary[]`.

## Failure paths

### Non-zero exit (network, auth, malformed --json field name)

1. Wrapper emits:
   ```ts
   logger.warn(
     { repo, prNumber, ghStderr: <trimmed stderr> },
     'gh pr checks failed',
   );
   ```
2. Wrapper throws:
   ```ts
   throw new Error(`gh pr checks failed (exit ${exitCode}): ${trimmedStderr}`);
   ```
3. Callers catch this either hard (`merge`) or silently (`status` / `watch` / `context`).

### Malformed JSON (gh returned non-JSON stdout)

`parseCheckRuns` throws:

```
gh returned malformed JSON for getPullRequestCheckRuns: <first 200 chars>
```

**No warn log** on this path — the wrapper log is scoped to gh-invocation failures (I-1 in data-model.md). Malformed-JSON is a schema-parse failure, not a gh-invocation failure. Callers see the raw error.

### Zod schema mismatch (gh returned unexpected field types)

`parseCheckRuns` throws:

```
gh pr checks JSON shape mismatch: <Zod error message>
```

Same: no warn log. Different failure mode from FR-005's target (invisible silent-swallow was the smoke-test finding, and that was a `failIfNonZero` path).

## Log format (FR-005)

Structured warn:

```ts
{
  level: 'warn',
  msg: 'gh pr checks failed',
  repo: 'octocat/hello-world',
  prNumber: 42,
  ghStderr: 'HTTP 404: Not Found (https://api.github.com/repos/…)',
}
```

- Message string is the constant literal `'gh pr checks failed'`. No template interpolation.
- Structured fields are `{ repo, prNumber, ghStderr }`. No other fields.
- Log fires exactly once per failed invocation (I-1). Not on parse failure. Not on happy path.
- Log fires before the throw. The throw's error text and the log's `ghStderr` are the same content.

## Consumer contract

| Consumer                                                             | Behavior on throw                                              |
|----------------------------------------------------------------------|-----------------------------------------------------------------|
| `packages/generacy/.../cockpit/merge.ts:139`                         | Bubbles to `Promise.all` reject; `runMerge` propagates.         |
| `packages/generacy/.../cockpit/status.ts:123`                        | `catch { checks = 'none' }`. Silent (renders `- / none`).       |
| `packages/generacy/.../cockpit/watch/poll-loop.ts:98`                | `catch { checks = [] }`. Silent (rollup renders `pending`).     |
| `packages/generacy/.../cockpit/context.ts:285`                       | `catch` throws `CockpitExit(1, 'gh pr detail: …')`. Semi-hard.  |

All four are **unchanged** by this PR. The wrapper log line is the new operator-facing surface; consumer degrade behavior is Out-of-Scope.

## Invariants

- **`merge`'s hard-fail is preserved**: FR-005 rethrow-not-swallow guarantee. `runMerge`'s decision tree exit codes are byte-stable.
- **Silent consumers still silent**: their catches are untouched. Rendering behavior in `status` / `watch` / `context` is unchanged for the operator.
- **Warn-once-per-failure**: no double-log across the parse boundary.
- **No dependency on pino at the wrapper**: the injected logger interface is minimal (`GhWrapperLogger`).

## Test coverage

- `packages/cockpit/src/__tests__/gh-wrapper.test.ts`:
  - Existing happy-path test updated to use fixture `{ name, state: 'pass', bucket: 'pass', link: 'https://x' }`; asserts `url === 'https://x'`, `state === 'SUCCESS'`, no `conclusion` on the returned summary.
  - New test: non-zero exit → asserts (a) one `logger.warn` call with `{ repo: 'o/r', prNumber: 99, ghStderr: <trimmed> }`; (b) rethrow with matching error message.
- `packages/cockpit/src/gh/__tests__/json-field-drift.test.ts` (new):
  - Ensures `'name,state,bucket,link'` (and every other `--json` follow-up in `wrapper.ts`) is accepted by the pinned `gh` binary. Fails hard on any `Unknown JSON field` in gh's stderr.

## Non-changes

- **Runner interface** — unchanged.
- **`GhWrapper` interface signature for `getPullRequestCheckRuns`** — unchanged.
- **Consumer catch-block behavior** — unchanged (see table above).
- **Error message format on throw** — the string prefix `'gh pr checks failed (exit N): '` is preserved so operator log-greps and existing test regexes keep matching.

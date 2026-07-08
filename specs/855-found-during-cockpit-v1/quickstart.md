# Quickstart: `gh pr checks` field-list fix + drift guard (#855)

## What changed for operators

Before the fix, `generacy cockpit merge <ref>` on any real PR failed with:

```
gh pr checks failed (exit 1): Unknown JSON field: "conclusion"
```

Because `getPullRequestCheckRuns` in the wrapper requested a field name (`conclusion`) that `gh pr checks` has never accepted. gh rejects the field list client-side, so the call has failed on every invocation, every gh version, since rev 2.

The same silent failure degraded `cockpit status`, `cockpit watch`, and `cockpit context`: their `catch { … }` blocks swallowed the error and rendered the checks column as `- / none`. That's the week-old blank-column observation from the cockpit v1 smoke test — it wasn't absent data, the fetch had never succeeded.

**After the fix**:

1. `cockpit merge` succeeds on green PRs. No more `Unknown JSON field: "conclusion"`.
2. `cockpit status` / `watch` / `context` populate the checks column with real data.
3. Any future gh failure emits a structured `warn` log with `{ repo, prNumber, ghStderr }` — the silent-failure class is now observable.
4. A colocated vitest suite validates every `--json` field list in `wrapper.ts` against the real pinned `gh` binary in CI. New field-list drift fails the CI run within seconds, with the offending field name and wrapper line.

## Verifying the fix locally

### 1. Green-PR merge succeeds (SC-001)

```bash
# Pick any epic with a merge-ready PR (workflow labels applied, checks green):
generacy cockpit merge <owner>/<repo>#<issue>

# Expected before fix: exits 1 with "Unknown JSON field: \"conclusion\""
# Expected after fix:  exits 0 (PR squash-merged)
```

Live repro (auth-free, verifies the gh side without any generacy code):

```bash
gh pr checks 999 --repo octocat/hello-world --json conclusion
# Before fix's field list: Unknown JSON field: "conclusion"
# The instantaneous, client-side rejection is exactly what broke every merge.

gh pr checks 999 --repo octocat/hello-world --json name,state,bucket,link
# Post-fix's field list: exits non-zero for "PR not found", but NO "Unknown JSON field" error.
# gh accepts the field list. Any subsequent failure is real (auth, network, not-found).
```

### 2. Checks columns populate in `status` / `watch` / `context` (SC-002)

```bash
generacy cockpit status <epic-ref>
# Before fix: every PR row's checks column reads "- / none".
# After fix:  columns show the actual rollup (pass / fail / pending / etc.).

generacy cockpit watch <epic-ref>
# Same: transitions on checks state now fire.

generacy cockpit context <owner>/<repo>#<pr-number> --gate implementation-review
# Before fix: JSON payload's `checks` array was `[]`.
# After fix:  `checks` array is populated with { name, state, url }.
```

### 3. Silent failure now emits a warn log (SC-003)

Intentionally break the field list on a scratch branch (temporary edit to `wrapper.ts:605`):

```bash
# Edit wrapper.ts to use --json 'name,intentionally-invalid-field'
generacy cockpit status <epic-ref> 2>&1 | grep 'gh pr checks failed'
# Expected:
# gh pr checks failed { repo: 'o/r', prNumber: 42, ghStderr: 'Unknown JSON field: "intentionally-invalid-field"' }
```

Revert the edit before committing.

## Running the tests

### Unit tests + drift suite (SC-004, SC-005)

```bash
cd /workspaces/generacy
pnpm --filter @generacy-ai/cockpit test
```

Expected: all pass, including:
- `getPullRequestCheckRuns` positive-path test with the new fixture shape (`bucket` / `link` instead of `conclusion` / `detailsUrl`).
- New `warn`-log-on-failure test (asserts one `logger.warn` call with `{ repo, prNumber, ghStderr }` and rethrow).
- Drift suite (`json-field-drift.test.ts`) — runs when `gh` is available, skips visibly when not:
  ```
  ✓ gh --json field drift > gh accepts pr checks --json "name,state,bucket,link" (wrapper.ts:605)
  ✓ gh --json field drift > gh accepts pr view --json "number,state,mergedAt,closedAt,url,isDraft,labels" (wrapper.ts:635)
  ✓ (11 more)
  ```

### Downstream fixture tests

```bash
pnpm --filter @generacy-ai/generacy test src/cli/commands/cockpit
```

Expected: all pass. `helpers/fake-gh.ts` and any `merge.test.ts` / `context.*.test.ts` `getPullRequestCheckRuns` fixtures that included `conclusion` in the return shape are cleaned up mechanically (drop the field). No assertion changes.

## Provoking a drift-suite failure (to prove SC-004 works)

On a scratch branch:

1. Add a wrapper method with a bogus `--json` field list:
   ```ts
   async debugBadFieldList(): Promise<unknown> {
     const args = ['pr', 'checks', '1', '--repo', 'octocat/hello-world', '--json', 'not-a-real-field'];
     return this.runner('gh', args);
   }
   ```
2. Run `pnpm --filter @generacy-ai/cockpit test`.
3. Expected failure:
   ```
   ✕ gh --json field drift > gh accepts pr checks --json "not-a-real-field" (wrapper.ts:<line>)
     Error: gh rejected --json field list at wrapper.ts:<line>: "not-a-real-field"
     stderr: Unknown JSON field: "not-a-real-field"
   ```
4. Revert.

## Provoking a non-literal detector failure (to prove SC-005 works)

On a scratch branch, change any `--json` follow-up in `wrapper.ts` to a non-literal:

```ts
'--json',
[...fields].join(','),   // ← was 'name,state,bucket,link'
```

Run `pnpm --filter @generacy-ai/cockpit test`. Expected failure:

```
✕ gh --json field drift > wrapper.ts:606 has a non-literal --json follow-up: [...fields].join(','),
  Error: json-field-drift: every --json follow-up in wrapper.ts must be a single-quoted string literal.
```

Revert.

## `CheckRunSummary` shape change (developer-facing)

If you consume `@generacy-ai/cockpit`'s `CheckRunSummary` type, the returned object shape narrows:

**Before**:
```ts
{
  name: string,
  state: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NEUTRAL' | 'SKIPPED' | 'CANCELLED',
  conclusion?: string,   // ← REMOVED
  url?: string,
}
```

**After**:
```ts
{
  name: string,
  state: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NEUTRAL' | 'SKIPPED' | 'CANCELLED',
  url?: string,
}
```

Impact: none. `conclusion` was never populated (dead-on-arrival). If your code reads `.conclusion`, delete the read — it has always been `undefined`.

## Wrapper logger injection (developer-facing)

`GhCliWrapper`'s constructor gains an optional logger:

```ts
new GhCliWrapper(runner?: CommandRunner, logger?: GhWrapperLogger);

interface GhWrapperLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}
```

- Default: `console.warn`-backed shim. Fail-loud by default.
- Structurally compatible with `pino.Logger` — pass a pino instance directly.
- Structurally compatible with test spies — pass `{ warn: vi.fn() }` in unit tests.

Follow-up (out-of-scope for this PR): thread a pino logger through `resolver.ts:166,170` and `queue.ts:224,225` so wrapper logs land in the same stream as CLI command logs.

## Rolling back the interim workaround

If you applied the `#853` workaround from finding #19 (labeling the PR with `completed:validate`), it stays applicable — this fix doesn't undo it. Continue with `#853`'s guidance for label-source fixes; `#855` is orthogonal (wrapper-level, not label-source).

## Troubleshooting

**Symptom**: `cockpit merge` still fails with `Unknown JSON field: "conclusion"` after installing the fix.
- **Check**: `generacy --version` — confirm the running CLI includes the #855 fix (post-2026-07-08).
- **Check**: `grep 'name,state,conclusion' packages/cockpit/src/gh/wrapper.ts` — should return zero matches on a fixed build.

**Symptom**: Drift suite fails locally with "gh not found".
- **Check**: `gh --version`. The suite is `describe.runIf(hasGhBinary)`-gated, so this shouldn't happen — but if `gh` is installed at a non-default path, ensure it's on `$PATH`.
- **Alternative**: run `SKIP_GH_DRIFT=1 pnpm test` (if implemented — the current design uses `runIf`, which skips silently).

**Symptom**: Drift suite fails in CI with `Unknown JSON field: "<X>"`.
- **Fix**: someone landed a wrapper change that requests `<X>` on `gh <subcommand> --json`. Locate the wrapper line in the failure message; correct the field name against `gh <subcommand> --help | grep -A20 '\-\-json'`.

**Symptom**: Drift suite fails with `has a non-literal --json follow-up`.
- **Fix**: revert the offending change to use a single-quoted string literal after `'--json',`. Dynamic field lists (`.join`, template literals, variables) are forbidden by SC-005 because they cannot be statically validated.

**Symptom**: `cockpit status` still shows `- / none` for a specific PR after the fix.
- **Check**: `gh pr checks <pr> --repo <owner/repo> --json name,state,bucket,link` — does it return data? If no check-runs exist on the PR, `- / none` is the correct render.
- **Check**: is the PR's SHA the same as the head SHA gh knows about? If a force-push happened, gh may briefly return an empty check-runs array.

**Symptom**: `console.warn` output in unit tests is noisy after upgrade.
- **Fix**: in tests that construct `new GhCliWrapper(runner)` and expect gh failures, pass a silent logger: `new GhCliWrapper(runner, { warn: () => {} })`.

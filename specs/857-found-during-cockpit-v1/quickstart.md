# Quickstart: #857

## Verify the live repro (pre-fix)

The finding-#22 PR is public:
- Repo: `christrudelpw/sniplink`
- Issue: `#2`
- PR: `#16`
- State: `completed:validate` applied, zero CI configured, no branch protection.

Pre-fix behavior:
```bash
generacy cockpit merge 2 --repo christrudelpw/sniplink
# stderr: cockpit merge: PR has failing or pending required checks
# stdout: {"status":"red","reason":"checks-failing","pr":{"number":16,…},"failingChecks":[]}
# exit: 1
# NB: failingChecks is empty because the exception was thrown BEFORE classifyChecks ran.
```

The wrapper warn line accompanies the failure (from #855):
```
gh pr checks failed { repo: 'christrudelpw/sniplink', prNumber: 16, ghStderr: "no checks reported on the '002-phase-1-foundation-part' branch" }
```

## Apply the fix

The fix lives in `packages/cockpit` (wrapper) and `packages/generacy` (CLI decision tree + rollup consumers). Both packages must be rebuilt for the fix to take effect end-to-end.

```bash
pnpm install
pnpm -F @generacy-ai/cockpit build
pnpm -F @generacy-ai/generacy build
```

## Verify (post-fix)

### (a) CI-less unprotected repo + `completed:validate`

```bash
generacy cockpit merge 2 --repo christrudelpw/sniplink
# stdout: no checks configured and none required — proceeding on completed:validate
# (logger info line): PR merged { pr: 16 }
# exit: 0
```

Byte-exact grep on the stdout note (SC-006):
```bash
generacy cockpit merge 2 --repo christrudelpw/sniplink 2>/dev/null \
  | grep -F 'no checks configured and none required — proceeding on completed:validate'
```

### (b) Branch-protection required + no runs reported

Set up a repo with branch protection requiring context `ci/test`:
```bash
gh api -X PUT repos/OWNER/REPO/branches/main/protection \
  -f 'required_status_checks[strict]=true' \
  -F 'required_status_checks[contexts][]=ci/test' \
  # …other required fields
```

Attempt merge on a PR with no `ci/test` runs:
```bash
generacy cockpit merge N --repo OWNER/REPO
# stdout: {"status":"red","reason":"checks-failing","failingChecks":[{"name":"ci/test","state":"MISSING"}],…}
# exit: 1
```

### (c) Failing check unchanged

Any PR with a real `state: 'FAILURE'` check-run continues to be blocked:
```bash
generacy cockpit merge N --repo OWNER/REPO
# stdout: {…"failingChecks":[{"name":"ci/build","state":"FAILURE","url":"…"}],…}
# exit: 1
```

### `status` — `'none'` vs `'error'`

CI-less repo (post-fix): the checks column shows `none`:
```bash
generacy cockpit status <epic>
# Row for a CI-less PR reads: … PR    16   none   <title>
```

If `gh` fails (e.g., unauthenticated): the checks column shows `error`:
```bash
GH_TOKEN=invalid generacy cockpit status <epic>
# Row for the same PR reads: … PR    16   error  <title>
# stderr also carries the wrapper warn line
```

### `watch` — transition emits

Start a watch on a repo that has no CI, then add a CI workflow file mid-watch:
```bash
generacy cockpit watch <epic> --interval 10s
# t0:                    (baseline sweep)
# tN (after CI added):   pr-checks event emitted with transition none → success
```

## Troubleshooting

**Symptom**: merge exits 1 with `checks-failing` and no `failingChecks[]` entries.
- **Pre-#857 behavior**. Confirm the two packages are rebuilt with #857 changes:
  ```bash
  grep 'no checks reported' packages/cockpit/dist/gh/wrapper.js
  # expected: match on the substring detection.
  ```
- If the grep matches but the symptom persists: check the linked node_modules symlink for the CLI package:
  ```bash
  ls -la node_modules/@generacy-ai/cockpit
  # expected: symlink to packages/cockpit
  ```

**Symptom**: merge exits 0 but no stdout note.
- The vacuous-green branch fired but the note wasn't included. Verify `RunMergeResult.stdout` is threaded through the CLI action's `process.stdout.write(result.stdout)` (`merge.ts:189-191`). This is the pre-existing path; if it's been altered, the note goes silent.
- The CLI's `process.stdout.write` is stdout-only; if you're piping stderr and expecting the note there, it won't appear.

**Symptom**: merge exits 0 with the stdout note, but no actual squash-merge happened.
- Check the wrapper's `mergePullRequest`; the fix places `mergePullRequest(...)` before the return in the vacuous-green branch. Verify the local build reflects the diff in `plan.md`.

**Symptom**: `status` shows `error` on every row.
- The wrapper is throwing on real errors (auth, network, gh binary missing). Check the accompanying warn line for `{ repo, prNumber, ghStderr }`. Fix the underlying gh issue.

**Symptom**: `status` shows `none` for a repo you know has CI.
- The wrapper's substring detection matched an unexpected stderr fragment. Capture the actual stderr:
  ```bash
  gh pr checks N --repo OWNER/REPO --json name,state,bucket,link 2>&1 | tee /tmp/stderr.log
  grep -F 'no checks reported' /tmp/stderr.log
  ```
- If the grep matches unexpectedly (i.e., gh's message wording drifted), file a fix-forward issue and update the substring in `getPullRequestCheckRuns`.

**Symptom**: `watch` emits noisy `pr-checks` transitions to/from `'none'`.
- **Expected behavior** (Q3→A). `'none'` is a real state (no CI); transitions to/from it are real observable events. Consumers that want only actionable events should filter through `actionable.ts`, which correctly treats `'none'` as non-actionable.

## Commands

Unchanged CLI surface:
```
generacy cockpit merge <issue> [--repo <owner/repo>]
generacy cockpit status <epic-ref> [--json]
generacy cockpit watch <epic-ref> [--interval <s>] [--out <file>] [--json]
```

Behavioral additions:
- `merge` may emit the FR-003 stdout note on vacuous-green success.
- `status` and `watch` may render `checks: 'none'` (no CI) or `checks: 'error'` (gh failed).

## Verifying the fix in tests

```bash
pnpm -F @generacy-ai/cockpit test src/__tests__/gh-wrapper.test.ts
# expected: new "no checks reported" positive test passes; existing tests unchanged.

pnpm -F @generacy-ai/generacy test src/cli/commands/cockpit/__tests__/merge.test.ts
# expected: three new tests (a)(b)(c) pass.

pnpm -F @generacy-ai/generacy test src/cli/commands/cockpit/__tests__/watch.check-rollup.test.ts
# expected: rollup([]) === 'none' assertion passes.

pnpm -F @generacy-ai/generacy test src/cli/commands/cockpit/__tests__/watch.actionable.test.ts
# expected: 'none' and 'error' never actionable.

pnpm -F @generacy-ai/generacy test src/cli/commands/cockpit/__tests__/watch.diff.test.ts
# expected: transitions to/from 'none' and 'error' emit pr-checks events.
```

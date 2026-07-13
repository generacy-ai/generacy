# Quickstart: `cockpit merge` and `cockpit review-context`

This issue ships two new verbs on the `generacy` CLI.

## Prerequisites

- Node.js ≥ 22 (the CLI gates this; `generacy --version` will refuse to run on older Node).
- `gh` CLI installed and authenticated (`gh auth status` returns 0).
- The repo you're merging into has `develop` as its base branch.
- For full required-check enforcement: the `gh` token must have `Administration: read` on the repo (to read branch protection). Without it, the verb falls back to "every check present on the PR must be green" and prints a `warn` line on stderr.

## Installation

The verbs ship as part of `@generacy-ai/generacy`. From a workspace clone:

```bash
pnpm install
pnpm --filter @generacy-ai/generacy build
```

After publish, the global install path is unchanged:

```bash
pnpm dlx @generacy-ai/generacy cockpit --help
```

## Commands

### `generacy cockpit merge <issue>`

Squash-merges the PR for `<issue>` into `develop` iff it carries `completed:validate` and every required check is green.

```bash
generacy cockpit merge 1234
```

**Green path** (PR merged):

- Exit code: `0`
- Stdout: empty
- Side effect: squash merge commit on `develop`.

**Red path** (PR not merged):

- Exit code: non-zero (`1`)
- Stdout: a single JSON object, validated against `contracts/failing-check.schema.json`:

```json
{
  "status": "red",
  "reason": "checks-failing",
  "pr": { "number": 1234, "url": "https://github.com/o/r/pull/1234" },
  "failingChecks": [
    { "name": "ci/lint", "state": "FAILURE", "url": "https://github.com/o/r/actions/runs/9876" },
    { "name": "ci/test", "state": "PENDING" }
  ]
}
```

Reasons:

- `"unresolved"` — no PR found for `<issue>`, or the PR is closed/merged. `pr` may be `null`. `failingChecks` is empty.
- `"missing-label"` — PR exists but lacks `completed:validate`. `failingChecks` is empty.
- `"checks-failing"` — required check is missing / pending / failing. `failingChecks` is non-empty.

There is **no** `--force` flag. The verb never merges on red.

### `generacy cockpit review-context <issue>`

Emits the input payload for the review skill (PR metadata + unified diff + check results).

```bash
generacy cockpit review-context 1234 | jq .
```

- Exit code: `0` on success (even when checks are red — this verb is descriptive, not gating).
- Exit code: non-zero with a clear stderr message when the issue / PR cannot be resolved.
- Stdout: one JSON object, validated against `contracts/review-context.schema.json`:

```json
{
  "pr": {
    "number": 1234,
    "title": "feat: foo",
    "url": "https://github.com/o/r/pull/1234",
    "base": "develop",
    "head": "1234-feat-foo",
    "body": "Closes #1234",
    "author": "alice",
    "state": "OPEN",
    "draft": false
  },
  "diff": "diff --git a/...\n@@ -1 +1 @@\n-old\n+new\n",
  "diffTruncated": false,
  "checks": [
    { "name": "ci/lint", "state": "SUCCESS" },
    { "name": "ci/test", "state": "SUCCESS" }
  ]
}
```

Diffs over 256 KiB are truncated and `diffTruncated: true`. To get the full text:

```bash
gh pr diff 1234
```

## Repository inference

Both verbs infer the target repo from cwd (matches the convention used elsewhere in the CLI — see `cluster-context.ts`). To target an explicit repo:

```bash
generacy cockpit merge 1234 --repo generacy-ai/generacy
generacy cockpit review-context 1234 --repo generacy-ai/generacy
```

## Composing with skills

The `/cockpit:merge` and `/cockpit:review` skills consume these verbs:

```bash
# /cockpit:merge effectively does:
generacy cockpit merge "$ISSUE" \
  || (jq '.reason' && ./route-to-fixer-or-notify.sh)
```

```bash
# /cockpit:review effectively does:
generacy cockpit review-context "$ISSUE" \
  | claude code --skill review --stdin
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `cockpit merge` exits red with `reason: "unresolved"` and `pr: null` | Issue has no linked PR. | Open a PR that closes the issue, or push the existing branch and re-run. |
| `cockpit merge` exits red with `reason: "missing-label"` | PR hasn't completed the validate phase yet. | Re-run the workflow; `completed:validate` is applied by `update-phase` automation. |
| `cockpit merge` reports unexpected `MISSING` checks | Branch protection lists a check not present on the PR. | Either re-run the missing check, or re-target the PR from a fresh head that triggers it. |
| `warn` line "required-check set derived from PR check list" on stderr | Token lacks `Administration: read` on the repo (Q3 fallback). | Grant the permission to enforce the authoritative required-check set. |
| `cockpit merge` succeeded but exit code is non-zero | Should not happen. Filed against this issue, not a misuse case. | Capture stderr and file a bug. |

## Manual smoke check for SC-001 / SC-004

In `tetrad-development` or a sandbox repo with a green `completed:validate` PR:

```bash
# 1. Drive a PR to green + completed:validate.
gh pr create --base develop --head 1234-fixture --label completed:validate
# (wait for green)

# 2. Manually verify the squash-merge.
generacy cockpit merge 1234
echo "exit=$?"   # should be 0
gh pr view 1234 --json mergedAt   # should be non-null

# 3. Verify review-context payload for the same PR.
generacy cockpit review-context 1234 | jq '.pr.number, .diffTruncated, (.checks | length)'
```

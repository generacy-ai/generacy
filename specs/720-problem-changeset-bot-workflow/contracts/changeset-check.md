# Contract: `Changeset Check` Step

**Feature**: #720 — Make Changeset Bot a Required, Blocking Check
**File**: `.github/workflows/changeset-bot.yml`
**Step name**: `Check for changesets when publishable code changed`

## Inputs (env, injected by GitHub Actions)

| Env var (in step) | Source expression | Required |
|---|---|---|
| `BASE` | `${{ github.event.pull_request.base.sha }}` | Yes |
| `HEAD` | `${{ github.event.pull_request.head.sha }}` | Yes |

## Preconditions

- The job runs under `if: github.event.pull_request.draft == false` (job-level guard, unchanged).
- `actions/checkout@v4` with `fetch-depth: 0` has already populated the working dir with full history.
- `git`, `grep`, `bash` are available on `ubuntu-latest` (default).

## Algorithm (canonical)

```bash
set -euo pipefail

BASE="${{ github.event.pull_request.base.sha }}"
HEAD="${{ github.event.pull_request.head.sha }}"

CHANGED=$(git diff --name-only "$BASE" "$HEAD")

# 1. Path-scoped guard: any change under packages/*/src/?
IN_SCOPE=$(echo "$CHANGED" | grep -E '^packages/[^/]+/src/' || true)
if [ -z "$IN_SCOPE" ]; then
  echo "No publishable-package source files changed; skipping changeset check."
  exit 0
fi

# 2. Test-only short-circuit
IN_SCOPE_NON_TEST=$(echo "$IN_SCOPE" | grep -Ev '(\.(test|spec)\.(ts|tsx)$|/__tests__/)' || true)
if [ -z "$IN_SCOPE_NON_TEST" ]; then
  echo "Only test files changed under packages/*/src/; skipping changeset check."
  exit 0
fi

# 3. Require an ADDED .changeset/*.md in this PR's diff
ADDED_CHANGESETS=$(git diff --name-only --diff-filter=A "$BASE" "$HEAD" -- '.changeset/*.md' | grep -v 'README.md' || true)
if [ -z "$ADDED_CHANGESETS" ]; then
  echo "::error::This PR modifies packages/*/src/ but adds no changeset."
  echo "Run \`pnpm changeset\` from the repo root to add one before merging."
  echo "If this change genuinely doesn't need a version bump (e.g. comment-only,"
  echo "test-only, refactor with no public-API surface), add an empty changeset:"
  echo "  pnpm changeset --empty"
  exit 1
fi

echo "Changeset found in PR diff — ready for release."
```

## Exit Codes

| Code | Meaning |
|---|---|
| 0 | Skipped (no in-scope changes OR test-only) OR passed (changeset added). |
| 1 | Blocked: in-scope non-test changes present, no changeset added in PR diff. |
| Other | Unexpected (e.g., `git diff` failure due to missing fetch-depth). Treated as job failure. |

## Log Lines (stable; do not change without updating quickstart.md)

| Trigger | Log line |
|---|---|
| Skip — no in-scope | `No publishable-package source files changed; skipping changeset check.` |
| Skip — test-only | `Only test files changed under packages/*/src/; skipping changeset check.` |
| Block | `::error::This PR modifies packages/*/src/ but adds no changeset.` (plus follow-up advisory lines) |
| Pass | `Changeset found in PR diff — ready for release.` |

## Workflow-File Diff Summary

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
    branches: [develop, main]    # was: [develop]

jobs:
  changeset-check:
    name: Changeset Check
    runs-on: ubuntu-latest
    if: github.event.pull_request.draft == false
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      # REMOVED: pnpm/action-setup@v4
      # REMOVED: actions/setup-node@v4
      # REMOVED: run: pnpm install --frozen-lockfile
      - name: Check for changesets when publishable code changed
        run: |
          # algorithm above
```

## Required Status Check (manual, post-merge)

In repo Settings → Branches, for branch-protection rules on **both** `develop` and `main`:

- Enable **Require status checks to pass before merging**.
- Add `Changeset Bot / Changeset Check` to the required checks list.

The check name is `<workflow.name> / <job.name>` = `Changeset Bot / Changeset Check`. Must match exactly.

# Quickstart: preValidate degrade + failure evidence (#847)

## What changed for operators

**Before the fix**, `orchestrator` shipped a monorepo-shaped default `preValidateCommand` (`pnpm install && pnpm -r --filter './packages/*' build`). On any single-package project (Next.js/Astro/Vite scaffold) without a per-repo override, the first speckit issue died at pre-validate with no diagnostic evidence on the GitHub issue.

**After the fix**:
1. The default `preValidateCommand` self-degrades: `pnpm install` always runs; the `pnpm -r --filter` build half runs only when both `pnpm-workspace.yaml` and `packages/*/package.json` are present.
2. Any phase failure (pre-validate, CLI phase, validate, product-diff detection) appends an evidence block to the stage comment on the issue: the failing command, the resolved exit descriptor, and the last 30 lines of stderr (capped at 4 KiB).

Per-repo overrides in `.generacy/config.yaml` continue to work byte-identically — a repo with a specific stack still opts into its own commands.

## Verifying Gap A locally (fresh single-package repo)

```bash
# Scaffold a Next.js single-package repo — one-shot:
pnpm create next-app@latest my-app --typescript --eslint --tailwind --src-dir --app --import-alias "@/*"
cd my-app

# Confirm neither pnpm-workspace.yaml nor packages/ exists:
ls pnpm-workspace.yaml packages/ 2>&1 | grep -E "No such file"
# Expected: both listed as missing.

# Trigger one speckit issue through the local orchestrator (via cluster deploy):
generacy up
# Open an issue on the project's GitHub repo with label `process:speckit-feature`
# Wait for the worker to pick it up and reach the validate phase.

# Inspect the stage comment on the issue:
gh issue view <n> --json comments -q '.comments[] | select(.body | contains("Implementation Stage")) | .body'
# Expected: `validate` phase completes (either passes on the real test suite or
# fails on the actual `npm test && npm run build` — NOT on pre-validate).
```

## Verifying Gap B locally (evidence block on failure)

```bash
# Force a validate failure — inject a failing test into the scaffolded project:
cat > src/failing.test.ts <<EOF
import { test, expect } from 'vitest';
test('deliberate failure', () => { expect(1).toBe(2); });
EOF

# Push, open a new issue, wait for validate to fail:
git add . && git commit -m "add failing test" && git push
gh issue create --title "Test evidence surface" --label "process:speckit-feature"

# Inspect the stage comment after failure:
gh issue view <n> --json comments -q '.comments[] | select(.body | contains("Implementation Stage")) | .body'
```

Expected content of the stage comment (excerpt below the horizontal rule):

```markdown
---
**Failed command**: `npm test && npm run build`
**Exit**: exit 1

<details><summary>stderr (last 5 lines)</summary>

​```text
FAIL  src/failing.test.ts > deliberate failure
AssertionError: expected 1 to be 2 // Object.is equality

 ❯ src/failing.test.ts:2:37

Test Files  1 failed | 0 passed (1)
​```

</details>
```

## Verifying the monorepo path still works (regression)

```bash
# In a real monorepo (with pnpm-workspace.yaml + packages/*/package.json):
cd /path/to/monorepo
ls pnpm-workspace.yaml packages/*/package.json
# Expected: both listed.

# Trigger a speckit issue; observe that the pre-validate step runs BOTH halves:
# The worker log shows `pnpm install && … && pnpm -r --filter './packages/*' build`
# succeeding, matching pre-fix behavior byte-for-byte.
```

## Verifying timeout evidence

```bash
# Inject an infinite loop in the test script:
cat > .validate-hang.js <<EOF
setInterval(() => {}, 1000);
EOF
# Point the validate command at it via .generacy/config.yaml:
cat > .generacy/config.yaml <<EOF
project: { id: "proj_test", name: "test" }
repos: { primary: "github.com/me/test" }
orchestrator:
  validateCommand: "node .validate-hang.js"
EOF

# Trigger validate; expect it to time out after DEFAULT_VALIDATE_TIMEOUT_MS (5 minutes):
# The stage comment shows:
#   **Failed command**: `node .validate-hang.js`
#   **Exit**: killed (SIGTERM) after 300000ms
#   stderr (last 1 lines): (stderr empty)  ← literal, since the script produces no stderr
```

## Rolling back a stranded issue (pre-fix bug)

If you have issues stranded from the pre-fix Gap A (`failed:validate` from an unrelated pre-validate death):

```bash
# Add a per-repo override to skip install entirely (or point at your own command):
cat >> .generacy/config.yaml <<EOF
orchestrator:
  preValidateCommand: ""   # skip install; validateCommand does its own work
  validateCommand: "npm test && npm run build"
EOF
git add . && git commit -m "unblock validate" && git push

# Remove the `failed:validate` label to requeue:
gh issue edit <n> --remove-label "failed:validate"
```

## Running the tests

```bash
cd /workspaces/generacy
pnpm --filter @generacy-ai/orchestrator test src/worker/__tests__/config.test.ts
pnpm --filter @generacy-ai/orchestrator test src/worker/__tests__/phase-loop.test.ts
pnpm --filter @generacy-ai/orchestrator test src/worker/__tests__/stage-comment-manager.test.ts
pnpm --filter @generacy-ai/orchestrator test src/worker/__tests__/stderr-tail.test.ts
```

Expected: all pass. The new `stderr-tail.test.ts` includes a 100 MB fuzz (SC-004) that runs in < 1 second.

## Troubleshooting

**Symptom**: `pnpm install` itself fails on a fresh single-package repo (network error, corrupt lockfile).
- **Check**: the stage comment now shows the failing command + `exit N` + stderr tail. Read the stderr.
- **Fix**: run `pnpm install` locally to reproduce; the fix is in the repo, not the orchestrator.

**Symptom**: A repo with `pnpm-workspace.yaml` but non-`packages/*` workspaces (e.g., `apps/*`, `libs/*`) skips its build step.
- **Cause**: intentional — the default targets `packages/*`. Non-`packages/*` layouts always required a per-repo override.
- **Fix**: set `orchestrator.preValidateCommand` in `.generacy/config.yaml` to point at your actual workspace glob.

**Symptom**: The evidence block appears twice in the same comment.
- **Cause**: pre-fix render code left over. Re-check `stage-comment-manager.ts` — the block MUST be emitted only inside `renderStageComment` when `status === 'error'` AND `errorEvidence` is set.
- **Fix**: `git diff` against `develop` for `stage-comment-manager.ts`; ensure no duplicate append.

**Symptom**: stderr in the evidence block is clipped mid-word / mid-line.
- **Cause**: expected under adversarial output — `boundStderrTail` truncates from the start when the last-30-lines slice exceeds 4 KiB. The `… truncated (kept last N lines / M bytes) …` marker at the top of the fenced block indicates truncation happened.
- **Fix**: none. If needed, `docker exec` into the worker for the full stderr (`/tmp/worker.log`).

**Symptom**: The cockpit `failed:validate` classifier no longer recognizes the issue.
- **Cause**: the `**Status**: ❌ Error` line was changed (should NOT happen — regression).
- **Fix**: `git diff` against `develop` for `stage-comment-manager.ts` and confirm the status line is byte-stable. If drifted, restore the pre-fix line and re-run `stage-comment-manager.test.ts` — one of the invariance tests should fail.

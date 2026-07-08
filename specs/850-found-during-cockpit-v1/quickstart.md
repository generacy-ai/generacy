# Quickstart: `cockpit advance` bare-number acceptance & error copy refresh

**Issue**: [generacy-ai/generacy#850](https://github.com/generacy-ai/generacy/issues/850)
**Branch**: `850-found-during-cockpit-v1`

This quickstart walks through reproducing the bug on `develop`, applying the fix locally, and confirming each success criterion.

---

## Prerequisites

- Node.js ≥ 22.
- `pnpm` installed at the repo root.
- A local clone of `generacy-ai/generacy` (this repo). If you are inside `/workspaces/generacy/`, you already have one.
- `gh` CLI authenticated for a repo you can safely open dry-run issues against — optional; only needed for the SC-001 end-to-end check. All grep and unit-test criteria run offline.

Install deps:

```bash
cd /workspaces/generacy
pnpm install
```

---

## 1. Reproduce the bug on `develop` (pre-fix baseline)

Switch to `develop` and try the bare-number invocation:

```bash
git switch develop
pnpm --filter @generacy-ai/generacy build
node packages/generacy/bin/generacy.js cockpit advance 2 --gate implementation-review
```

Expected pre-fix output (fails on ref-parse, references removed config):

```
Error: cockpit advance: parse issue: bare issue number "2" is not accepted — repos are not configured, so a bare number is ambiguous. Use <owner>/<repo>#2 or the full URL.
```

For comparison, a sibling verb accepts the same input:

```bash
node packages/generacy/bin/generacy.js cockpit status 2
# → resolves via cwd origin, shows the issue (or a gh-CLI error if 2 doesn't exist).
```

The grammar skew is the bug.

---

## 2. Apply the fix

```bash
git switch 850-found-during-cockpit-v1
pnpm --filter @generacy-ai/generacy build
```

Expected files changed:

- `packages/generacy/src/cli/commands/cockpit/resolver.ts` — narrowed `parseIssueRef`; FR-002 copy in `resolveIssueContext`.
- `packages/generacy/src/cli/commands/cockpit/advance.ts` — routed through `resolveIssueContext`.
- `packages/generacy/src/cli/commands/cockpit/context.ts` — routed through `resolveIssueContext`.
- `.eslintrc.json` — added FR-006 rule.
- `packages/generacy/src/cli/commands/cockpit/__tests__/resolver.test.ts` — rewritten bare-number test.
- `packages/generacy/src/cli/commands/cockpit/__tests__/advance.test.ts` — new / extended.
- `packages/generacy/src/cli/commands/cockpit/__tests__/context.test.ts` — new / extended.

---

## 3. Verify each success criterion

### SC-001 — bare-number advance succeeds

Run from inside a checkout with a resolvable GitHub origin (this repo is one):

```bash
cd /workspaces/generacy
node packages/generacy/bin/generacy.js cockpit advance 2 --gate implementation-review
```

Exit code MUST be either `0` (advance succeeded) or a non-zero *downstream* code (e.g. `1` for gh IO failure, `3` for gate refusal). It MUST NOT be `2` with a `parse issue: bare issue number` message.

Cross-check with a repo that does NOT have a resolvable GitHub origin (fail-closed path, FR-004):

```bash
mkdir -p /tmp/no-origin && cd /tmp/no-origin && git init >/dev/null
node /workspaces/generacy/packages/generacy/bin/generacy.js cockpit advance 2 --gate implementation-review
```

Expected message (note the accepted-forms enumeration, no removed-config reference):

```
Error: cockpit advance: parse issue: bare issue number "2" is not accepted here. Accepted: <owner>/<repo>#2, a full issue URL, or a bare number inside a checkout with a resolvable GitHub origin. (cwd-origin inference failed: could not infer owner/repo: 'git remote get-url origin' failed (exit 2): error: No such remote 'origin')
```

### SC-002 — `repos are not configured` fully gone

```bash
grep -r "repos are not configured" /workspaces/generacy/packages/generacy/src/
```

Expected: **no output** (grep exits 1). If any hits, fix them here — SC-002 is scoped to the whole of `packages/generacy/src/` per Q3 → A.

### SC-003 — `cockpit.repos` fully gone

```bash
grep -r "cockpit.repos" /workspaces/generacy/packages/generacy/src/
```

Expected: **no output**. Historical spec docs under `specs/` are out of scope per Assumptions.

### SC-004 — no cockpit verb bypasses `resolveIssueContext`

```bash
grep -rn "parseIssueRef" /workspaces/generacy/packages/generacy/src/cli/commands/cockpit/ \
  | grep -v resolver.ts \
  | grep -v __tests__
```

Expected: **no output**. If any file surfaces, either add it to the FR-006 `excludedFiles` list (only for legitimate exemptions) or migrate it to `resolveIssueContext`.

Also verify ESLint enforces the invariant:

```bash
pnpm --filter @generacy-ai/generacy lint
```

Expected: clean.

Intentional-violation smoke test (optional, revert after):

```bash
# Temporarily add `import { parseIssueRef } from './resolver.js';` to advance.ts's import list.
pnpm --filter @generacy-ai/generacy lint
# Expected: eslint fails with the FR-006 rule message naming `resolveIssueContext`.
git checkout packages/generacy/src/cli/commands/cockpit/advance.ts
```

### SC-005 — all resolver tests green

```bash
pnpm --filter @generacy-ai/generacy test -- resolver.test.ts
```

Expected: all tests pass, including:
- `resolveIssueContext` returns for `owner/repo#n` (unchanged).
- `resolveIssueContext` infers repo from git origin URL for a bare number (unchanged).
- `resolveIssueContext` bare-number failure copy asserts the FR-002 template (new / rewritten).
- No test still asserts `repos are not configured`.

Full package test run:

```bash
pnpm --filter @generacy-ai/generacy test
```

Expected: green.

---

## 4. Sibling-verb parity smoke test (US3)

From inside `/workspaces/generacy`:

```bash
for verb in status watch queue advance context merge; do
  echo "=== $verb (bare) ==="
  node packages/generacy/bin/generacy.js cockpit $verb 2 --gate implementation-review 2>&1 | head -1
done
```

Every line SHOULD read either as a successful ref resolution (verb-specific output) or as a downstream error unrelated to the ref grammar. No `parse issue: bare issue number "2" is not accepted` message on any verb.

The exception is `advance` and `context` for which `--gate` may not exist (`context` takes only `<issue>`), and `merge` for which `--gate` is not a flag. This test measures grammar acceptance, not gate/flag correctness.

---

## Troubleshooting

**`Error: cockpit advance: parse issue: bare issue number …` still fires after the fix**
Check that the migrated `advance.ts` imports `resolveIssueContext` (not `parseIssueRef`) and that the built dist reflects the source (`pnpm --filter @generacy-ai/generacy build`).

**Bare number works from `~/some-dir/generacy-clone` but not `/tmp/foo`**
Expected — cwd-origin inference requires `git remote get-url origin` to succeed AND return a GitHub URL. This is the FR-004 fail-closed behavior.

**ESLint rule doesn't fire on a test-file violation**
Expected — `.eslintrc.json`'s existing `**/__tests__/**` override at line 62-71 turns `no-restricted-imports` off for tests, and this feature's `excludedFiles` re-asserts that. The rule targets production code only.

**`pnpm lint` reports the rule schema is invalid**
Fall back to the `patterns[]` form documented in `contracts/eslint-rule.md`. Behaviorally identical for the current call sites.

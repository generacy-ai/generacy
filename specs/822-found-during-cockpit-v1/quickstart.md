# Quickstart: Cockpit CLI status/watch argument-contract drift fix

**Feature**: `822-found-during-cockpit-v1` | **Date**: 2026-07-07

Reproduce the bug, validate the fix, and confirm regression coverage. All commands run from the `generacy` repo root unless noted.

## Reproduce the bug (pre-fix, on `develop`)

```bash
# From /workspaces/generacy (or wherever generacy-ai/generacy is checked out)
git checkout develop
pnpm install
pnpm --filter @generacy-ai/generacy build

# Fails on the flag surface:
node packages/generacy/dist/cli/index.js cockpit status 1
# → error: required option '--epic <ownerRepoIssue>' not specified

node packages/generacy/dist/cli/index.js cockpit status owner/repo#1
# → same error

# Even with --epic, a bare number still fails:
node packages/generacy/dist/cli/index.js cockpit status --epic 1
# → INVALID_EPIC_REF (or resolveEpic parse failure)
```

## Validate the fix

Switch to this feature branch:

```bash
git checkout 822-found-during-cockpit-v1
pnpm install
pnpm --filter @generacy-ai/generacy build
```

### Case 1 — full `owner/repo#N` form (regression guard)

```bash
node packages/generacy/dist/cli/index.js cockpit status generacy-ai/generacy#822
# → renders the epic snapshot table for issue 822 in generacy-ai/generacy
```

### Case 2 — full URL form (regression guard)

```bash
node packages/generacy/dist/cli/index.js cockpit status \
  https://github.com/generacy-ai/generacy/issues/822
# → renders the epic snapshot
```

### Case 3 — bare number in cwd-is-repo scenario (primary use case)

```bash
cd /workspaces/generacy    # cwd origin is generacy-ai/generacy
node packages/generacy/dist/cli/index.js cockpit status 822
# → renders the epic snapshot for generacy-ai/generacy#822
```

### Case 4 — bare number in a directory without a git origin

```bash
cd /tmp
node /path/to/generacy/packages/generacy/dist/cli/index.js cockpit status 1
# → Error: cockpit status: parse issue: could not infer owner/repo: 'git remote get-url origin' failed (exit 128): fatal: not a git repository (or any of the parent directories): .git
# → exit 2
```

### Case 5 — invalid ref

```bash
node packages/generacy/dist/cli/index.js cockpit status not-a-ref
# → Error: cockpit status: parse issue: unrecognized issue ref "not-a-ref". Use <n>, <owner>/<repo>#<n>, or https://github.com/<owner>/<repo>/issues/<n>.
# → exit 2
```

### Case 6 — `watch` accepts the same grammar

```bash
node packages/generacy/dist/cli/index.js cockpit watch 822
# → cockpit watch: epic generacy-ai/generacy#822; repos [...]; interval=30000ms
# → (streams NDJSON on state transitions; Ctrl+C to exit)
```

### Case 7 — `queue` accepts the same grammar, argument surface unchanged

```bash
# Byte-identical old invocation still works:
node packages/generacy/dist/cli/index.js cockpit queue \
  generacy-ai/generacy#822 implement
# → renders preview

# NEW: bare number works too (US2, SC-004):
node packages/generacy/dist/cli/index.js cockpit queue 822 implement
# → renders preview for the same epic
```

## Test suite

```bash
pnpm --filter @generacy-ai/generacy test packages/generacy/src/cli/commands/cockpit
```

Watch specifically the test files touched by this fix:

- `__tests__/resolver.test.ts` — parseIssueRef error message, resolveIssueContext bare-number+origin path.
- `__tests__/status.test.ts` — signature migration + bare-number + INVALID_EPIC_REF exit shape.
- `__tests__/watch.test.ts` — same, plus regression-guard: bare-number inference does NOT re-fire per poll.
- `__tests__/queue.test.ts` — `runQueue(1, 'implement', …)` + injected runner succeeds.

## Success criteria checks

Direct grep-based checks from spec §Success Criteria:

**SC-001 / SC-002**: `/cockpit:status <ref>` and `/cockpit:watch <ref>` no longer fail at Commander parsing.

```bash
# All exit 0 (or a non-parse error) — none exit 2 with "required option '--epic'":
for ref in 822 generacy-ai/generacy#822 https://github.com/generacy-ai/generacy/issues/822; do
  node packages/generacy/dist/cli/index.js cockpit status "$ref" --json 1>/dev/null
  echo "status $ref → exit $?"
  node packages/generacy/dist/cli/index.js cockpit watch "$ref" --interval 15000 &
  WATCH_PID=$!
  sleep 2 && kill $WATCH_PID 2>/dev/null
  echo "watch $ref → started OK"
done
```

**SC-003**: single parsing entrypoint. Grep-based sanity check:

```bash
# 0 --epic references in the cockpit command dir:
grep -rn -F '"--epic"' packages/generacy/src/cli/commands/cockpit/ || echo "clean"
grep -rn -F "'--epic'" packages/generacy/src/cli/commands/cockpit/ || echo "clean"

# No direct parseIssueRef( or resolveEpic({ epicRef calls in status/watch/queue
# that bypass resolveIssueContext (aside from the wrapped call inside resolveIssueContext itself):
grep -n "resolveEpic\|parseIssueRef" \
  packages/generacy/src/cli/commands/cockpit/status.ts \
  packages/generacy/src/cli/commands/cockpit/watch.ts \
  packages/generacy/src/cli/commands/cockpit/queue.ts
# → Each verb: 1 resolveIssueContext call, 1 resolveEpic call (with the expanded ref). No direct parseIssueRef.
```

**SC-004**: bare-number invocation in cwd-is-repo scenario succeeds. Covered by Case 3 above.

**SC-005**: plugin markdown untouched. Covered by grep in `claude-plugin-cockpit` — no diff in `status.md` or `watch.md`.

## Troubleshooting

**`error: unknown option '--epic'`** — the fix is working. Update any scripts that pass `--epic` to use positional refs instead. Pre-1.0, no compat shim (spec §Out-of-Scope).

**`cockpit status: parse issue: could not infer owner/repo …`** — you are in a directory without a git origin. Either:
- `cd` into a git working tree with an `origin` remote pointing at GitHub, or
- use the explicit `<owner>/<repo>#<n>` form.

**Bare number resolves to the wrong repo** — session cwd is the single source of truth (Q5→A). If cwd's origin is not the repo you want, use `<owner>/<repo>#<n>` in the ref itself. No `--repo` override flag exists on `status`/`watch` (deliberately).

**`queue` `--repo` flag is confusing** — `queue`'s `--repo` means *enqueue target*, not ref-resolution override. Naming-overload cleanup is a separate later issue (Q5→A, spec §Out-of-Scope).

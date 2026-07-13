# Quickstart: Cockpit CLI identity resolution

Local validation walkthrough for issue #830 — verifies that `generacy cockpit queue` and `generacy cockpit advance` no longer call `gh api user` on the happy path for GitHub App-credentialed clusters, and that the failure copy names all four knobs.

## Prerequisites

- Repo checked out with the `830-found-during-cockpit-v1` branch active.
- Node.js >=22 (matches `packages/generacy` `engines.node`).
- `pnpm install` at the repo root.
- `gh` CLI installed (used by the tier-3 fallback and by underlying `GhCliWrapper` calls in tests).

## Build

```bash
pnpm install
pnpm --filter @generacy-ai/cockpit build
pnpm --filter @generacy-ai/generacy build
```

## Run the new unit tests

```bash
# Helper — precedence + failure modes
pnpm --filter @generacy-ai/generacy test packages/generacy/src/cli/commands/cockpit/__tests__/shared/identity.test.ts

# Queue / advance — App-credentialed happy path + missing-all
pnpm --filter @generacy-ai/generacy test packages/generacy/src/cli/commands/cockpit/__tests__/queue.test.ts
pnpm --filter @generacy-ai/generacy test packages/generacy/src/cli/commands/cockpit/__tests__/advance.test.ts

# Marker — optional actor rendering
pnpm --filter @generacy-ai/generacy test packages/generacy/src/cli/commands/cockpit/__tests__/manual-advance-marker.test.ts

# Cockpit config — assignee field round-trip
pnpm --filter @generacy-ai/cockpit test packages/cockpit/src/__tests__/config/loader.test.ts
```

## SC-003 grep guard

```bash
# Must return exactly ONE match — the helper's tier-3 call inside shared/identity.ts.
rg 'getCurrentUser|gh api user' packages/generacy/src/cli/commands/cockpit/
```

## Manual smoke — SC-001 (queue on App-credentialed cluster)

Assumes staging cluster reachable, `gh` auth configured with a GitHub App installation token, and `CLUSTER_GITHUB_USERNAME` exported by cluster-base.

```bash
# Baseline (pre-fix): expect 403
CLUSTER_GITHUB_USERNAME=christrudelpw \
  GH_DEBUG=api generacy cockpit queue <epic> P1 2>&1 | tee /tmp/queue-before.log
grep -c 'gh api user' /tmp/queue-before.log
# expected count: >= 1

# With fix: no `gh api user` call, exits 0
CLUSTER_GITHUB_USERNAME=christrudelpw \
  GH_DEBUG=api generacy cockpit queue <epic> P1 2>&1 | tee /tmp/queue-after.log
grep -c 'gh api user' /tmp/queue-after.log
# expected count: 0

# Assignee resolves from CLUSTER_GITHUB_USERNAME
grep 'assignee: christrudelpw' /tmp/queue-after.log
```

Repeat with only `GH_USERNAME` set (Q1→A verification):

```bash
unset CLUSTER_GITHUB_USERNAME
GH_USERNAME=christrudelpw \
  GH_DEBUG=api generacy cockpit queue <epic> P1 2>&1 | grep -c 'gh api user'
# expected count: 0
```

## Manual smoke — SC-002 (advance on App-credentialed cluster, no identity)

```bash
unset CLUSTER_GITHUB_USERNAME
unset GH_USERNAME

generacy cockpit advance <issue-ref> --gate clarification 2>&1 | tee /tmp/advance.log

# Exit 0
echo $?
# expected: 0

# Warning names all four knobs
grep -E '(--assignee|cockpit\.assignee|CLUSTER_GITHUB_USERNAME|GH_USERNAME)' /tmp/advance.log
# expected: >= 4 matches

# Label was applied — check on GitHub
gh issue view <issue-ref> --json labels | jq '.labels[].name' | grep 'advanced:clarification'
# expected: 'advanced:clarification' listed

# Comment omits actor line
gh issue view <issue-ref> --json comments | jq '.comments[-1].body' | grep -c 'by \*\*@'
# expected count: 0 (no "by @…" fragment)
```

## Manual smoke — SC-004 (failure copy on queue)

```bash
unset CLUSTER_GITHUB_USERNAME
unset GH_USERNAME
# ensure `gh auth` is unavailable OR `gh api user` returns 403 (App token)

generacy cockpit queue <epic> P1 2>&1 | tee /tmp/queue-fail.log
echo $?
# expected: non-zero (1)

# Message names all four knobs
grep -E '(--assignee|cockpit\.assignee|CLUSTER_GITHUB_USERNAME|GH_USERNAME)' /tmp/queue-fail.log | wc -l
# expected: 4
```

## Config-driven identity (Q2→A, FR-007)

Author a `.generacy/config.yaml` at the repo root:

```yaml
cockpit:
  assignee: christrudelpw
```

Then:

```bash
unset CLUSTER_GITHUB_USERNAME
unset GH_USERNAME

# Config wins over env (both unset), flag beats config
generacy cockpit queue <epic> P1                                         # uses config → christrudelpw
generacy cockpit queue <epic> P1 --assignee dorothea                     # uses flag  → dorothea
```

## FR-006 investigation (runtime deliverable)

The FR-006 investigation is a manual step, not a code path:

1. Grep `packages/orchestrator/src/services/webhooks.ts` for its no-assignee guard.
2. Grep `smee-receiver` (in `packages/smee-receiver/` or the tetrad-development repo) for its skip path.
3. Compare the two. Post a comment on [issue #830](https://github.com/generacy-ai/generacy/issues/830) tagged `"FR-006 investigation"` with the finding — both the "no divergence" and "divergence found" branches record a comment. If divergence is found, file a follow-up issue and link it from the comment.

## Troubleshooting

- **`Error: cockpit queue: unable to resolve GitHub identity.`** — Expected when no source resolves. Set `--assignee`, `cockpit.assignee`, `CLUSTER_GITHUB_USERNAME`, or `GH_USERNAME`. This is exactly the failure copy SC-004 asserts.
- **`gh api user` still runs on happy path** — Check `CLUSTER_GITHUB_USERNAME` and `GH_USERNAME` are actually exported (`printenv | grep -E '^(CLUSTER_GITHUB_USERNAME|GH_USERNAME)='`). If both are unset, the resolver reaches tier 3 by design.
- **`cockpit advance` throws instead of degrading** — Confirm `advance.ts` calls the helper with `mode: 'optional'`. Required-mode throws; optional-mode logs and returns `undefined`.
- **`cockpit queue` says "invalid --assignee"** — This is the pre-existing `LOGIN_REGEX` check at `queue.ts:212`, not the new helper. GitHub logins are `[A-Za-z0-9-]+`.
- **Marker comment shows `actor=undefined`** — The formatter change was missed; `actor` must be entirely omitted from the HTML comment attribute list when not provided. See `contracts/manual-advance-marker.md`.

## Available Commands (post-fix)

- `generacy cockpit queue <epic-ref> <phase> [--assignee <login>]` — Queue eligible refs. Assignee resolved via 5-tier precedence; explicit failure if all miss.
- `generacy cockpit advance <issue-ref> --gate <name>` — Advance a gate. Actor resolved via 5-tier precedence; omits actor line + warns if all miss.
- (No new user-facing command shape.)

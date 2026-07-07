# Quickstart — #839

## Reproduce the bug (pre-fix)

Against the current `develop` code, on a machine with `gh` authenticated and a real epic whose children are all sitting at `waiting-for:clarification`:

```bash
# From the generacy repo root
pnpm --filter @generacy-ai/generacy build

# Terminal 1 — queue the phase
node packages/generacy/dist/bin/generacy.js cockpit queue <owner>/<repo>#<epic-n> clarify

# Wait until all children carry `waiting-for:clarification` (~30–60 s).
# Confirm via:
node packages/generacy/dist/bin/generacy.js cockpit status <owner>/<repo>#<epic-n>

# Terminal 2 — attach a fresh watcher and observe
node packages/generacy/dist/bin/generacy.js cockpit watch <owner>/<repo>#<epic-n>
```

Expected on the buggy build: the watcher prints its startup line to stderr and then goes silent. Every child issue is sitting at `waiting-for:clarification` but you see nothing. The developer has to run `cockpit status` to discover the backlog.

## Verify the fix (post-fix)

Same command sequence. Expected: within one poll cycle after `cockpit watch` starts, one NDJSON line per pending child appears on stdout, each carrying `"initial": true`:

```json
{"ts":"2026-07-07T...","repo":"...","kind":"issue","number":2,"from":null,"to":"waiting","sourceLabel":"waiting-for:clarification","url":"...","event":"label-change","labels":[...],"initial":true}
```

The `/cockpit:watch` plugin renders each as a notification without any plugin change (FR-007). Subsequent transitions on polls 2..N emit the same wire shape *without* the `initial` field (byte-identical to today's behavior).

## Manual smoke tests

### SC-003 — Watcher restart re-surfaces still-pending items

```bash
# Terminal 2 — run watcher
node packages/generacy/dist/bin/generacy.js cockpit watch <owner>/<repo>#<epic-n>
# ...one initial line per pending child prints...
# Ctrl-C
# Same command again:
node packages/generacy/dist/bin/generacy.js cockpit watch <owner>/<repo>#<epic-n>
# ...same initial lines print again (this is desired — sensor is stateless per run).
```

### SC-002 — Non-actionable baseline stays silent

Against an epic whose children are all `phase:plan` / `agent:in-progress` / `type:*`:

```bash
node packages/generacy/dist/bin/generacy.js cockpit watch <owner>/<repo>#<epic-n>
# Expected: startup line only. No NDJSON lines emitted at first poll.
```

### SC-009 — Red-CI PR at baseline

Against an epic that references a PR whose `checksRollup === 'failure'` and whose labels do NOT include any `failed:*` entry:

```bash
node packages/generacy/dist/bin/generacy.js cockpit watch <owner>/<repo>#<epic-n>
# Expected: one initial line for the PR.
```

## Run the regression tests

```bash
# Diff-level unit tests
pnpm --filter @generacy-ai/generacy test -- watch.diff

# Schema/emit tests
pnpm --filter @generacy-ai/generacy test -- watch.emit

# Actionable predicate tests
pnpm --filter @generacy-ai/generacy test -- watch.actionable

# All watcher tests
pnpm --filter @generacy-ai/generacy test -- watch
```

All should pass in ~1–3 s. The `watch.diff.test.ts` suite contains the SC-007 (`completed:specify` + `waiting-for:clarification` co-occurrence) and SC-009 (red-CI PR) regression guards.

## Grep-based SC-006 check

The list of actionable labels/states appears in exactly one file:

```bash
# Should return only actionable.ts (and the test file for it):
grep -rn "'completed:validate'" packages/generacy/src

# Should return no hits under packages/generacy/src/cli/commands/cockpit/watch/
# other than actionable.ts:
grep -rn "'waiting-for:'" packages/generacy/src/cli/commands/cockpit/watch/
```

## Troubleshooting

- **Watcher starts but no `initial: true` lines appear** — Confirm the epic children actually carry an actionable label (`gh issue view <owner>/<repo>#<n> --json labels`). If they're all `phase:*` / `agent:in-progress`, the sweep correctly stays silent (SC-002 behavior).
- **Emitted `to`/`sourceLabel` says `terminal` / `completed:specify` even though the developer expected `waiting`** — This is the tier-precedence bug in the classifier (Q2 counterexample), filed separately. The fact that the *line was emitted at all* is #839's fix. The `labels[]` array on the wire will still show the co-existing `waiting-for:clarification` — that's how a consumer can disambiguate today.
- **`CockpitEventSchema.parse` throws with `Invalid literal value, expected true`** — a producer somewhere is emitting `initial: false`. Grep the codebase and remove it — the schema rejects that shape deliberately (D3 / SC-005).
- **Regression test flakes** — the diff-level tests are pure over `SnapshotMap` fixtures; there is no I/O. If a flake is real, check `Date.now()` usage in `computeTransitions` — the `now` param is stub-injectable and the tests must inject it (see the existing `ts` stub pattern in `watch.diff.test.ts`).

## Rollback

The change is additive and safe to revert. Revert the following files in one commit:

- `packages/generacy/src/cli/commands/cockpit/watch/diff.ts`
- `packages/generacy/src/cli/commands/cockpit/watch/emit.ts`
- `packages/generacy/src/cli/commands/cockpit/watch/actionable.ts` (new — delete)
- `packages/generacy/src/cli/commands/cockpit/__tests__/watch.actionable.test.ts` (new — delete)
- Adjustments to `packages/generacy/src/cli/commands/cockpit/__tests__/watch.diff.test.ts` and `watch.emit.test.ts`

After rollback, the watcher returns to its silent-first-poll behavior. No persisted state or schema migration involved.

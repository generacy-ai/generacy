# Quickstart: Dependency-Blocked Implement Pause

Operator guide for the engine-native dependency pause (#1211).

## What a dependency block looks like

When the implement agent determines it cannot proceed until sibling issues/PRs close, it emits the `SPECKIT_IMPLEMENT_BLOCKED` sentinel. The engine then:

- Commits and pushes any in-progress work to the issue's branch/PR.
- Posts a comment on the issue:
  > **Implementation paused — waiting on dependencies** (with the list of blocking refs)
- Applies labels: `waiting-for:dependencies` + `agent:paused`.
- The issue shows as a waiting gate in `cockpit status` / `cockpit watch`.

No `failed:implement`, no `agent:error` — this is a deliberate pause, not a failure.

## Automatic resume

The `DependencyMonitorService` polls issues carrying `waiting-for:dependencies`. When **every** listed ref is closed (issues closed for any reason; PRs closed or merged), it:

1. Posts a "Dependencies resolved — resuming implementation" comment. Refs closed as **not planned** or PRs **closed without merging** are flagged with ⚠ — check those manually; the resumed implement phase will re-verify and re-pause if genuinely still blocked.
2. Applies `completed:dependencies` and re-enqueues the issue.

Resume happens within one poll cycle of the last dependency closing.

## Manual override

If a ref is wrong, inaccessible, or you want to proceed anyway:

```bash
generacy cockpit advance <owner>/<repo>#<issue> --gate dependencies
```

or add the `completed:dependencies` label by hand.

## Cycle cap (3 blocks)

An issue may pause on dependencies at most **3 times** per grant. On the 4th attempt the engine escalates instead of silently re-pausing:

- Comment: **Dependency-block limit reached (3 cycles)** listing what's still open.
- Label: `waiting-for:dependency-limit` (operator-only gate).

To grant another round of 3 cycles:

```bash
generacy cockpit advance <owner>/<repo>#<issue> --gate dependency-limit
```

or add `completed:dependency-limit` by hand. The next cap breach posts a fresh limit comment, which resets the counting baseline.

## Troubleshooting: unreadable refs

If the monitor cannot read a ref's state (deleted issue, renamed repo, token lacks access), it retries quietly. After **3 consecutive failures** on the same ref it posts:

> **Cannot verify dependency state** — `owner/repo#N` has failed 3 consecutive reads…

The gate stays held and retries continue. Fix options:

- Grant token access / correct the repo — the next successful read resets the failure counter.
- If the ref is simply wrong, advance the gate manually (`cockpit advance --gate dependencies`); the resumed implement phase re-checks and re-emits the sentinel with corrected refs if still blocked.

## Where state lives

Everything is on GitHub — marker comments and labels. No Redis keys, no disk files. Blocks survive cluster restarts by days; a `compose down` loses nothing.

## Ref formats the agent may emit

- `owner/repo#123` (canonical)
- `#123` or `123` (same repo as the blocked issue)

Persisted comments always show the canonical form.

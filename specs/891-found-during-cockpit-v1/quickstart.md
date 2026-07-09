# Quickstart: `cockpit resume <issue-ref>`

## What this ships

A new subcommand under the `generacy cockpit` group that re-arms a failed phase on a GitHub issue so the label-monitor's next poll enqueues the issue and the worker resumes the failed phase in place — no restart from `specify`.

## Prerequisites

- Node.js >=22 (repo standard).
- The `@generacy-ai/generacy` package built (`pnpm --filter @generacy-ai/generacy build`).
- `gh` CLI authenticated and able to read/write labels on the target repo.
- The target issue's cluster must be running the label-monitor (`label-monitor-service.ts`) — the verb writes labels, the monitor picks them up.

## Installation

The verb ships as part of the existing `@generacy-ai/generacy` package. No new install step:

```bash
pnpm install
pnpm --filter @generacy-ai/generacy build
```

Once the branch merges, users on the release channel pick it up via the normal `generacy` CLI upgrade path.

## Usage — happy path

Recover an issue stuck at `failed:validate`:

```bash
generacy cockpit resume generacy-ai/generacy#42
```

Expected output:

```
resumed generacy-ai/generacy#42: re-armed phase=validate via preceding-gate=implementation-review; added=[waiting-for:implementation-review,completed:implementation-review,agent:paused] removed=[failed:validate,agent:error]
```

Exit code: `0`.

**Wait ~30-60 seconds** for the label-monitor's next poll cycle (default poll interval is workflow-config dependent). The monitor will:

1. See `waiting-for:implementation-review` + `completed:implementation-review` pair (per `label-monitor-service.ts:157-179`).
2. Emit a `resume`-type `LabelEvent`.
3. Enqueue the issue with `command: 'continue'`.

The worker then:

1. Runs `LabelManager.onResumeStart` which strips the `waiting-for:*`, `completed:<gate>` pair, and `agent:paused`.
2. `PhaseResolver.resolveStartPhase(labels, 'continue', 'speckit-feature')` walks the preserved `completed:*` chain and returns `'validate'`.
3. Validate phase re-runs.

## Usage — bare-number ref

Inside a checkout of the target repo:

```bash
cd ~/code/generacy
generacy cockpit resume 42
```

The verb infers `owner/repo` from `git remote get-url origin` (same behavior as `cockpit advance`).

## Usage — full URL

```bash
generacy cockpit resume https://github.com/generacy-ai/generacy/issues/42
```

## Idempotent and safe

Running the command on a non-failed issue is a no-op:

```bash
$ generacy cockpit resume generacy-ai/generacy#41
issue generacy-ai/generacy#41 is not in a failed state (no failed:<phase> label); nothing to re-arm
$ echo $?
0
```

Re-running on an already-re-armed issue is also a no-op — the failed set is gone, so the classifier bails immediately.

## Refusal paths

The verb refuses (exit 3, no partial mutation) when the state is ambiguous or non-re-armable:

**Multiple `failed:*` labels** — the operator must resolve which one:

```
$ generacy cockpit resume generacy-ai/generacy#44
Error: cockpit resume: multiple failed:* labels present: [failed:tasks, failed:validate]
```

**No preceding gate** (`failed:specify` or `failed:plan`) — re-queue is the only path:

```
$ generacy cockpit resume generacy-ai/generacy#43
Error: cockpit resume: phase "specify" has no preceding gate; use `process:speckit-feature` label to re-queue from the beginning instead
```

**Conflicting `waiting-for:*`** — issue is already in a waiting state on a different gate:

```
$ generacy cockpit resume generacy-ai/generacy#45
Error: cockpit resume: conflicting waiting-for:plan-review already present; derived preceding-gate is tasks-review
```

## Available cockpit commands (post-#891)

```
generacy cockpit --help
```

Lists (post-merge):

```
Commands:
  watch     — poll an epic's issues/PRs and emit cockpit events on state changes
  status    — render a grouped, colorized table of the epic's current state
  advance   — manually advance a waiting gate (flip waiting-for → completed)
  context   — classify the current waiting-for:* gate and emit its bundle
  merge     — merge a PR once its required checks are green
  queue     — enqueue eligible refs under a phase heading to the cluster pipeline
  resume    — re-arm a failed phase so the monitor re-queues it in place  ← NEW
```

## Troubleshooting

**"unknown phase" error**: The verb rejects `failed:<phase>` where `<phase>` isn't a `WorkflowPhase` (`specify | clarify | plan | tasks | implement | validate`). If you see this, the label set has a stale or manually-applied label — inspect with `gh issue view <n> --json labels`.

**"no preceding gate" error**: `failed:specify` and `failed:plan` have no gate that maps back to them. Recovery for these is a `process:*` re-queue (removes and re-adds the `process:<workflow>` trigger label, restarting from the beginning). This is by-design: `resume` is the mechanical primitive for in-place recovery; a full re-queue is a different intent.

**Issue doesn't re-enqueue after `resume`**: Check the label-monitor's log for the poll cycle following your `resume` call. If the monitor didn't see the pair, verify:
1. `waiting-for:<preceding-gate>` AND `completed:<preceding-gate>` are BOTH on the issue (a partial failure would only add some).
2. The monitor is actually running (`orchestrator` service healthy).
3. No `blocked:*` label is on the issue (the monitor may skip blocked issues in some workflows).

**`gh` API failure mid-sequence**: The verb applies additions first, then removals. A mid-sequence failure leaves the issue "over-labeled" (both `failed:<phase>` and the resume pair present). Re-running `resume` is safe: the classifier will see the still-present `failed:<phase>` and re-apply — additions are idempotent on GitHub's side, and the second run cleans up the failed set.

**"conflicting waiting-for:*" on a stale issue**: If an issue was manually left with `waiting-for:<other-gate>` from an earlier flow (e.g. spec-review that was never advanced), remove it first with `gh issue edit <n> --remove-label waiting-for:<other-gate>` and re-run `resume`.

## Related verbs

- **`cockpit advance --gate <name>`** — flip `waiting-for:<gate>` → `completed:<gate>` on a naturally-paused issue. Use when the issue is at a review gate and you're the reviewer signing off.
- **`process:speckit-feature` re-queue** — restart from `specify`. Use when the issue's prior artifacts are stale or wrong, not just the last phase.
- **`cockpit status`** — grouped table showing where every issue in an epic is. Read before you `resume` to confirm the current label set.

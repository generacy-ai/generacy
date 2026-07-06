# Contract: CLI verbs (watch / status / queue)

Package: `packages/generacy/src/cli/commands/cockpit/`.

## `generacy cockpit watch --epic <owner/repo#N> [--interval <ms>] [--safety-cap <n>]`

### Options

| Option | Default | Notes |
|---|---|---|
| `--epic <ref>` | (required) | Format `owner/repo#N`. |
| `--interval <ms>` | `30000` | Floor `15000`. Below-floor → `stderr` warn + clamp + continue (FR-007, Q4). |
| `--safety-cap <n>` | `1000` | Warn when per-poll item count exceeds this (unchanged). |

`--repos` is removed. Passing it produces a Commander unknown-option error (exit 1).

### Behavior

- Every tick: `resolveEpic()` → `runOnePoll(prev, { gh, refs })`.
- Repos derive from the resolved refs (no config lookup).
- On resolver error mid-run: log to `stderr`, skip the tick, sleep, retry. Do not exit.
- On `resolveEpic` throwing at startup: exit `1` with the error message (SC-003).

### Exit codes

- `0` — clean shutdown via SIGINT/SIGTERM.
- `1` — startup resolver error or unrecoverable poll error.
- `2` — malformed `--epic` value.

## `generacy cockpit status --epic <owner/repo#N> [--json]`

### Options

| Option | Default | Notes |
|---|---|---|
| `--epic <ref>` | (required) | Format `owner/repo#N`. |
| `--json` | `false` | Emit a single-line JSON envelope, disable color. |

`--repos` is removed. Same Commander behavior as `watch`.

### Behavior

- Call `resolveEpic()` once.
- Batch the resolved refs per repo and issue the existing per-repo `gh` listing (no change).
- Render the grouped table (or JSON envelope).

### Exit codes

- `0` — success.
- `1` — resolver error.
- `2` — malformed `--epic`.

## `generacy cockpit queue <epic-ref> <phase> [--label <name>] [--repo <owner/repo>] [--assignee <login>] [--yes]`

### Positional args

- `<epic-ref>` — `owner/repo#N` (required).
- `<phase>` — phase token to match (FR-005). Required.

### Options

| Option | Default | Notes |
|---|---|---|
| `--label <name>` | `process:speckit-feature` | Overrides the default workflow label. |
| `--repo <owner/repo>` | (unset) | Restrict enqueue to a single repo when refs span repos. |
| `--assignee <login>` | current gh user | Passed unchanged to `gh issue edit`. |
| `--yes` | `false` | Skip confirmation prompt. |

### Behavior

- `resolveEpic(epic-ref)` → `matchPhaseHeading(phaseArg)`.
- Enqueue candidates = `matchedPhase.refs` (Q2 A: refs listed under the matched heading, deduped within the heading).
- Existing eligibility logic reused: closed / already-labeled refs skipped at preview.
- `--label` value is validated by the existing regex (must be a valid GitHub label name).

### Exit codes

- `0` — success (queue applied or nothing to queue).
- `1` — mutation error on at least one row, or resolver error.
- `2` — `INVALID_EPIC_REF`, `PHASE_NOT_FOUND`, or `AMBIGUOUS_PHASE_TOKEN`.

## Removed CLI surface

- `generacy cockpit manifest init` — gone.
- `generacy cockpit manifest sync` — gone.
- `--repos <list>` on `watch` / `status` — gone.

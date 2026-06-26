# CLI Surface Contract

This contract pins the exact Commander.js surface for `generacy cockpit` and its three subcommands. Stability target: SemVer minor (we may add flags; we may not remove or rename without a deprecation cycle).

## `generacy cockpit`

```
Usage: generacy cockpit [options] [command]

Cockpit — inspect and drive workflow state for one issue.

Options:
  -h, --help                  display help for command

Commands:
  state <issue> [options]     Classify one issue's current cockpit state.
  advance <issue> [options]   Manually advance a gated issue.
  clarify-context <issue>     Gather clarification context as JSON.
```

## `generacy cockpit state <issue>`

```
Usage: generacy cockpit state [options] <issue>

Classify one issue's current cockpit state and print the source label.

Arguments:
  <issue>                     Issue ref — <number>, <owner>/<repo>#<n>, or full URL.

Options:
  --json                      Emit machine-readable JSON instead of a text line.
  -h, --help                  display help for command

Exit codes:
  0   Success — classification printed.
  1   Issue not found, gh auth failure, or other operational error.
  2   Bad usage — ambiguous bare-number ref, invalid URL format.
```

**stdout (text mode)**: One line: `<owner>/<repo>#<n>  <state>  <sourceLabel>` (two-space separated; columns left-aligned).
**stdout (`--json`)**: One JSON object matching `state-output.schema.json`.
**stderr**: Log lines (pino), errors.

## `generacy cockpit advance <issue> --gate <name>`

```
Usage: generacy cockpit advance [options] <issue>

Manually advance a gated issue by flipping waiting-for:<gate> → completed:<gate>.

Arguments:
  <issue>                     Issue ref — <number>, <owner>/<repo>#<n>, or full URL.

Options:
  --gate <name>               Required. Gate name (e.g. "clarification", "plan-review").
                              Pass --help-gates to list all valid gate names.
  --help-gates                Print the list of valid gate names and exit 0.
  -h, --help                  display help for command

Exit codes:
  0   Success — completed:<gate> added; waiting-for:<gate> removed; comment posted.
      Also 0 when issue already has completed:<gate> (idempotent — no-op message on stdout).
  1   Operational error (gh auth, 404, network).
  2   Bad usage — unknown gate, missing --gate, ambiguous bare-number ref.
  3   Workflow refusal — gate is not the issue's active waiting-for:* (no --force in v1).
```

**stdout**: Short human-readable line:
- Success: `advanced owner/repo#123: waiting-for:clarification → completed:clarification (comment: <url>)`
- Already-advanced: `already advanced owner/repo#123: completed:clarification is present (no-op)`
- Refusal (exit 3): `refusing to advance gate "plan-review": active waiting gate is "clarification"`
- Unknown gate (exit 2): `unknown gate "clarificaton". Valid gates: clarification, clarification-review, ...`

**stderr**: Log lines, error details.

**Side effects on GitHub** (in order, fail-fast — partial failures DO leave the issue in an inconsistent state, which is then visible via `cockpit state` re-run):
1. `gh issue comment <n> --repo <r> --body <manual-advance-comment>`
2. `gh issue edit <n> --repo <r> --add-label completed:<gate>`
3. `gh issue edit <n> --repo <r> --remove-label waiting-for:<gate>`

If step 2 succeeds but step 3 fails, the issue has both `waiting-for:<gate>` and `completed:<gate>`. The classifier's tier-rank rule (`terminal > waiting`) means downstream tools see it as "advanced" anyway; a subsequent `cockpit advance` re-run is idempotent and will retry the removal.

## `generacy cockpit clarify-context <issue>`

```
Usage: generacy cockpit clarify-context [options] <issue>

Emit JSON containing the clarification comment, spec.md, plan.md, and code references.

Arguments:
  <issue>                     Issue ref — <number>, <owner>/<repo>#<n>, or full URL.

Options:
  -h, --help                  display help for command

Exit codes:
  0   Success — JSON emitted to stdout.
  1   Operational error (gh auth, 404, network, JSON serialization).
  2   Bad usage — ambiguous bare-number ref.
  3   Workflow refusal — issue is not in waiting-for:clarification state.
```

**stdout**: Exactly one JSON document matching `clarify-context-output.schema.json`, no trailing newline beyond the one Node adds.
**stderr**: All log lines, all errors.

**Critical**: Nothing other than the JSON document is allowed on stdout. Integration tests pipe stdout into `JSON.parse()`.

## Error Message Conventions

All non-zero exits print one line to stderr in this shape, matching the rest of the generacy CLI:

```
Error: <verb-name>: <step that failed>: <reason>
```

Examples:
- `Error: cockpit state: gh issue view: not authenticated (gh auth login)`
- `Error: cockpit advance: gh issue edit: repo "owner/repo" not found or no access`
- `Error: cockpit clarify-context: spec lookup: branch "main" has no specs/ directory`

The leading `Error: ` is prepended by `setupErrorHandlers()` in `cli/utils/error-handler.ts`. Stack traces are emitted only when `DEBUG=1`.

## Stability

Frozen after this issue lands. Changes require a SemVer bump on `@generacy-ai/generacy` and a follow-up issue with the rationale. The JSON output schemas (`state-output.schema.json`, `clarify-context-output.schema.json`) are the contract for downstream tooling; any field rename/removal must be considered a breaking change.

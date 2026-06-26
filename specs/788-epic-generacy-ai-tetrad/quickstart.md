# Quickstart: `generacy cockpit` — state / advance / clarify-context

Once #788 lands, these three verbs are available under the `cockpit` subcommand of the existing `generacy` CLI.

## Install / Build

From the repo root:

```bash
pnpm install
pnpm --filter @generacy-ai/generacy build
```

For local development, use the workspace-linked dev binary:

```bash
node packages/generacy/dist/cli/bin/generacy.js cockpit --help
```

(or, after `pnpm install`, `pnpm exec generacy cockpit --help`.)

## Prerequisites

1. **`gh` CLI authenticated** with read+write access to the target repo:
   ```bash
   gh auth status
   gh auth login   # if not authenticated
   ```
2. **`.generacy/config.yaml`** (optional) — a `cockpit:` block declaring monitored repos:
   ```yaml
   cockpit:
     repos:
       - generacy-ai/generacy
   ```
   Without this, you must always pass the full `<owner>/<repo>#<number>` form. With one repo configured, you can use the bare `<number>` form (AD-5).
3. **`git`** on PATH — `clarify-context` needs `git branch --show-current` and `git diff` to locate the spec dir and discover touched files.

## Usage Examples

### 1. Classify an issue

```bash
# Bare number (requires single repo in config)
generacy cockpit state 788

# Output (text mode):
#   generacy-ai/generacy#788  waiting  waiting-for:clarification

# JSON mode for piping
generacy cockpit state 788 --json | jq .
# {
#   "issue": "generacy-ai/generacy#788",
#   "state": "waiting",
#   "sourceLabel": "waiting-for:clarification"
# }

# Fully-qualified ref always works
generacy cockpit state generacy-ai/generacy#788
generacy cockpit state https://github.com/generacy-ai/generacy/issues/788
```

### 2. Advance a gate

```bash
# Move an issue from waiting-for:clarification to completed:clarification
generacy cockpit advance 788 --gate clarification

# Output:
#   advanced generacy-ai/generacy#788: waiting-for:clarification → completed:clarification (comment: https://github.com/generacy-ai/generacy/issues/788#issuecomment-12345)

# Re-running is a no-op (idempotent)
generacy cockpit advance 788 --gate clarification
# Output:
#   already advanced generacy-ai/generacy#788: completed:clarification is present (no-op)

# Wrong gate is refused (exit 3)
generacy cockpit advance 788 --gate plan-review
# Output (stderr):
#   Error: cockpit advance: gate check: refusing to advance gate "plan-review": active waiting gate is "clarification"

# List valid gate names
generacy cockpit advance --help-gates
```

### 3. Gather clarification context for the skill

```bash
# Issue must be in waiting-for:clarification
generacy cockpit clarify-context 788 > /tmp/ctx.json

# Pipe into a clarification skill (example)
generacy cockpit clarify-context 788 | claude --print "answer the open clarifications based on this context"

# Inspect with jq
generacy cockpit clarify-context 788 | jq '.spec.path, .codeReferences.touchedFiles'
```

Sample output (truncated):

```json
{
  "issue": "generacy-ai/generacy#788",
  "clarificationComment": {
    "body": "## Clarifications\n\n### Q1: ...",
    "author": "generacy-orchestrator-bot",
    "createdAt": "2026-06-26T16:46:00Z",
    "url": "https://github.com/generacy-ai/generacy/issues/788#issuecomment-12345"
  },
  "spec": {
    "path": "/workspaces/generacy/specs/788-epic-generacy-ai-tetrad/spec.md",
    "body": "# Feature Specification: ..."
  },
  "plan": {
    "path": "/workspaces/generacy/specs/788-epic-generacy-ai-tetrad/plan.md",
    "body": "# Implementation Plan: ..."
  },
  "codeReferences": {
    "touchedFiles": [
      "specs/788-epic-generacy-ai-tetrad/spec.md",
      "specs/788-epic-generacy-ai-tetrad/clarifications.md"
    ],
    "prUrl": null,
    "prDiffSummary": null
  }
}
```

## Available Commands

| Verb | Purpose | Reads | Writes |
|---|---|---|---|
| `cockpit state <issue>` | Print curated state + source label | gh labels | nothing |
| `cockpit advance <issue> --gate <name>` | Add `completed:<gate>`, remove `waiting-for:<gate>`, post marker comment | gh labels + login | gh labels + comment |
| `cockpit clarify-context <issue>` | Emit clarification-skill JSON | gh comments/timeline, local `specs/`, `git diff` | nothing |

## Output Streams

- **stdout**: the user-facing payload — text line or JSON document. Always parseable with `jq` or `JSON.parse()` in `--json` / `clarify-context` mode.
- **stderr**: pino log lines and error messages. Safe to redirect to `/dev/null` for clean piping.

```bash
generacy cockpit clarify-context 788 2>/dev/null | jq .
```

## Troubleshooting

### `gh: command not found`

Install GitHub CLI:
```bash
# macOS
brew install gh
# Debian/Ubuntu
sudo apt install gh
```

Then `gh auth login`.

### `Error: cockpit state: gh issue view: not authenticated`

Run `gh auth login` and ensure the SSO state covers the target org.

### `Error: cockpit state: 2 monitored repos configured. Use <owner>/<repo>#<n> or the full URL.`

You passed a bare `<number>` but `.generacy/config.yaml`'s `cockpit.repos:` has multiple entries. Pass the fully-qualified form (`generacy-ai/generacy#788`) or trim the config.

### `Error: cockpit advance: gh issue edit: label "completed:foo" not found`

The gate name doesn't exist in the workflow vocabulary. Run `generacy cockpit advance --help-gates` for the valid list. (The CLI catches this *before* calling gh — if you see this error from gh itself, the label is missing on the target repo; ask the orchestrator to sync labels first.)

### `Error: cockpit clarify-context: refusing: issue is not in waiting-for:clarification (current state: active)`

`clarify-context` only runs on issues that are actually waiting for clarification. Use `cockpit state <issue>` to inspect the current tier.

### `clarify-context` returns `spec: null`

The current branch (`git branch --show-current`) doesn't have a matching `specs/<branch>/spec.md`. Either you're not on the feature branch for this issue, or the spec dir uses an older naming convention. Check out the issue's branch and re-run.

### Comment posted but label change failed

Re-run `generacy cockpit advance` — the comment-then-label sequence is idempotent. The first call's comment isn't duplicated by re-runs (idempotency is detected via the presence of the `completed:<gate>` label, not via comment scan).

## What's Out of Scope (not in this release)

- `cockpit watch`, `cockpit status` list-mode (separate issues G1.1 / #787).
- `cockpit merge`, `cockpit review-context` (separate issues G1.3 / #789).
- `cockpit manifest`, `cockpit queue` pipeline verbs (P3).
- Slash commands (`/cockpit:state`, `/cockpit:clarify`) — those live in the `agency` repo.
- Cross-repo advance from a different cwd.
- `--force` override on `cockpit advance` (deferred per AD-4).

## Where to Read Next

- Spec: `specs/788-epic-generacy-ai-tetrad/spec.md`
- Plan + architectural decisions: `specs/788-epic-generacy-ai-tetrad/plan.md`
- Output JSON Schemas: `specs/788-epic-generacy-ai-tetrad/contracts/`
- Foundation package source: `packages/cockpit/src/`
- CLI registration: `packages/generacy/src/cli/index.ts`

# Quickstart: `generacy cockpit queue <phase>`

Hand a whole epic phase off to the cluster pipeline in one confirm-gated command.

## Prerequisites

- A committed epic manifest at `.generacy/epics/<slug>.yaml` (written by `cockpit manifest init` from G3.1 / #790, or hand-authored).
- `gh` CLI authenticated as the cluster account (or another account explicitly passed via `--assignee`).
- The repo's `process:speckit-feature` and `process:speckit-bugfix` labels already exist (the verb does not create labels).

## Install

This verb ships as part of `@generacy-ai/generacy`. Inside the orchestrator container or a developer checkout:

```bash
pnpm install
pnpm --filter @generacy-ai/generacy build
```

## Verify the verb is registered

```bash
generacy cockpit --help
```

Expected output includes:

```text
Commands:
  ...
  queue          Queue every eligible open issue in a named phase to the cluster pipeline.
  ...
```

## Usage

### Preview only (no mutations)

```bash
generacy cockpit queue P3
```

Reads `.generacy/epics/*.yaml`, finds the phase whose `tier` (or `name`) is `P3`, fetches state for each referenced issue, and prints a preview. Without `--yes` the verb prompts before mutating; declining the prompt issues zero `gh` write calls.

Sample preview:

```text
cockpit queue: phase P3 (queue / P3) → 4 eligible, 1 skipped in generacy-ai/generacy
  generacy-ai/generacy#791  G3.2 — cockpit queue <phase>           (process:speckit-feature, assignee: christrudelpw)
  generacy-ai/generacy#792  G3.3 — cockpit manifest sync           (process:speckit-feature, assignee: christrudelpw)
  generacy-ai/generacy#793  bug: gh wrapper crashes on empty list  (process:speckit-bugfix,  assignee: christrudelpw)
  generacy-ai/generacy#794  G3.5 — cockpit dequeue                 (process:speckit-feature, assignee: christrudelpw)
  [SKIP: closed]            generacy-ai/generacy#790
Proceed? [y/N]
```

### Auto-confirm (slash-command / scripted)

```bash
generacy cockpit queue P3 --yes
```

The `/cockpit:queue` slash command (#359) always invokes the verb with `--yes`; the interactive confirmation is its responsibility.

### Override the assignee

```bash
generacy cockpit queue P3 --assignee generacy-orchestrator-bot
```

Use when the cluster account differs from the in-container `gh` identity. Defaults to `gh api user --jq .login` when omitted.

### Multi-repo phase (requires `--repo`)

If the manifest's `phases[].issues` span multiple repos, the verb requires an explicit `--repo`:

```bash
# Phase P5 has issues in both generacy-ai/generacy and generacy-ai/agency:
generacy cockpit queue P5
# Error: cockpit queue: phase "P5" spans repos [generacy-ai/agency, generacy-ai/generacy].
#        Pass --repo <owner/repo> to scope this invocation.

generacy cockpit queue P5 --repo generacy-ai/generacy
# Queues only the generacy-ai/generacy issues; agency refs show as [SKIP: cross-repo].
```

## Available commands

| Command                                                      | Purpose                                                                                              |
|--------------------------------------------------------------|------------------------------------------------------------------------------------------------------|
| `generacy cockpit queue <phase>`                             | Queue a phase to the cluster pipeline.                                                              |
| `generacy cockpit queue <phase> --repo <owner/repo>`         | Scope a multi-repo phase to one repo.                                                               |
| `generacy cockpit queue <phase> --assignee <login>`          | Override the default cluster-account assignee.                                                      |
| `generacy cockpit queue <phase> --yes`                       | Skip the interactive confirmation (non-interactive / slash-command path).                           |

## Idempotency

Re-running `queue <phase>` against an already-queued phase reports every row as `already` and exits 0 without issuing any `gh` write calls. This makes the verb safe to script and safe to retry after a partial failure.

## Troubleshooting

### `Error: cockpit queue: no .generacy/epics directory found.`

The repo has no epic manifests yet. Run `generacy cockpit manifest init` first (or commit a hand-authored manifest matching `EpicManifestSchema`).

### `Error: cockpit queue: phase "P3" not found in any manifest under .generacy/epics/.`

The argument did not match any `phase.tier` or `phase.name` across the manifests in `.generacy/epics/`. Check the spelling — matching is case-sensitive — and inspect the available phases:

```bash
yq '.phases[] | .tier + " " + .name' .generacy/epics/*.yaml
```

### `Error: cockpit queue: phase "P3" matches multiple manifests:`

Two manifests define a phase with the same name or tier. v1 errors here; v2 will add a `--manifest <path>` flag to disambiguate. Workaround: invoke from a cwd whose `.generacy/epics/` contains only the intended manifest.

### `FAILED <owner/repo>#<n> assignee=ok label=error: ...`

A mutation failed for one or more rows. The verb still processes every row and exits 1; rerun after fixing the cause to resolve the partial state (idempotency means the rerun touches only the unfinished rows).

Common causes:
- Label `process:speckit-feature` or `process:speckit-bugfix` not provisioned in the target repo. Create them via `gh label create process:speckit-feature` and rerun.
- Assignee login doesn't exist or lacks repo access. Override with `--assignee <correct-login>`.
- `gh` auth expired. Refresh and rerun.

### Issue shows `[SKIP: closed]` but I want to requeue it

Reopen the issue first (`gh issue reopen <n> --repo <r>`), then rerun. The verb intentionally never touches closed issues.

## See also

- `generacy cockpit advance <issue> --gate <name>` — manually flip a single waiting gate.
- `generacy cockpit status` — render the epic's overall state table.
- `generacy cockpit watch` — long-poll loop emitting cockpit events.

# Contract: `generacy cockpit queue <phase>`

## Synopsis

```text
generacy cockpit queue <phase> [--repo <owner/repo>] [--assignee <login>] [--yes]
```

## Arguments

| Name      | Required | Description                                                                                       |
|-----------|----------|---------------------------------------------------------------------------------------------------|
| `<phase>` | Yes      | Phase identifier. Matched against `phase.tier` (e.g. `P3`) OR `phase.name` (e.g. `foundation`).   |

## Options

| Flag                       | Type     | Default                          | Description                                                                                          |
|----------------------------|----------|----------------------------------|------------------------------------------------------------------------------------------------------|
| `--repo <owner/repo>`      | string   | (sole repo in phase if 1; else required) | Restricts the invocation to a single repo. Required when the phase's `issues` span multiple repos. |
| `--assignee <login>`       | string   | result of `gh api user --jq .login` | Overrides the default cluster-account assignee.                                                  |
| `--yes`                    | boolean  | `false`                          | Skips the interactive confirmation prompt.                                                          |

## Inputs (read)

- `${cwd}/.generacy/epics/*.yaml` — epic manifests, validated against `EpicManifestSchema` (from `@generacy-ai/cockpit`).
- `gh api user` — for the default assignee (skipped when `--assignee` is given).
- `gh issue view <n> --repo <r> --json state,closedAt,labels,assignees,title` — per phase issue ref, once.

## Outputs (write)

For each eligible row only (no writes for `[SKIP: …]` rows, no writes if the operator declines):

- `gh issue edit <n> --repo <r> --add-assignee <assignee>` — once per row that lacks the assignee.
- `gh issue edit <n> --repo <r> --add-label <workflowLabel>` — once per row that lacks the workflow label.

## Stdout — Preview (always)

Printed before any confirmation, in a deterministic order (repo-grouped, issue-number-sorted):

```text
cockpit queue: phase <phaseArg> (<resolvedName> / <resolvedTier>) → <E> eligible, <S> skipped in <targetRepo>
  <owner/repo>#<n>  <title> (<workflowLabel>, assignee: <login>)
  ...
  [SKIP: closed]      <owner/repo>#<n>  <title>
  [SKIP: cross-repo]  <owner/repo>#<n>  <title>
  [SKIP: not found]   <owner/repo>#<n>
Proceed? [y/N]
```

When `eligible === 0` (every row is a SKIP, or the phase has zero issues), the verb prints the preview followed by:

```text
cockpit queue: no eligible issues — nothing to do.
```

…and exits 0 without prompting and without writes.

## Stdout — Confirmation outcomes

If the user declines (or the prompt is cancelled with Ctrl-C):

```text
Cancelled. No mutations made.
```

After `--yes` or operator confirm, per-row summary lines:

```text
Queued <owner/repo>#<n>  assignee=<ok|already>  label=<ok|already>
FAILED <owner/repo>#<n>  assignee=<ok|already|error: ...>  label=<ok|already|error: ...>
```

Each `FAILED` line is printed for any row where either `assignResult` or `labelResult` is an error. The line shows both fields' final state, so the operator sees whether (e.g.) assign succeeded but label failed.

## Exit codes

| Code | Meaning                                                                                                                  |
|------|--------------------------------------------------------------------------------------------------------------------------|
| 0    | All eligible rows OK or already-queued; OR user declined; OR no eligible rows.                                           |
| 1    | At least one mutation error.                                                                                             |
| 2    | Usage error: missing `<phase>`, unknown phase, ambiguous phase across manifests, multi-repo phase without `--repo`, `--repo` not in phase's repo set, malformed `--assignee` / `--repo`, manifest directory missing, no manifest containing a matching phase. |

## Stderr — error envelopes

All exit-2 paths write a single `Error: cockpit queue: <reason>` line to stderr:

| Trigger                              | Stderr line                                                                                                                       |
|--------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------|
| missing arg                          | `Error: cockpit queue: missing required argument <phase>`                                                                          |
| invalid `--repo`                     | `Error: cockpit queue: invalid --repo "<value>" (expected owner/repo)`                                                            |
| invalid `--assignee`                 | `Error: cockpit queue: invalid --assignee "<value>" (expected GitHub login)`                                                      |
| no manifest dir                      | `Error: cockpit queue: no .generacy/epics directory found. Run 'generacy cockpit manifest init' first.`                          |
| no matching phase                    | `Error: cockpit queue: phase "<phase>" not found in any manifest under .generacy/epics/. Run 'generacy cockpit manifest init' first.` |
| ambiguous phase                      | `Error: cockpit queue: phase "<phase>" matches multiple manifests: <list>. Disambiguate by running the verb from a more specific cwd.` |
| multi-repo without `--repo`          | `Error: cockpit queue: phase "<phase>" spans repos [<r1>, <r2>, ...]. Pass --repo <owner/repo> to scope this invocation.`         |
| `--repo` not in phase                | `Error: cockpit queue: phase "<phase>" has no issues in <repo>. Phase repos: [<r1>, <r2>, ...].`                                   |

All exit-1 paths write per-row `FAILED ...` lines to stdout (not stderr) — the structured summary is the error report.

## Side-effect ordering invariants

1. The preview is printed BEFORE the confirm prompt and BEFORE any `gh` write call.
2. No `gh` write call is issued unless `--yes` is set or `p.confirm()` resolves truthy. Operator decline = zero writes (SC-002, asserted by test 8 in research.md R10).
3. For each eligible row: `gh issue edit --add-assignee` runs BEFORE `gh issue edit --add-label`. Both are best-effort: a failure in assign does NOT skip the label call for the same row.
4. Cross-issue boundary: a failure on row N does NOT skip processing of row N+1 (FR-006 / Q4).
5. After the mutation loop, the per-row summary is printed in the same order as the preview.

## Idempotency contract (SC-003)

A second invocation with the same arguments and unchanged GitHub state MUST:

1. Print a preview where every eligible row's `assignee:` field already matches and the workflow label is already present.
2. After confirm (or `--yes`), report every row as `assignee=already label=already`.
3. Exit 0.
4. Issue ZERO `gh` write calls (because the pre-mutation `assignees` / `labels` check observes the no-op).

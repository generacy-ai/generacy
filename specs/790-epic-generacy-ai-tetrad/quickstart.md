# Quickstart: cockpit manifest init/sync

**Status**: Complete
**Date**: 2026-06-26

Walk-through of using `generacy cockpit manifest <init|sync>` on a real epic. Assumes you're inside a Generacy workspace with `pnpm install` already run and `gh` authenticated.

## Prerequisites

- Node ≥ 22 (`node --version` should print `v22.x` or higher).
- `gh` CLI authenticated to your GitHub account: `gh auth status` must print "Logged in to github.com".
- This repo checked out and built: `pnpm install && pnpm -F @generacy-ai/generacy build`.
- An epic issue on GitHub that follows the children-by-phase convention. Example: [generacy-ai/tetrad-development#85](https://github.com/generacy-ai/tetrad-development/issues/85).

## Epic body shape (input)

`init` reads a body shaped like this. The grammar is intentionally lenient — see [contracts/cli.md](./contracts/cli.md) for the formal grammar.

```markdown
# Epic: Cockpit

Plan: docs/epic-cockpit-plan.md in tetrad-development (P3 / G3.1)

## Children by phase

### P0 — Foundation → v1
- [x] generacy-ai/generacy#786 — `@generacy-ai/cockpit` foundation
- [x] generacy-ai/generacy#787 — gh wrapper

### P3 — Manifest → v2
- [ ] generacy-ai/generacy#790 — manifest init/sync verb
- [ ] generacy-ai/generacy#791 — `cockpit queue <phase>`

### P4 — Hardening → v3
- generacy-ai/generacy#792
```

What the parser extracts:
- `Plan: docs/epic-cockpit-plan.md in tetrad-development (P3 / G3.1)` → bare path `docs/epic-cockpit-plan.md` (the `in <repo>` and parenthesized suffix are stripped).
- Three phases: `P0 — Foundation` (tier `v1`), `P3 — Manifest` (tier `v2`), `P4 — Hardening` (tier `v3`).
- Each phase's `issues[]` collected from its bullet refs. Checkbox state (`- [ ]` vs `- [x]` vs `-`) is ignored.

## Usage

### `init` — bootstrap a new manifest

```bash
generacy cockpit manifest init generacy-ai/tetrad-development#85
# wrote .generacy/epics/cockpit.yaml (3 phases, 5 issues)
```

The slug `cockpit` is derived from the epic title `Epic: Cockpit` (leading `Epic:` stripped, kebab-cased).

The resulting `.generacy/epics/cockpit.yaml`:

```yaml
epic:
  repo: generacy-ai/tetrad-development
  issue: 85
  slug: cockpit
  plan: docs/epic-cockpit-plan.md
autonomy: {}
phases:
  - name: P0 — Foundation
    tier: v1
    repos: []
    issues:
      - generacy-ai/generacy#786
      - generacy-ai/generacy#787
  - name: P3 — Manifest
    tier: v2
    repos: []
    issues:
      - generacy-ai/generacy#790
      - generacy-ai/generacy#791
  - name: P4 — Hardening
    tier: v3
    repos: []
    issues:
      - generacy-ai/generacy#792
```

#### Override the slug

```bash
generacy cockpit manifest init generacy-ai/tetrad-development#85 --slug epic-cockpit
# wrote .generacy/epics/epic-cockpit.yaml (3 phases, 5 issues)
```

#### Overwrite an existing manifest

```bash
generacy cockpit manifest init generacy-ai/tetrad-development#85
# Error: cockpit manifest init: .generacy/epics/cockpit.yaml already exists. Pass --force to overwrite or --slug <other> to choose a different name.

generacy cockpit manifest init generacy-ai/tetrad-development#85 --force
# wrote .generacy/epics/cockpit.yaml (3 phases, 5 issues)
```

### `sync` — reconcile an existing manifest

After filing a new child issue (#793) and adding it to the epic body, run:

```bash
generacy cockpit manifest sync
# synced .generacy/epics/cockpit.yaml: +0 phases, -0 phases, +1 issue, -0 issues
#   P4 Hardening: +1 (added generacy-ai/generacy#793)
```

Run again with no body edits:

```bash
generacy cockpit manifest sync
# no changes
```

#### Pick a specific manifest in a multi-epic workspace

```bash
generacy cockpit manifest sync --epic cockpit
```

### `--json` for scripting

```bash
generacy cockpit manifest sync --json | jq '.changes.issuesAdded'
# {
#   "P4": ["generacy-ai/generacy#793"]
# }
```

The full JSON shape is documented in [contracts/cli.md](./contracts/cli.md).

## Common workflows

### CI-loop idempotency check

`sync` exits 0 on a clean run. To gate a CI job on "the manifest is in sync with the body":

```bash
result=$(generacy cockpit manifest sync --json)
wrote=$(echo "$result" | jq -r '.wrote')
if [[ "$wrote" == "true" ]]; then
  echo "manifest was out of sync; committing the update..."
  git add .generacy/epics/
  git commit -m "chore(cockpit): sync manifest"
fi
```

### Pair with `cockpit queue`

After `manifest init`, `cockpit queue <phase>` (#791, lands after this) can read the manifest to enumerate the issues for a phase. There's no manual step between the two — `init` produces exactly the shape `queue` consumes.

## Troubleshooting

### `Error: cockpit manifest init: invalid epic ref "85"`

You passed a bare number. The verb requires `owner/repo#n`. Use `generacy-ai/tetrad-development#85`.

### `Error: cockpit manifest init: epic body has no "Plan:" line.`

Add a `Plan: <path>` line anywhere in the epic body. The path must be repo-relative (it points to a file inside the same repo as the epic). Optional ` in <repo>` and `(...)` suffixes are tolerated and stripped.

### `Error: cockpit manifest init: epic body has no 'P\d+' phase headings`

The "Children by phase" section is empty or none of its headings include a `P<n>` token. Either add `P0`, `P1`, ... to your `###` headings or restructure the body to match the example above. Heading levels `##`/`###`/`####` all work.

### `Error: cockpit manifest sync: no manifest found under .generacy/epics/`

You haven't run `init` yet, or you're in the wrong cwd. Either `cd` to the workspace root before running `sync`, or pass `--manifest-root <path>`. (`--manifest-root` is mostly used in tests.)

### `Error: cockpit manifest sync: multiple manifests found (...)`

Pick one: `generacy cockpit manifest sync --epic <slug>`.

### `gh auth status` complains

`init` and `sync` both call `gh issue view` under the hood. Run `gh auth login` to fix.

### The manifest didn't pick up a phase rename

Phases are matched by their `P<n>` index, not their display name (per [clarifications.md](./clarifications.md) Q2/B). Renaming a phase in the body updates the manifest's `name` in place — that's intentional and idempotent. If you also changed the `P<n>` index, that's treated as a remove + add (which it is — the index is the identity).

### `autonomy:` block got overwritten

It shouldn't. `sync` is explicit about leaving `autonomy` untouched (Q3/A). If you're seeing this, file a bug — it's a regression against the spec.

## Available commands

```text
generacy cockpit manifest init <epic-ref> [--slug <slug>] [--force] [--json] [--manifest-root <dir>]
generacy cockpit manifest sync             [--epic <slug>] [--json] [--manifest-root <dir>]
```

Sibling cockpit verbs that read the manifest this verb writes:
- `generacy cockpit watch <epic>` — poll an epic's issues/PRs for state changes.
- `generacy cockpit status <epic>` — render a grouped table of the epic's current state.
- `generacy cockpit queue <phase>` (after #791 lands) — enumerate issues for a phase.

## What this verb does NOT do

(See spec's "Out of scope" for full list.)
- It does not edit the `autonomy:` block — that's driven by `cockpit queue` and per-gate policy work in later issues.
- It does not migrate from a hypothetical older manifest format. (None exists yet.)
- It does not auto-run on a timer or inside `cockpit watch`'s poll loop. Run it explicitly when the body changes.
- It does not wire itself into a `/cockpit:manifest` slash command — that lands in the agency repo (P4).

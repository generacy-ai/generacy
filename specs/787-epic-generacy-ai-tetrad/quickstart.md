# Quickstart: `generacy cockpit watch` + `status`

## Prerequisites

- Node.js >= 22.
- `@generacy-ai/generacy` installed (this PR adds the `cockpit` subcommand).
- `gh` CLI installed and authenticated (`gh auth status` succeeds). Both verbs use the foundation's `GhCliWrapper`, which shells out to `gh`.
- `.generacy/config.yaml` with a `cockpit:` block, **or** the `MONITORED_REPOS` env var set. Without either, the verbs warn and exit with `repos: []` (nothing to watch).

Minimum config:

```yaml
# .generacy/config.yaml
cockpit:
  owner: generacy-ai
  repos:
    - generacy-ai/generacy
    - generacy-ai/tetrad-development
  orchestrator:
    baseUrl: http://127.0.0.1:3100   # optional; default
    token: ${ORCHESTRATOR_API_TOKEN}  # optional; status footer degrades when absent
```

Or, no config file:

```bash
export MONITORED_REPOS="generacy-ai/generacy,generacy-ai/tetrad-development"
```

## Install

`@generacy-ai/cockpit` is already a workspace dep of `@generacy-ai/generacy` after this PR lands. From the monorepo root:

```bash
pnpm install
pnpm --filter @generacy-ai/generacy build
```

For end users (post-publish):

```bash
npm install -g @generacy-ai/generacy
generacy cockpit --help
```

## Usage

### Watch every transition across all configured repos

```bash
generacy cockpit watch
# stderr: cockpit: watching 42 issues, 8 PRs across 2 repos; emitting on transition
# stdout: (NDJSON, one line per transition)
```

Each line is one `CockpitEvent`. Pipe to `jq` to filter:

```bash
generacy cockpit watch | jq -c 'select(.event == "label-change" and .to == "waiting")'
```

### Watch a single epic

```bash
generacy cockpit watch --epic generacy-ai/tetrad-development#85
# stderr: cockpit: watching 12 issues, 4 PRs scoped to epic generacy-ai/tetrad-development#85
```

Scoping cuts the per-poll `gh` cost dramatically — only the epic's children are queried.

### One-shot status snapshot

```bash
generacy cockpit status
# stdout:
# generacy-ai/generacy
#   #790  waiting   waiting-for:plan-review        PR  #791  success   Add foo bar
#   #792  active    phase:implement                PR  #793  pending   Fix bar baz
#
# generacy-ai/tetrad-development
#   #85   active    phase:plan                     PR   -    none      Epic: cockpit
#
# orchestrator: 3 jobs, 1 worker
```

### Status as JSON (for CI dashboards)

```bash
generacy cockpit status --json
# {"scope":{"kind":"repos","repos":[...]},"rows":[...],"orchestrator":{"available":true,...}}
```

### Status scoped to one epic

```bash
generacy cockpit status --epic generacy-ai/tetrad-development#85
# Output groups by phase if the epic has a manifest at .generacy/epics/<slug>.yaml.
```

### Tune the watch poll interval

```bash
generacy cockpit watch --interval 2000   # poll every 2s instead of 5s
```

Minimum is 1000 ms. Lower would risk `gh` rate-limiting.

## Integration with Claude Code's Monitor tool

The `Monitor` tool consumes NDJSON streams: it reads each line from a long-running stdout, treats each as an event, and triggers callbacks. Wire it up:

```typescript
Monitor({
  command: ['generacy', 'cockpit', 'watch', '--epic', 'generacy-ai/tetrad-development#85'],
  onLine: (line) => {
    const event = JSON.parse(line);
    if (event.event === 'pr-checks' && event.checks === 'failure') {
      // dispatch a fixer
    }
  },
});
```

The wire format is locked by `contracts/cockpit-event.schema.json`. Changes are breaking.

## Troubleshooting

### `cockpit: warn: no repos configured`

Cause: neither `cockpit.repos` in `.generacy/config.yaml` nor `MONITORED_REPOS` env is set.

Fix: add at least one `owner/name` entry to either.

### `cockpit: warn: poll cycle exceeded 1000 items`

Cause: an un-`--epic`-scoped watch over a busy repo returned > safety-cap items in a single poll.

Fix: pass `--epic <owner/repo#N>` to scope to a specific epic, or raise the cap with `--safety-cap 5000` if you genuinely have that many open issues across the repo set.

### `Error: --epic must be owner/repo#NNN`

Cause: the `--epic` flag didn't match the `^[^/]+/[^/]+#\d+$` regex.

Fix: use the full form `generacy-ai/tetrad-development#85`, not `tetrad-development#85` or `#85`.

### Status footer reads `orchestrator: (no token)`

Cause: `ORCHESTRATOR_API_TOKEN` env var is unset and no `cockpit.orchestrator.token` is in config.

Fix: set the token in the config block or the env. The footer is the only thing that needs it — the rest of `status` works without it.

### `gh: command not found`

Cause: `gh` CLI is not on `PATH`.

Fix: install GitHub CLI per https://cli.github.com. Then `gh auth login` to authenticate.

### Watch emits no events even though I'm changing labels

Two likely causes:
1. The label change is happening on a repo not in `cockpit.repos` (or in your `--repos` override). Verify the repo set.
2. The label is not in `WORKFLOW_LABELS` (so the classifier maps it to `unknown`). Add it to the workflow-engine label set, or use a `waiting-for:*`/`phase:*`/`agent:*`/`completed:*`/`failed:*` label that the classifier already recognizes.

The first poll establishes the baseline and emits nothing — that's by design (R9). Only changes after that emit.

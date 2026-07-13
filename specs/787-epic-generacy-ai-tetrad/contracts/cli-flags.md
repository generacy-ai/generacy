# CLI Flag Contract: `generacy cockpit watch` + `generacy cockpit status`

Stable surface for the two cockpit verbs. Each flag's semantics, default, and validation rule. Changes here are user-visible.

## `generacy cockpit watch`

```text
Usage: generacy cockpit watch [options]

Emit one NDJSON line per issue/PR state transition. Pure sensor; never mutates state.

Options:
  --epic <owner/repo#N>   Scope to a single epic. Resolves via .generacy/epics/*.yaml
                          manifests first, then the GitHub epic-child label graph.
                          When omitted, watches every open issue/PR across the
                          configured repos. Format must match owner/repo#NNN.
  --repos <list>          Comma-separated 'owner/name' list to override the
                          cockpit.repos config block. Useful for ad-hoc watches.
  --interval <ms>         Poll interval in milliseconds. Default 5000. Minimum 1000.
                          Sub-second polling risks gh-cli rate limiting.
  --safety-cap <n>        Max items per repo per poll before a stderr warning is
                          emitted. Default 1000. Does not truncate; pagination
                          always runs to completeness.
  -h, --help              Show help and exit.
```

### Exit codes

| Code | Meaning                                                            |
|------|--------------------------------------------------------------------|
| 0    | Clean shutdown via SIGINT (Ctrl-C).                                |
| 1    | Configuration error (invalid `--epic`, malformed `cockpit:` block).|
| 2    | `gh` not installed or not authenticated.                           |
| 3    | Unrecoverable `gh` error during a poll cycle.                      |

### Output streams

| Stream  | Contents                                                                                |
|---------|------------------------------------------------------------------------------------------|
| stdout  | NDJSON `CockpitEvent` lines. One JSON object per `\n`-terminated line. No other writes.  |
| stderr  | Startup banner (1 line). Safety-cap warnings (≤1 per poll). Fatal errors before exit.    |

## `generacy cockpit status`

```text
Usage: generacy cockpit status [options]

Print a one-shot snapshot of every epic-scoped (or repo-scoped) issue/PR.

Options:
  --epic <owner/repo#N>   Scope to a single epic. Format owner/repo#NNN.
                          When omitted, lists every open issue/PR across the
                          configured repos, grouped by repo.
  --repos <list>          Comma-separated 'owner/name' list to override the
                          cockpit.repos config block.
  --json                  Emit a single-line JSON envelope and exit. Disables
                          color. Suitable for CI dashboards and scripted parsing.
  -h, --help              Show help and exit.
```

### Exit codes

| Code | Meaning                                                            |
|------|--------------------------------------------------------------------|
| 0    | Snapshot printed.                                                  |
| 1    | Configuration error (invalid `--epic`, malformed `cockpit:` block).|
| 2    | `gh` not installed or not authenticated.                           |

### Output streams

| Stream  | Contents                                                                                |
|---------|------------------------------------------------------------------------------------------|
| stdout  | Plain-text table + footer line (default), or single-line JSON envelope (`--json`).      |
| stderr  | Diagnostic warnings (e.g. one repo unreadable). Never used for the snapshot itself.     |

### JSON envelope shape (with `--json`)

```json
{
  "scope": { "kind": "epic", "owner": "generacy-ai", "repo": "generacy", "issue": 787 }
            | { "kind": "repos", "repos": ["generacy-ai/generacy"] },
  "rows": [
    {
      "repo": "generacy-ai/generacy",
      "kind": "issue",
      "number": 790,
      "title": "Add foo bar",
      "state": "waiting",
      "sourceLabel": "waiting-for:plan-review",
      "prNumber": 791,
      "checks": "success",
      "url": "https://github.com/generacy-ai/generacy/issues/790"
    }
  ],
  "orchestrator": {
    "available": true,
    "jobs": 3,
    "workers": 1
  }
}
```

`orchestrator.available: false` carries a `reason: string` instead of `jobs`/`workers`. Possible reasons: `'no-token'`, `'cloud-unreachable'`, `'http-error'`, `'timeout'`.

## Shared invariants

- Both verbs read configuration via `loadCockpitConfig()` from `@generacy-ai/cockpit`. The resolution chain (`cockpit.repos` → `MONITORED_REPOS` env → `[]`) is the foundation's responsibility.
- `--epic` and `--repos` are independent: `--epic` always wins when present (the epic's children are the universe); `--repos` overrides the config block but is ignored when `--epic` is set (the epic's manifest already pins the repo set).
- Neither verb makes mutating `gh` calls. `watch` is documented as a sensor; `status` is documented as read-only. Any future "do-something" verb is a separate command.
- Both verbs work without `ORCHESTRATOR_API_TOKEN` — the orchestrator client degrades to stub mode and the `status` footer renders `"orchestrator: (no token)"`.

# Quickstart: Zero-config epic cockpit

## Prerequisites

- Node ≥ 22
- `gh` CLI authenticated (`gh auth status` shows a logged-in account)
- An epic issue whose body conforms to the format below

You do **not** need:

- A `.generacy/` directory
- A `cockpit.repos` config block
- A `MONITORED_REPOS` env var
- Any manifest YAML

## Epic body format

```markdown
### S2 — single-source discovery

- [ ] owner/repo#123
- [x] owner/repo#124 — Some title
- [ ] [owner/other-repo#8](https://github.com/owner/other-repo/issues/8)
- [ ] https://github.com/owner/repo/issues/125

### S3 — cleanup

- [ ] owner/repo#130
```

Rules the resolver enforces:

- Only `### ` (level-3) headings are phase headings.
- Task-list items must use `owner/repo#N` or a markdown-linked / URL variant that normalizes to the same. Bare `#N` shorthand is **not** accepted (cross-repo epics make it ambiguous).
- Both `- [ ]` and `- [x]` refs are included; downstream commands (issue state / labels) decide eligibility.
- A body with no `### <phase>` headings or no ref bullets → loud error listing the expected format.

## Commands

### `watch`

```bash
generacy cockpit watch --epic owner/repo#42
# defaults: interval=30000ms, floor=15000ms
```

- Re-parses the epic body every tick — mid-epic children join automatically.
- Emits one NDJSON line per issue/PR transition to `stdout`.
- All diagnostics (interval clamp warnings, per-tick errors) go to `stderr`.

Below-floor override:

```bash
generacy cockpit watch --epic owner/repo#42 --interval 5000
# stderr: "cockpit watch: --interval 5000 below floor 15000ms; clamping."
# continues at 15000ms
```

### `status`

```bash
generacy cockpit status --epic owner/repo#42
generacy cockpit status --epic owner/repo#42 --json
```

Prints a grouped table (or single JSON envelope with `--json`) of every issue/PR referenced under any phase heading in the epic body.

### `queue`

```bash
generacy cockpit queue owner/repo#42 s2
# labels every eligible child under '### S2 …' with process:speckit-feature

generacy cockpit queue owner/repo#42 s2 --label process:speckit-bugfix
# override the default label
```

- `<phase>` matches via case-insensitive first-token match (`s2` matches `### S2 — single-source discovery`).
- Ambiguous tokens error loudly and list candidate headings.
- Ineligible refs (closed, already-labeled, cross-repo mismatch when `--repo` narrows scope) are skipped at preview time.

## Removed surface

The following are gone as of this feature (loud unknown-option / unknown-command errors):

- `generacy cockpit manifest init|sync`
- `--repos <list>` on `watch` / `status`
- `cockpit.repos:` in `.generacy/config.yaml`
- `MONITORED_REPOS` env var

## Troubleshooting

**"cockpit: epic body has no `### <phase>` headings"** — the parser didn't find any level-3 headings. Confirm the epic body uses `### `, not `## ` or bold.

**"cockpit: epic body has phase headings but no resolvable refs"** — headings found but no `- [ ] owner/repo#N` bullets. Bare `#N` shorthand is not resolved (see the epic body format section).

**"cockpit: phase token 's2' is ambiguous — matches: ###..., ###..."** — you have two headings whose first token is the same. Disambiguate the headings in the epic body.

**Watcher exits with `poll error:`** — a transient gh/network error killed the tick. Re-run `watch`; the resolver will re-fetch the body on the next tick.

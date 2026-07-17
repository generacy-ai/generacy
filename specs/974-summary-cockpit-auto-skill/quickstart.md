# Quickstart — `generacy cockpit doorbell`

## What it is

A background wake-sensor. The `/cockpit:auto` skill spawns it as a subprocess and treats every non-empty stdout line as a wake signal. The doorbell subscribes to an in-process `EpicEventBus` (poll cadence: 30 s default) and writes one line per emitted bus event.

## Install

Ships as part of `@generacy-ai/generacy`. No extra install step — after this feature lands, any preview build (e.g. `0.0.0-preview-2026*`) will register the command.

```
$ generacy cockpit --help
Usage: generacy cockpit [options] [command]

Cockpit — inspect and drive workflow state for Generacy epics and issues.

Commands:
  …
  doorbell    Wake sensor for /cockpit:auto. Emits one stdout line per epic bus event.
```

## Usage

### Form 1 — watch an epic

```
$ generacy cockpit doorbell generacy-ai/generacy#974
armed
issue-transition
phase-complete
issue-transition
epic-complete
issue-transition
^C
```

- Runs until SIGINT/SIGTERM.
- One line per bus event.
- `armed` prints once after the first successful poll (or bus acquire) — tells the caller the sensor is up and steady.

### Form 2 — watch a tracking issue

```
$ generacy cockpit doorbell christrudelpw/snappoll#1 --tracking
armed
issue-transition
issue-transition
^C
```

- Same shape as Form 1; the positional keys a different `EpicEventBus` slot. No `epic-complete` line (tracking-ref bus never emits it).

### Form 3 — new tracking placeholder

```
$ generacy cockpit doorbell --new "Draft snappoll spec"
armed
^C
```

- No bus, no wake lines beyond `armed`. Skill uses this before the tracking issue exists; it re-spawns Form 2 after G.6 creates the issue.

### With opt-in exit on `epic-complete`

```
$ generacy cockpit doorbell generacy-ai/generacy#974 --exit-on-epic-complete
armed
issue-transition
epic-complete
$   # exit 0
```

## Available flags

| Flag | Argument | Behavior |
|------|----------|----------|
| `--tracking` | (none) | Positional is a tracking-issue ref. |
| `--new <title>` | string | No positional; armed-only Form 3. |
| `--exit-on-epic-complete` | (none) | After `epic-complete`, flush stdout + exit 0. Off by default. |
| `--help` | (none) | Print usage, exit 0. |

## Troubleshooting

**`error: unknown command 'doorbell'`**
- You're on a preview build older than #974. Pull the latest.

**`cockpit doorbell: parse issue: issue argument is required`**
- Form 1/2 need a positional ref. Add `<owner>/<repo>#<n>`, an issue URL, or a bare number *inside a git checkout* with a resolvable GitHub origin.

**`cockpit doorbell: --tracking and --new are mutually exclusive`**
- Pick one. `--tracking` labels an existing issue; `--new` is a pre-creation placeholder.

**Doorbell prints `armed\n` but no wake lines when I know the epic transitioned**
- `armed` means the sensor is up. If wake lines never follow:
  - Check that the ref you passed actually names the transitioning issue (`generacy cockpit status <ref>` should show live labels).
  - Check that the doorbell isn't rate-limit-throttled — probe: `gh api rate_limit` from the same container.
  - Check that `stdout` isn't line-buffered by something upstream (unlikely under `Monitor`; more common under `less | doorbell …`).

**Stdout appears buffered when I pipe the doorbell into another tool**
- Node block-buffers stdout under pipes. The doorbell drains via a write-with-callback per line, so this shouldn't happen — but downstream tools may buffer their own stdin. Verify with `stdbuf -oL <downstream>` if you must.

**Doorbell doesn't exit when I close the terminal**
- It should — SIGINT/SIGTERM triggers `release()` + `process.exit(0)`. If it doesn't, `strace -p <pid>` to see what it's blocked on and file a bug against generacy#974.

## Related commands

- `generacy cockpit watch <epic-ref>` — same event source, but emits NDJSON payloads (one full envelope per line). Kept for interactive/human use; `auto` uses `doorbell` instead.
- `generacy cockpit status <ref>` — one-shot status snapshot; no polling.
- `generacy cockpit await-events` (MCP tool) — the in-process consumer of the same `EpicEventBus`. See `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_await_events.ts`.

## Design notes

- The doorbell process owns its own bus (Q1=C). It does NOT share state with the MCP-server process running `cockpit_await_events`. Poll cadence is 2× per epic under auto-drive (doorbell + MCP), unchanged from the pre-#970 `cockpit watch` + `cockpit_await_events` baseline. #970's short-TTL cache + rate-limit backoff keeps GraphQL spend bounded.
- Cross-process poll collapse ("one poll loop per epic") is a follow-up requiring a new IPC surface (Q1 option B) — deferred.
- Callers MUST NOT parse stdout line content. It is deterministic for testability, not for consumers.

# Feature Specification: Cockpit `watch` + `status` CLI verbs

**Branch**: `787-epic-generacy-ai-tetrad` | **Date**: 2026-06-26 | **Status**: Draft
**Epic**: generacy-ai/tetrad-development#85 | **Phase**: P1 | **Tier**: v1-core | **Issue**: G1.1 (#787)
**Depends on**: G0.1 (#786, merged) — `@generacy-ai/cockpit` foundation package

## Summary

Add two read-only `generacy cockpit` subcommands that turn the cockpit foundation
package (#786) into observable operator surfaces:

- **`generacy cockpit watch`** — a long-running pure sensor that polls GitHub for
  every epic-scoped issue and pull request and emits **exactly one stdout line
  per state transition**, including transitions into terminal and error states.
  The output shape is designed for Claude Code's `Monitor` tool to consume as a
  notification stream, so a coding agent or operator can react to "something
  changed" without manually refreshing GitHub.
- **`generacy cockpit status`** — a one-shot snapshot dashboard that prints
  every epic issue with its current cockpit phase / state, its linked PR (when
  one exists), and the PR's check-run roll-up. Designed for a human in a
  terminal who just wants to see "where is everything right now."

Both verbs live under `packages/generacy/src/cli/commands/cockpit/` (one file
per verb) and are wired into the existing Commander.js program using the
auto-register pattern established by G0.1 — the new `cockpit` parent command
exposes both subcommands so today's surface is `generacy cockpit watch ...` and
`generacy cockpit status ...`, with room for the queue / manifest / merge verbs
added in sibling issues (#788–#791) without further restructuring.

Neither verb mutates GitHub, the orchestrator, or any local file other than
optional terminal output redirection. Both verbs are pure observers.

## User Stories

### US1 (Primary): Claude Code reacts to epic state changes

**As a** Claude Code agent driving an epic from the command line,
**I want** `generacy cockpit watch` to emit a single, parsable stdout line every
time any monitored issue or PR transitions cockpit state,
**So that** I can register the command with my `Monitor` tool and get notified
the instant work needs my attention — without polling GitHub from inside the
conversation or burning context on full snapshots.

**Acceptance criteria**:
- [ ] Each emitted line is a single JSON object terminated by `\n`, suitable
  for line-buffered stream consumers.
- [ ] Every transition produces exactly one line; no transition produces zero
  lines and no transition produces duplicates within the same `watch` run.
- [ ] Transitions into `error` and `terminal` cockpit states are emitted on
  the same channel as `active` / `waiting` / `pending` transitions (one
  unified stream, not split across stderr / stdout).
- [ ] The first poll after startup emits one "baseline" line per issue/PR so
  consumers know the starting state without having to call `status` first
  (a startup snapshot, not silence-until-change).
- [ ] The process never exits on transient GitHub or orchestrator errors;
  errors are surfaced on stderr and the poll loop continues.

### US2: Operator scans the epic in a terminal

**As an** operator with multiple epics in flight,
**I want** `generacy cockpit status` to print a compact, human-readable
dashboard listing every epic issue with its current phase / state, its PR URL
(if any), and the PR's check-run summary,
**So that** I can answer "what's blocked? what's running? what just shipped?"
in under five seconds without opening a browser.

**Acceptance criteria**:
- [ ] Output groups issues by epic and orders them by current cockpit-state
  tier (`error` first, then `waiting`, `active`, `pending`, `terminal`,
  `unknown`) so the most attention-worthy items are at the top.
- [ ] Each row shows: issue number, short title, current phase label, current
  cockpit state, linked PR number + URL (when one exists), and a check-runs
  summary (`✓ 12 / 0` style or equivalent).
- [ ] Issues that the cockpit foundation classifies as `unknown` are still
  shown, with `unknown` in the state column — they are not silently dropped.
- [ ] When the orchestrator is unreachable (or no API token is configured),
  the command still prints the GitHub-derived view and surfaces a single
  "orchestrator unavailable: <reason>" note. It does not fail the command.
- [ ] The command exits 0 on a successful render even if some individual
  repos failed to enumerate (per-repo errors are surfaced in the footer).

### US3: Scriptable consumers

**As an** automation script that wants today's epic snapshot in a structured
form,
**I want** both verbs to support a `--json` flag,
**So that** I can pipe their output into `jq` or another tool without parsing
the human-readable layout.

**Acceptance criteria**:
- [ ] `generacy cockpit status --json` emits a single well-formed JSON
  document on stdout (no log lines mixed in) representing the same data as
  the human-readable view.
- [ ] `generacy cockpit watch` is JSON-line by default (US1's contract) and
  `--json` is accepted as a no-op alias for consistency.

## Functional Requirements

| ID     | Requirement                                                                                                                                                                       | Priority | Notes                                                                                       |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| FR-001 | Register a `cockpit` parent command on the Commander.js program and attach `watch` and `status` as subcommands.                                                                   | P1       | Follows the auto-register convention seeded by G0.1; future verbs (#788–#791) plug in here. |
| FR-002 | `watch` reads `cockpit.repos` from `.generacy/config.yaml` via `@generacy-ai/cockpit`'s `loadCockpitConfig()`, falling back to `MONITORED_REPOS` env per the foundation contract. | P1       | Reuses, does not reimplement, the foundation loader.                                        |
| FR-003 | `watch` polls each monitored repo's open issues and pull requests on a configurable interval (default 30 s, `--interval <seconds>` to override; lower bound 5 s).                 | P1       | Lower bound prevents accidental gh rate-limit blowups.                                      |
| FR-004 | `watch` classifies each issue's labels via `classify()` from the foundation package and compares against the prior-poll state held in memory.                                     | P1       | No on-disk state — survives only for the lifetime of the process.                           |
| FR-005 | `watch` emits one JSON line per transition with fields: `ts`, `repo`, `kind` (`issue` \| `pr`), `number`, `from`, `to`, `sourceLabel`, `url`. Newline-terminated.                 | P1       | Stable shape; consumers depend on it.                                                       |
| FR-006 | `watch` emits a baseline line per issue/PR on the first poll cycle with `from: null` and `to: <current state>`.                                                                   | P1       | US1 contract.                                                                               |
| FR-007 | `watch` includes transitions into `terminal` and `error` on the same stream as other transitions (not split to a separate channel).                                               | P1       | US1 contract.                                                                               |
| FR-008 | `watch` performs only `gh` read operations (`issue list`, `pr list`, `pr view`, `pr checks`). Any code path that would mutate GitHub or the orchestrator is forbidden.            | P1       | Pure-sensor invariant; enforce by import surface (no `gh issue edit` / no label-mutate API).|
| FR-009 | `watch` continues running on transient errors (gh rate-limit, network blip, malformed payload); errors are logged on stderr and the next poll retries.                            | P1       | Exits non-zero only on un-recoverable startup failures (e.g. missing config + missing env). |
| FR-010 | `status` enumerates every issue across monitored repos and resolves the epic membership via `resolveEpicIssues()` from the foundation package.                                    | P1       | Manifest-first, label-graph fallback — already implemented in #786.                         |
| FR-011 | `status` classifies each issue, fetches its linked PR (if any), and queries PR check runs via the foundation's `GhCliWrapper` (`pr checks --json`).                               | P1       | Use foundation wrapper so tests can inject a `CommandRunner`.                               |
| FR-012 | `status` queries the orchestrator's `/health`, `/queue`, `/dispatch/queue/workers` via `createOrchestratorClient()` and renders queue depth + worker count in a footer line.      | P1       | Degrades silently when the client is in stub mode (no token) — per foundation degraded mode.|
| FR-013 | `status` prints a human-readable table by default; `--json` switches to a single structured JSON document on stdout.                                                              | P1       | US3.                                                                                        |
| FR-014 | `status` groups issues by epic and sorts within each group by cockpit-state precedence: `error` > `waiting` > `active` > `pending` > `terminal` > `unknown`.                      | P2       | Matches the foundation's `TIER_RANK`.                                                       |
| FR-015 | `status` exits 0 when at least one repo enumerated successfully, even if other repos failed; per-repo failures are surfaced in a footer block.                                    | P2       | Partial-success semantics keep the dashboard useful in degraded conditions.                 |
| FR-016 | Both verbs surface `--help` text with one-paragraph summaries that name the parent epic and a link to the foundation package.                                                     | P3       | Discoverability for first-time users typing `generacy cockpit --help`.                      |

## Success Criteria

| ID     | Metric                                                                            | Target                                                | Measurement                                                                 |
| ------ | --------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------- |
| SC-001 | First-poll baseline latency for `watch` on a 25-issue epic.                       | ≤ 3 s wall-clock from process start to first emit.    | Manual run against the live G1.x epic; capture timestamps.                  |
| SC-002 | `watch` correctly emits transitions for every label change during a phase advance.| 100% of transitions in a 10-step manual phase walk.   | Drive an issue through plan→clarify→…→merged; compare emitted lines to gh.  |
| SC-003 | `status` total render time on a 25-issue epic against the live orchestrator.      | ≤ 5 s wall-clock end-to-end.                          | `time generacy cockpit status` on the G1.x epic.                            |
| SC-004 | Neither verb performs any write operation against GitHub during a 30-min soak.    | 0 mutating gh calls observed.                         | `gh api`-mock spy in a containerised test that fails on any write verb.     |
| SC-005 | Both verbs exit cleanly (exit 0) on Ctrl-C with no orphaned child processes.      | 0 zombie processes after SIGINT in a 1-hour soak.     | Spawn under a process supervisor that asserts on orphans.                   |
| SC-006 | `cockpit watch` survives a simulated 60-s GitHub outage without exiting.          | Process still running and resumes on recovery.        | `iptables` block to api.github.com for 60 s; verify resume + warn on stderr.|

## Assumptions

- The `@generacy-ai/cockpit` foundation (#786, merged) is the **only** source
  of label-to-state classification, config loading, epic resolution, gh CLI
  wrapping, and orchestrator HTTP. Both verbs depend on it and do not
  reimplement any of these primitives.
- `gh` (the GitHub CLI) is installed and authenticated in the environment
  where `generacy cockpit` runs. This is already a hard dependency of the
  foundation package, so no new bootstrapping is required.
- The cockpit config (`.generacy/config.yaml#cockpit`) is **optional** — the
  foundation degrades to `MONITORED_REPOS` and to an empty repo list with a
  warning. Both verbs inherit that behaviour: missing config is a warning,
  not a hard error.
- The orchestrator API is **optional** for both verbs. `watch` does not
  consult it; `status` uses it only to enrich the footer with queue depth +
  worker count. Both verbs are useful with the orchestrator absent.
- The cockpit `Monitor`-tool consumer expects newline-delimited JSON on
  stdout — the project's existing observability convention for streamed
  events. (Confirm with the upstream Monitor-tool contract before locking
  the on-the-wire field set during /clarify.)

## Out of Scope

- **Any GitHub mutation.** Label changes, PR labelling, comment posting,
  merging, dispatch — all belong to sibling issues (#788 cockpit `advance`,
  #789 cockpit `merge`, #791 cockpit `queue <phase>`). This issue is the
  pure read surface.
- **Persistent state.** `watch` keeps prior-state in process memory only; if
  the process restarts, it re-emits a baseline. No SQLite, no JSON file, no
  manifest writes. Manifest write is owned by #790.
- **Stuck-job detection.** Heuristics for "this issue hasn't moved in X
  hours" are owned by #793 (journal-based stuck detection). `watch` only
  reports transitions, not their absence.
- **A web UI / TUI.** Both verbs are plain stdout. A rich TUI dashboard is
  explicitly deferred and would consume `watch` rather than replacing it.
- **Webhook-driven push notifications.** The `watch` verb is poll-based on
  purpose: zero infra footprint, works behind any firewall. A webhook
  transport is a possible future optimisation but is not required to ship.
- **Multi-tenant orchestrator support.** Both verbs read a single
  orchestrator endpoint (the one in `cockpit.orchestrator.baseUrl`). Cross-
  cluster aggregation is a separate concern.

---

*Generated by speckit; enhanced from issue #787.*

# Contract: `generacy cockpit doorbell` CLI surface

Applies to `packages/generacy/src/cli/commands/cockpit/doorbell.ts` and its integration in `packages/generacy/src/cli/commands/cockpit/index.ts`.

## Command name and group

- Registered as `doorbell` under the `cockpit` command group.
- After `--help` output, `Available Commands:` MUST include `doorbell` alongside `watch`, `status`, `advance`, `context`, `merge`, `queue`, `resume`, `scope`, `mcp`.

## Argv shapes

Three arming forms + a `--help` probe.

### Form 1 — epic

```
generacy cockpit doorbell <epic-ref>
generacy cockpit doorbell <epic-ref> --exit-on-epic-complete
```

- `<epic-ref>` — any grammar accepted by `resolveIssueContext` (`<n>`, `<owner>/<repo>#<n>`, or `https://github.com/<owner>/<repo>/issues/<n>`).
- Subscribes epic bus via `acquireEpicBus({ epicRef: <positional>, … })`.

### Form 2 — tracking issue

```
generacy cockpit doorbell <tracking-ref> --tracking
```

- `<tracking-ref>` — same grammar as `<epic-ref>`.
- Subscribes tracking-ref bus via `acquireEpicBus({ epicRef: <positional>, … })` — same call, different key. `EpicEventBus` keys on any ref `resolveIssueContext` can expand, so a tracking issue works (per Clarifications Q2=A).
- `--exit-on-epic-complete` is a no-op here (tracking-ref bus never emits `epic-complete`).

### Form 3 — new tracking issue placeholder

```
generacy cockpit doorbell --new "<title>"
```

- No positional. Presence of a positional → exit 2.
- No `acquireEpicBus` call.
- Emits `armed\n` at startup, drains stdout, blocks on SIGTERM.
- `--exit-on-epic-complete` is a no-op (never emits `epic-complete`).

### `--help` probe

```
generacy cockpit doorbell --help
```

- Exit code 0.
- stdout contains a usage banner listing `<epic-ref>` (positional, optional), `--tracking`, `--new <title>`, `--exit-on-epic-complete`.
- Satisfies the skill's `auto.md` `--help` pre-flight (spec FR-008).

## Rejected argv combinations

| Input | Exit | stderr line |
|-------|------|-------------|
| No positional, no `--new`, no `--tracking` | 2 | `cockpit doorbell: parse issue: issue argument is required` |
| No positional, `--tracking` present | 2 | `cockpit doorbell: parse issue: issue argument is required` |
| Positional AND `--new` present | 2 | `cockpit doorbell: --new does not accept a positional argument` |
| Both `--tracking` and `--new` present | 2 | `cockpit doorbell: --tracking and --new are mutually exclusive` |
| Positional fails `resolveIssueContext` (e.g., bare number outside a checkout) | 2 | `cockpit doorbell: parse issue: <inner reason>` |

Line copy MUST match the table exactly — verified in `doorbell.test.ts`.

## Stdout contract

- Wake lines: one of `issue-transition\n`, `phase-complete\n`, `epic-complete\n` — the `type` word of the event, no JSON, no ref, no other content.
- Initial line (FR-010): `armed\n` — emitted once, out-of-band (not via `bus.emit`), before any wake line.
- Every line is drained before the next poll cycle (FR-006) — no block-buffered writes.
- 1:1 emit-to-line (SC-003, FR-005) — no coalescing, no filter, no dedup.

## Stderr contract

- Argv errors: as tabled above.
- Poll/resolve errors from `acquireEpicBus`'s internal loop: routed through the `logger.warn` closure — `packages/generacy/src/cli/commands/cockpit/doorbell.ts` provides a stderr-writer logger (`{ warn: msg => process.stderr.write(msg + '\n') }`) so operator-visible failure modes surface but do not corrupt stdout.
- No wake signals ever reach stderr (FR-009).

## Signal handling

- `SIGINT` and `SIGTERM` → call `release()` (from `Acquired`), drain stdout, exit 0.
- Under Form 3, `release()` is a no-op (no acquire happened); still drain and exit 0.

## Exit codes

| Code | Cause |
|------|-------|
| 0 | Normal termination — SIGTERM/SIGINT, or Form 1 + `--exit-on-epic-complete` after `epic-complete\n` emitted. |
| 1 | Unrecoverable `acquireEpicBus` failure (rare — inherits `watch.ts:129` shape). |
| 2 | Argv validation error (see table). |

## `--exit-on-epic-complete` (FR-011, Q5=B)

- Off by default.
- When on and Form 1: after emitting the `epic-complete\n` line, drain stdout via `await new Promise(r => process.stdout.write('', () => r()))`, then `process.exit(0)`.
- No-op under Form 2/3.

## Non-goals (out of scope for this contract)

- Caller MUST NOT parse stdout line content — the type-word choice is deterministic for testability only. Content is not versioned.
- No batch/aggregate wake line — each `bus.emit()` produces exactly one line.
- No JSON payload envelope. Explicit divergence from `cockpit watch`.

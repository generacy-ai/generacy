# Implementation Plan: Carry event content on the `/cockpit:auto` doorbell wake line

**Feature**: `/cockpit:auto` exhausts the GitHub GraphQL rate limit despite low event volume — root cause is a content-free doorbell wake line that forces the skill to re-query GitHub on every wake. This plan makes the doorbell emit the full `CockpitStreamEvent` as NDJSON, populates `to` locally via `classifyIssue`, and stamps a read-through `checks` verdict from the cached `PrSnapshot.checksRollup` — with **zero** net-new `gh` calls in the smee event path.
**Branch**: `985-summary-cockpit-auto-exhausts`
**Status**: Complete

## Summary

Three surgical changes in the doorbell path:

1. **NDJSON serializer** (FR-001, FR-002): `lineForEvent` at `packages/generacy/src/cli/commands/cockpit/doorbell/subscribe.ts:22-24` is rewritten to `JSON.stringify(event) + '\n'`, mirroring `watch/emit.ts:34-39`. Applies to both the poll-fallback path (`subscribeAndEmit`) and the smee path (`doorbell.ts:236-247` `onEvent` → already routes through `lineForEvent`, no separate change needed).
2. **Local `to` classification on smee** (FR-003): `buildEvent` at `packages/generacy/src/cli/commands/cockpit/doorbell/webhook-to-event.ts:109-132` calls `classifyIssue(labels)` and sets `to: classified.state`, `sourceLabel: classified.sourceLabel ?? sourceLabelArg`. `from` stays `null` (Q3=A). Zero added `gh` calls.
3. **Read-through `checks` stamp** (FR-004, FR-005): `SmeeDoorbellSource` looks up `this.prev.get(snapshotKey(repo, 'pr', number))` in `processEventBlock` for `pr-checks`/`completed:validate` events, maps `PrSnapshot.checksRollup` per the Q1=A table, and (only when the mapping yields `'green' | 'red'`) attaches `checks` to the emitted event before `this.onEvent(ev)`. The stamping is a pure post-processing pass over the events returned by `webhookToStreamEvent` — no new `gh` calls, no `maybeRefreshAggregate` fan-out, no debounced refresh.

The `armed\n` sentinel, `--exit-on-epic-complete`, and `epic-complete` exit semantics are preserved by not touching those code paths. Skill-side consumer (agency #437) parses defensively — engine change is non-breaking against a legacy bare-type consumer (SC-004).

## Technical Context

- **Language / runtime**: TypeScript, Node ≥22, ESM
- **Package**: `@generacy-ai/generacy` (`packages/generacy/`)
- **Test framework**: Vitest (per existing doorbell test suite: `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/`)
- **New dependencies**: none. Reuses:
  - `classifyIssue` from `packages/generacy/src/cli/commands/cockpit/shared/classify-issue.ts` (pure, zero I/O)
  - `snapshotKey` from `packages/generacy/src/cli/commands/cockpit/watch/snapshot.ts`
  - `CockpitEventSchema` and shape from `packages/generacy/src/cli/commands/cockpit/watch/emit.ts`
- **Type extension**: `CockpitEventSchema` gains optional `checks: z.enum(['green', 'red', 'pending']).optional()`. Enum stays 3 values (Q4=A rejects a 4th `unknown`).
- **Changeset**: `.changeset/985-doorbell-full-event-line.md`, `minor` bump for `@generacy-ai/generacy` (doorbell stdout contract change is user-observable).

## Project Structure

Files to modify:

```
packages/generacy/src/cli/commands/cockpit/
├── doorbell/
│   ├── subscribe.ts                 # rewrite lineForEvent → NDJSON (FR-001)
│   ├── webhook-to-event.ts          # buildEvent calls classifyIssue for `to` (FR-003)
│   ├── smee-source.ts               # read-through `checks` stamp (FR-004/FR-005)
│   └── __tests__/
│       ├── webhook-to-event.test.ts # extend for `to` (FR-008b)
│       └── smee-source.integration.test.ts # extend for `checks` + no-gh (FR-008c/d)
└── watch/
    └── emit.ts                      # add optional `checks` field to CockpitEventSchema (FR-002/FR-004)

.changeset/
└── 985-doorbell-full-event-line.md  # minor bump (FR-009)
```

New files:

- `specs/985-summary-cockpit-auto-exhausts/plan.md` (this file)
- `specs/985-summary-cockpit-auto-exhausts/research.md`
- `specs/985-summary-cockpit-auto-exhausts/data-model.md`
- `specs/985-summary-cockpit-auto-exhausts/contracts/line-schema.md`
- `specs/985-summary-cockpit-auto-exhausts/contracts/checks-mapping.md`
- `specs/985-summary-cockpit-auto-exhausts/quickstart.md`

Out of scope (per spec §"Out of Scope"):
- MCP-server `gh` wrapper caching + rate-limit scheduler wiring (deferred follow-up).
- Any doorbell-side GraphQL for `checks` (Q2=D rejects).
- Cross-event `from` cache on the doorbell (Q3=A rejects).
- Live end-to-end rate-limit measurement (Q5=B — reasoned inference sufficient to merge).
- `generacy-ai/agency#437` skill change (separate repo, degrades gracefully).

## Constitution Check

No `.specify/memory/constitution.md` in the tree — check skipped. Adhered to project CLAUDE.md conventions:
- **Changeset gate**: `.changeset/985-doorbell-full-event-line.md` added (minor — new capability on doorbell stdout contract). Non-test-only diff under `packages/generacy/src/` requires a changeset per CLAUDE.md.
- **No new comments unless load-bearing**: FR-005 (zero net-new `gh` calls in the smee event path) *is* load-bearing; keep the one-liner rationale on the `checks` stamp site so future readers don't accidentally reach for a `gh` call there.
- **Test-only changes exempt from changeset**: N/A — this diff touches non-test `src/` (subscribe.ts, webhook-to-event.ts, smee-source.ts, emit.ts).

## Key Decisions

| # | Decision | Source |
|---|----------|--------|
| 1 | NDJSON is the wire format. Mirror `watch/emit.ts` `emit()` exactly, not a bespoke serializer. | FR-001 |
| 2 | `to` classification happens in the pure `buildEvent`, not further upstream in `webhookToStreamEvent`, so the smee and (any future) direct-webhook callers get it for free. | FR-003 |
| 3 | `checks` mapping is strict + checks-only (`success→green`, `failure\|error→red`, `pending\|none→pending`). Mergeability stays out. | Q1=A |
| 4 | `checks` is stamped in the smee source's post-processing loop over `webhookToStreamEvent`'s returned events, keyed on `snapshotKey(repo, 'pr', number)` against `this.prev`. No `maybeRefreshAggregate` extension. | Q2=D, FR-005 |
| 5 | `checks` is **omitted** when the cached rollup would map to `pending` or when the PR isn't in `this.prev`. Skill treats absent === `pending`. | Q4=A |
| 6 | `from` on smee events stays `null`. No cross-event cache. | Q3=A |
| 7 | Enum stays 3 values (`green | red | pending`). No `unknown`. | Q4=A |
| 8 | Merge-gate authoritative query lives in the skill (agency #437), not the doorbell. | Q2=D rationale |
| 9 | Live measurement is a follow-up validation task, not a merge blocker for #985. | Q5=B |
| 10 | The `checks` stamp runs on `pr-checks` and on `label-change` events whose `sourceLabel === 'completed:validate'`. Other label-change events skip the lookup. | FR-004 |

## Next Step

Run `/speckit:tasks` to generate the task list with dependency ordering. Suggested parallelization: FR-001 (`lineForEvent`) and FR-003 (`buildEvent`) are independent; FR-004/FR-005 (`smee-source.ts` stamp) depends on the FR-002 schema extension in `emit.ts`. Tests can be written alongside each production change.

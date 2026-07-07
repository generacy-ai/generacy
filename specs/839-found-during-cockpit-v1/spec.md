# Feature Specification: Cockpit watch — startup sweep for actionable states

**Branch**: `839-found-during-cockpit-v1` | **Date**: 2026-07-07 | **Status**: Draft
**Source**: generacy-ai/generacy#839

## Summary

`generacy cockpit watch` currently prints nothing about issues that were already in an actionable state (`waiting-for:*`, `completed:validate`, `failed:*`, `needs:intervention`, `agent:error`) at the moment the watcher started. The first poll is a silent baseline and only *subsequent* label transitions produce output. A developer running the documented `queue → watch` order therefore starts a watcher that is silent about every gate already waiting on them — including the P1 gates that queue itself just moved into place.

Fix: on the very first poll, the sensor emits one NDJSON line per issue currently in an actionable state, each line marked `initial: true`. All non-actionable states stay silent at baseline. Subsequent polls remain pure transition diffs — behavior for polls 2..N is unchanged. Actionable-state classification stays in the engine (sensor); the plugin (`/cockpit:watch`) needs no change beyond treating an `initial: true` line the same as any other event line.

This is *not* the rev-2 baseline protocol resurrected. Rev 2 emitted every state (all six tiers) on the first poll and required consumers to maintain a `seen-set` for dedupe. Rev 3 emits only the *actionable subset*, and the plugin is stateless per line — so no dedupe is needed and re-surfacing still-pending items on a watch restart is the desired behavior, not noise.

## User Stories

### US1: Developer runs queue → watch and sees pending gates immediately

**As a** developer driving cockpit through the documented `queue → watch` flow,
**I want** the watcher to tell me on its first poll about every issue already sitting in an actionable state,
**So that** I don't miss gates that `queue` (or a prior run of the pipeline) placed before I re-attached my watcher.

**Acceptance Criteria**:
- [ ] After queueing a phase and waiting until all issues reach `waiting-for:clarification`, running `generacy cockpit watch <epic-ref>` produces one NDJSON line per waiting issue within the first poll cycle.
- [ ] Each such line has `initial: true` and correct `to` / `sourceLabel` fields reflecting the current state.
- [ ] The plugin (`/cockpit:watch`) renders these lines identically to a live transition — no plugin-side change is required to make US1 pass.

### US2: Watch restart re-surfaces still-pending actionable work

**As a** developer restarting a watcher that was previously killed (Ctrl-C, terminal closed, container restart),
**I want** every actionable state still pending in the epic to be re-emitted on startup,
**So that** the restart cost is zero — I always see the current actionable backlog without having to run `/cockpit:status` first.

**Acceptance Criteria**:
- [ ] Stopping and restarting `cockpit watch` on the same epic re-emits `initial: true` lines for every issue still in an actionable state.
- [ ] Emitting the same line twice across restarts is documented as expected behavior, not a bug (rev-3 plugin is stateless per line).
- [ ] Interim workaround (running `/cockpit:status` after watch) is no longer required to catch pre-existing actionable states.

### US3: Non-actionable baseline stays silent

**As an** operator watching an epic where everything is currently `phase:*` / `agent:in-progress` / `type:*` (i.e., no actionable state),
**I want** the first poll to produce zero output,
**So that** the sensor still upholds the "silence when nothing needs me" contract for the non-actionable case.

**Acceptance Criteria**:
- [ ] With every issue in a non-actionable state, the first poll emits nothing.
- [ ] Subsequent polls continue to emit only on transitions (existing rev-3 behavior).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The sensor MUST emit one NDJSON line per issue in an actionable state during the first poll. | P1 | "First poll" = poll where `prev` snapshot map is empty. One line per issue, even when the issue carries multiple actionable labels (see Q2). |
| FR-002 | The actionable-state set MUST be exactly: (a) any label matching `waiting-for:*`, `completed:validate`, `failed:*`, `needs:intervention`, `agent:error`; AND (b) for PRs only, `checksRollup === 'failure'`. | P1 | Any other `completed:*` label is NOT actionable (only `completed:validate`). Per Q5: a red-CI PR with no `failed:*` label MUST also be surfaced at first poll — the transition path (`pr-checks`) never fires when the PR started red. |
| FR-003 | Each first-poll emission MUST carry `initial: true`, `event: 'label-change'`, and `from: null` on the NDJSON payload. | P1 | Per Q1: reuses the existing `event` enum (no plugin fallback needed for a new discriminator); `from: null` renders naturally as "(none) → <state>"; `initial: true` is the explicit marker. |
| FR-004 | Transitions on polls 2..N MUST NOT carry the `initial` field at all — it MUST be absent from the emitted JSON. | P1 | Per Q3: schema is `z.literal(true).optional()`. "Field present ⇔ first poll" is the wire contract. Consumers key on truthiness (`if (event.initial)`), not on `=== false`. |
| FR-005 | Non-actionable states MUST NOT be emitted at first-poll baseline. | P1 | Rules out any accidental drift back to rev-2 "emit every state" protocol. |
| FR-006 | Actionable-state classification MUST live in the cockpit engine (sensor code), not in plugin command markdown. | P1 | Rejected alternative: plugin-side `status --json` sweep at startup. |
| FR-007 | The `/cockpit:watch` command markdown MUST require no change to render `initial: true` lines correctly. | P2 | Plugin already treats each NDJSON line as `(print notification + suggestion)`; `initial: true` participates as a normal field. |
| FR-008 | On watch restart, still-pending actionable items MUST be re-emitted as `initial: true` again (no cross-run dedupe). | P1 | This is the desired behavior — sensor holds no persistent state across runs. |
| FR-009 | The first-poll sweep MUST cover both issues and PRs — an actionable PR (e.g., PR carrying `waiting-for:review`, or with `checksRollup === 'failure'`) is emitted the same as an actionable issue. | P2 | Snapshot map already unions both kinds. Rollup-based actionability applies to PRs only. |
| FR-010 | If the first poll returns zero issues (e.g., epic body has zero refs), the sensor MUST emit nothing, matching current behavior. | P2 | No regression on empty epics. |
| FR-011 | The actionable-emission decision at first poll MUST scan the raw `labels[]` array for any label in the FR-002 set, NOT the classifier's reduced `classified.state`. The emitted line's `sourceLabel` field MUST still be `classified.sourceLabel`. | P1 | Per Q2: live counterexample — issues carrying both `completed:specify` and `waiting-for:clarification` are ranked terminal by the classifier's tier precedence, so trusting `classified.state` would skip the exact issues this feature exists to surface. One line per issue; the wider net decides emission, the classifier decides the `to` state. |
| FR-012 | Initial-sweep lines within the first poll MUST be emitted in ascending order by `(repo, kind, number)`, matching `snapshotKey` construction. | P2 | Per Q4: deterministic and directly assertable in tests. Urgency-first ordering is a consumer-side presentation concern, not the sensor's. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Silent-startup regression eliminated for actionable states | 0 | Repro from issue #839 (`queue → wait for waiting-for:clarification → cockpit watch`) produces ≥1 initial line per pending issue, measured by counting NDJSON lines within the first poll cycle. |
| SC-002 | Non-actionable baseline stays silent | 0 lines | Fixture where every issue is `phase:plan` / `agent:in-progress`: first poll emits 0 NDJSON lines. |
| SC-003 | Restart re-surfacing works | 100% | Kill and restart watch against an epic with N pending actionable issues; second run emits N initial lines within its first poll. |
| SC-004 | Existing transition semantics unchanged | 0 regressions | All existing watch tests in `packages/generacy/src/cli/commands/cockpit/watch/__tests__` continue to pass unmodified except for baseline-related assertions that were previously testing "silent first poll for actionable states". |
| SC-005 | `initial` field is machine-verifiable | 100% valid | Every NDJSON line emitted during first poll validates against the updated `CockpitEventSchema` with `initial: true`, `event: 'label-change'`, `from: null`; every subsequent-poll line validates with the `initial` field ABSENT (schema: `z.literal(true).optional()`). |
| SC-006 | No actionable-state literal duplication | 1 source | The list of actionable labels/states appears in exactly one file (a new engine-side classifier). Grep for `'completed:validate'` outside that file returns nothing new. |
| SC-007 | Label-scan sweep catches classifier-outranked actionable labels | 100% recall | Fixture: an issue carrying both `completed:specify` AND `waiting-for:clarification` MUST produce one initial line (regression guard for the Q2 counterexample). |
| SC-008 | Initial-sweep ordering is deterministic | Byte-stable | Given a fixed input snapshot, the first-poll NDJSON output is byte-identical across runs when compared line-for-line, sorted by `(repo, kind, number)`. |
| SC-009 | Red-CI PRs surfaced at baseline | 0 missed | Fixture: a PR with `checksRollup === 'failure'` and no `failed:*` label MUST produce one initial line at first poll (regression guard for the Q5 concern). |

## Assumptions

- The rev-3 sensor plugin (`/cockpit:watch` command markdown) remains stateless per line and does not maintain any cross-line dedupe. Re-emission of an unchanged actionable state across restarts is acceptable UX.
- The existing `Snapshot`/`SnapshotMap` types, classification pipeline, and `CockpitEvent` shape are load-bearing and should be extended additively rather than rewritten.
- `initial: true` is a new field on `CockpitEvent` (and its Zod schema); adding it does not break any downstream cloud/UI consumer of the NDJSON stream (per Q1, current consumers are the cockpit plugin only).
- The list of actionable states in the issue text (`waiting-for:*`, `completed:validate`, `failed:*`, `needs:intervention`, `agent:error`) is exhaustive for v1; adding new states later is a follow-up.
- Behavior when a PR is in an actionable state (e.g., `waiting-for:review`) mirrors issues one-for-one — no PR-specific special case is needed at first-poll time.

## Out of Scope

- Consumer/plugin-side rendering changes (see FR-007 — the plugin doesn't need to know about `initial: true`).
- Any change to the classifier's *tier* mapping (`waiting`/`error`/`terminal`/etc.) — the actionable-state set is a *sub-classification* on top of the existing tiers, not a replacement.
- Baseline emission for non-actionable states (rev-2 semantics) — explicitly excluded.
- Cross-run state persistence, dedupe, or a `seen-set` file — the sensor stays stateless per run.
- Cloud-side or UI consumers of the NDJSON stream — none exist yet (the plugin is the only consumer today).
- Changes to `cockpit status` or `cockpit advance` output formats.

## Clarifications

Batch 1 — 2026-07-07 (see [`clarifications.md`](./clarifications.md)):

- **Q1 → A**: First-poll lines use `event: 'label-change'`, `from: null`, `initial: true`. No new `event` enum value (protects FR-007).
- **Q2 → B**: Actionable-emission decision scans raw `labels[]` (not `classified.state`) to avoid the tier-precedence trap where `completed:specify` outranks `waiting-for:*`. Emitted `sourceLabel` still comes from the classifier. One line per issue.
- **Q3 → A**: On polls 2..N, the `initial` field is ABSENT (not present-and-false). Schema: `z.literal(true).optional()`. Consumers key on truthiness.
- **Q4 → A**: Initial-sweep lines sort by `(repo, kind, number)` ascending. Deterministic; matches `snapshotKey`.
- **Q5 → B**: PRs with `checksRollup === 'failure'` (and no `failed:*` label) MUST also be emitted at first poll. FR-002 amended accordingly. Rationale: the initial sweep must show what the transition stream would have shown had the watcher been running, collapsed to current state — and `pr-checks` transitions never fire for a PR that started red.

## Design Notes (for reference — refined during `/speckit:plan`)

- Emission plumbing lives in `packages/generacy/src/cli/commands/cockpit/watch/diff.ts` (`computeTransitions`) — the `if (prev.size === 0) return [];` guard on line ~134 is the exact place to branch into the startup-sweep code path.
- The actionable-state classifier is new engine surface; the only file that hard-codes the list should be a single module (e.g., `packages/cockpit/src/state/actionable.ts` or a new file under `packages/generacy/src/cli/commands/cockpit/watch/`), consumed by `computeTransitions`. The check operates on the raw `Snapshot.labels[]` array (Q2), not the reduced `classified.state`.
- `CockpitEventSchema` in `emit.ts` gains `initial: z.literal(true).optional()` (Q3 — strict typing; field is either `true` or absent, never `false`).
- Behavior on polls 2..N stays byte-identical to today for downstream compatibility.
- Sweep sort key: `(repo, kind, number)` ascending, matching `snapshotKey` construction (Q4).
- The actionable predicate takes both `labels[]` AND (for PRs only) the `checksRollup` field (Q5).

---

*Generated by speckit — enhanced per issue #839.*

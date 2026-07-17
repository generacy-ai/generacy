# Feature Specification: ## Summary

`/cockpit:auto` exhausts the GitHub GraphQL rate limit (5000 pts/hr) despite very low actual event volume

**Branch**: `985-summary-cockpit-auto-exhausts` | **Date**: 2026-07-17 | **Status**: Draft

## Summary

## Summary

`/cockpit:auto` exhausts the GitHub GraphQL rate limit (5000 pts/hr) despite very low actual event volume. A full trace of the wake → dispatch path shows the cause is a **wake-then-re-query** design: the doorbell tells the agent *something* happened but not *what*, so the agent re-queries GitHub on every wake to reconstruct state it was already handed in the webhook payload.

This issue covers the **generacy engine** side. The paired skill change is generacy-ai/agency#437 — both must land together (a content-ful line with no skill update is simply ignored; see the cross-repo note below).

## Root cause (traced)

**1. The doorbell wake line is content-free.** `webhookToStreamEvent` → `buildEvent` already constructs a full event from the smee webhook — `{ repo, kind, number, event, sourceLabel, labels, url, ts }`, with **zero GitHub calls** — but `lineForEvent` collapses it to just the discriminator:

```ts
// packages/generacy/src/cli/commands/cockpit/doorbell/subscribe.ts:22-24
export function lineForEvent(event: CockpitStreamEvent): string {
  return `${event.type}\n`;   // "issue-transition" | "phase-complete" | "epic-complete"
}
```

The sibling `cockpit watch` command already serializes the whole event as NDJSON (`JSON.stringify(validated)`, `packages/generacy/src/cli/commands/cockpit/watch/emit.ts:34-39`) — the doorbell simply chose the bare-type serializer.

**2. So the agent re-queries.** Per actionable event, the auto skill calls `cockpit_status(json=true)`, which fans out ≈ `2 + repos + refs + PRs` GraphQL calls (~28 for a 15-ref epic). A single wake coalescing ~3 events ≈ **~95 GraphQL calls**; ~50 wakes/hr → 5000.

**3. Amplifier (secondary).** The 20s `createGhResponseCache` + `createRateLimitScheduler` are wired only into the doorbell subprocess (`doorbell.ts:604-606`); the MCP server builds a bare `new GhCliWrapper(runner)` (`mcp/server.ts:50`, `packages/cockpit/src/resolver/resolve.ts` + `resolver.ts:166,170`, `ref-input.ts:99`) — so the high-frequency per-event path is uncached and unthrottled.

## Proposed change (generacy)

1. **Emit the full event on the doorbell line** — make `lineForEvent` serialize the whole `CockpitStreamEvent` as NDJSON (mirror `watch/emit.ts` `emit()`), for both the smee path (`doorbell.ts` `onEvent`) and the poll-fallback path (`subscribe.ts` `subscribeAndEmit`).

2. **Classify the target gate-state locally on the smee path.** `doorbell/webhook-to-event.ts` currently sets `from: null, to: null` (lines 126-127). The poll path computes `from`/`to` via the pure `classifyIssue` in `watch/diff.ts` over the label array — no GitHub call. Apply the same classification to the webhook's `issue.labels` so the line carries the authoritative `to` state (e.g. `waiting-for:clarification`, `completed:validate`, `agent:error`).

3. **Bake the merge-gate verdict into the event server-side.** The one thing not in a single webhook is "are *all* required checks green + is the PR mergeable" (dispatch classes D.5/D.6). The doorbell already recomputes aggregate state via `maybeRefreshAggregate` for `phase-complete`/`epic-complete`; extend it to stamp a `checks: green|red|pending` field onto `pr-checks` / `completed:validate` events, computed **once**, so the agent never re-derives it.

4. *(Follow-up / optional hardening)* Wire `{ cache, rateLimitScheduler }` into the MCP server's `gh` wrapper. Note: caching `cockpit_status` risks serving stale state right after a webhook — which is likely why it's uncached today. Once (1)–(3) remove the per-event re-query, this amplifier is largely moot, so treat it as a lower-priority follow-up, not a blocker.

## Acceptance criteria

- The doorbell (smee and poll-fallback) writes one NDJSON line per event carrying at minimum `{ type, repo, kind, number, event, to, labels, url }`.
- On the smee path, `to` is populated by local label classification with **no added GitHub call**.
- `pr-checks` / `completed:validate` events carry a `checks` verdict computed in the doorbell.
- The `armed\n` sentinel line and the `--exit-on-epic-complete` / `epic-complete` exit semantics are preserved.
- Existing doorbell tests updated; changeset included (minor — the doorbell stdout contract changes).

## Cross-repo coordination

Per our one-issue-per-repo rule, the auto-skill consumer lives in generacy-ai/agency#437 (`claude-plugin-cockpit/commands/auto.md` must parse the line content and drop the per-event `cockpit_status` re-check, incl. removing the `auto.md:53` "the parent NEVER parses lines for content" mandate). Land in lockstep. The skill change is written to degrade gracefully against a bare-type line, so ordering is not load-bearing at runtime, but both are needed for the rate-limit fix to take effect.

## Context

Follow-up to the doorbell real-time work (#970 / #978 / #980). PR #982 (classify rate-limit errors as retriable) is defense-in-depth for when the limit *is* hit — this issue removes the load that hits it.


## User Stories

### US1: `/cockpit:auto` doesn't burn the GraphQL rate limit while idle

**As a** developer running `/cockpit:auto` over a multi-ref epic,
**I want** each doorbell wake line to carry enough content that the skill can dispatch without re-querying GitHub,
**So that** a full auto session stays well under the 5000 pts/hr GraphQL quota instead of exhausting it in ~1 hour.

**Acceptance Criteria**:
- [ ] Doorbell (smee and poll-fallback) emits one NDJSON line per event carrying `{ type, repo, kind, number, event, to, labels, url }` at minimum.
- [ ] Smee-path `to` is populated by local `classifyIssue` over `issue.labels` with **zero** added GitHub calls.
- [ ] `pr-checks` / `completed:validate` events carry an optional `checks` field when a cached PR-side rollup is available (`green` or `red`); the field is omitted otherwise.
- [ ] `armed\n` sentinel and `--exit-on-epic-complete` / `epic-complete` exit semantics preserved.
- [ ] Skill-side consumer (agency #437) can degrade gracefully against a bare-type line — engine change is non-breaking if the skill is not yet updated.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Doorbell serializes the full `CockpitStreamEvent` as NDJSON on every event line (both smee `onEvent` in `doorbell.ts` and poll-fallback `subscribeAndEmit` in `subscribe.ts`), mirroring the `watch/emit.ts` `emit()` shape. | P1 | Replaces the content-free `${event.type}\n` line at `subscribe.ts:22-24`. |
| FR-002 | Line schema at minimum: `{ type, repo, kind, number, event, to, labels, url }`. `from` is included but always `null` on smee-originated events (see Q3=A). | P1 | Consumers **must not** rely on `from` for smee lines. |
| FR-003 | Smee path populates `to` by calling the pure `classifyIssue` (`watch/diff.ts`) over `webhook.issue.labels`. **Zero** added GitHub calls. Replaces the `from: null, to: null` at `doorbell/webhook-to-event.ts:126-127`. | P1 | Local classification only. |
| FR-004 | For `pr-checks` and `completed:validate` events, if a cached `checksRollup` exists on the associated `PrSnapshot` (from the periodic poll), stamp an optional `checks: 'green' \| 'red' \| 'pending'` field on the emitted event using the strict mapping in the Assumptions section. Otherwise, **omit** the field entirely. | P1 | Read-through only — see FR-005. |
| FR-005 | The doorbell smee event path **must not** issue any net-new `gh` / GraphQL calls for `checks` computation. No per-event `maybeRefreshAggregate` fan-out, no targeted PR queries, no debounced aggregate refresh. | P1 | Enforces SC-002. Verified by static analysis + unit test in FR-008. |
| FR-006 | `armed\n` sentinel line preserved on both paths. | P1 | Backward-compat with existing skill parser. |
| FR-007 | `--exit-on-epic-complete` and `epic-complete`-triggered exit semantics preserved. | P1 | |
| FR-008 | New/updated unit tests assert (a) smee-path line is valid JSON parseable to the schema in FR-002, (b) `to` matches `classifyIssue(labels)`, (c) no `gh` invocations occur in the smee event path, (d) `checks` is present only when the PR snapshot's cached rollup is `success` (→ `green`) or `failure\|error` (→ `red`). | P1 | |
| FR-009 | Changeset entry added (`minor` — doorbell stdout contract changes). | P1 | CI gate requirement per project CLAUDE.md. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | GraphQL points consumed per hour by an idle `/cockpit:auto` session on a 15-ref epic (with agency #437 also landed). | ≤ ~500 pts/hr (down from 5000). | **Reasoned inference** at merge time (per Q5=A): satisfy FR-001–FR-005 + FR-008 static-call analysis. Live end-to-end `gh api rate_limit` delta measurement is a documented **follow-up validation** task once both PRs are in — it does not block merging #985. |
| SC-002 | Net-new GitHub calls added in the doorbell **smee** event path per event. | 0 | Static analysis: grep the smee event path for `gh`/`graphql` invocations added by this change; unit test FR-008(c). Applies to both `to` classification (FR-003) and `checks` stamping (FR-004/FR-005). |
| SC-003 | Doorbell stdout regression on the poll-fallback path. | 0 | Existing poll-path tests pass; NDJSON schema matches the smee path. |
| SC-004 | Breakage for consumers still on the bare-type line format. | 0 | Skill (agency #437) parses defensively; engine change ships behind no flag. Documented in cross-repo section. |

## Assumptions

- **`checks` value mapping (Q1=A)**: `success` → `green`; `failure \| error` → `red`; `pending \| none` → `pending`. PR mergeability is **not** folded into `checks` — mergeability already surfaces via the `merge-conflicts` label (dispatch class D.11) and is present in `to` / `labels`. `none` maps to `pending` (not `green`) so the skill falls back to one authoritative query rather than risk a premature `green` before required checks post.
- **`checks` cost profile (Q2=D)**: `checks` is computed **only** by reading through the periodic poll's cached `PrSnapshot.checksRollup`. No doorbell-side GraphQL. Staleness up to the poll interval is acceptable.
- **`from` on smee events (Q3=A)**: Always `null`. The doorbell keeps no cross-event classification state. Dispatch keys on `to`, so `from` adds no signal.
- **`checks` absence semantics (Q4=A)**: When the cached rollup is unavailable (no PR yet, snapshot not populated, rollup value is `pending` or `none`), the field is **omitted entirely** — the skill treats absent identically to `pending` and falls back to a single authoritative merge-gate query (agency #437 Q4=B).
- **SC-001 acceptance (Q5=B)**: Reasoned inference unblocks #985; live measurement is a follow-up.
- Skill (agency #437) parses NDJSON defensively and degrades to bare-type behavior against a legacy line — so this engine change is not ordering-coupled at runtime.

## Out of Scope

- Wiring `{ cache, rateLimitScheduler }` into the MCP server's `gh` wrapper (secondary amplifier from the root-cause analysis §3). Once FR-001–FR-005 remove the per-event re-query, this is a lower-priority follow-up, not a blocker.
- Any doorbell-side GraphQL for `checks` (explicitly rejected — Q2=D).
- Maintaining an in-memory `from` cache on the doorbell (explicitly rejected — Q3=A).
- Extending the `checks` enum with a 4th sentinel like `'unknown'` (explicitly rejected — Q4=A).
- Live end-to-end rate-limit-delta measurement on the #985 PR itself (deferred to follow-up validation per Q5=B).
- The paired skill change in `generacy-ai/agency#437` — separate repo, tracked separately, degrades gracefully.

---

*Generated by speckit*

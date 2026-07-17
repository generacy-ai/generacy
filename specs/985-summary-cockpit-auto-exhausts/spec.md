# Feature Specification: Carry event content on the `/cockpit:auto` doorbell wake line

**Branch**: `985-summary-cockpit-auto-exhausts` | **Date**: 2026-07-17 | **Status**: Draft
**Issue**: [generacy-ai/generacy#985](https://github.com/generacy-ai/generacy/issues/985)
**Paired skill change**: [generacy-ai/agency#437](https://github.com/generacy-ai/agency/issues/437) — must land in lockstep

## Summary

`/cockpit:auto` exhausts the GitHub GraphQL rate limit (5000 pts/hr) despite very low actual event volume. Tracing the wake → dispatch path shows a **wake-then-re-query** design: the doorbell tells the agent *something* happened but not *what*, so the agent re-queries GitHub on every wake to reconstruct state that was already handed to the doorbell in the webhook payload.

This issue covers the **generacy engine** side — extending the doorbell's stdout line from a bare event-type discriminator to a content-ful NDJSON payload, and stamping locally-computable classification (gate `to` state) plus the merge-gate check verdict onto the line so the consumer never re-derives them from GitHub.

## Root Cause (traced)

**1. The doorbell wake line is content-free.**
`webhookToStreamEvent` → `buildEvent` already constructs a full event from the smee webhook (`{ repo, kind, number, event, sourceLabel, labels, url, ts }`), **zero GitHub calls** — but `lineForEvent` collapses it to just the discriminator:

```ts
// packages/generacy/src/cli/commands/cockpit/doorbell/subscribe.ts:22-24
export function lineForEvent(event: CockpitStreamEvent): string {
  return `${event.type}\n`;   // "issue-transition" | "phase-complete" | "epic-complete"
}
```

The sibling `cockpit watch` command already serializes the whole event as NDJSON (`JSON.stringify(validated)`, `packages/generacy/src/cli/commands/cockpit/watch/emit.ts:34-39`) — the doorbell simply chose the bare-type serializer.

**2. So the agent re-queries.** Per actionable event, the auto skill calls `cockpit_status(json=true)`, which fans out ≈ `2 + repos + refs + PRs` GraphQL calls (~28 for a 15-ref epic). A single wake coalescing ~3 events ≈ **~95 GraphQL calls**; ~50 wakes/hr → 5000.

**3. Amplifier (secondary).** The 20s `createGhResponseCache` + `createRateLimitScheduler` are wired only into the doorbell subprocess (`doorbell.ts:604-606`); the MCP server builds a bare `new GhCliWrapper(runner)` (`mcp/server.ts:50`) — so the high-frequency per-event path is uncached and unthrottled.

## User Stories

### US1: Operator runs `/cockpit:auto` without hitting the GitHub rate limit

**As a** developer driving an epic to terminal via `/cockpit:auto`,
**I want** the doorbell to hand the agent enough event content to dispatch without re-querying GitHub,
**So that** a long-running `/cockpit:auto` session doesn't exhaust the 5000 pts/hr GraphQL budget mid-run and strand the epic.

**Acceptance Criteria**:
- [ ] After landing (with the paired skill change), a 1-hour `/cockpit:auto` session over a typical 15-ref epic makes ≤ ~500 GraphQL points, an order of magnitude below today's ~5000.
- [ ] Zero net-new GitHub calls are added inside the doorbell smee path per event (classification is local).
- [ ] Merge-gate verdict (`checks: green|red|pending`) travels on `pr-checks` / `completed:validate` events.

### US2: Consumer of the doorbell stream can dispatch on line content alone

**As a** consumer of the doorbell subprocess (`/cockpit:auto` skill, and any future consumer),
**I want** each stdout line to be a self-describing NDJSON event with `type`, `repo`, `kind`, `number`, `event`, `to`, `labels`, `url`,
**So that** I can classify and dispatch actionable events without a follow-up `cockpit_status` call per event.

**Acceptance Criteria**:
- [ ] Every event line is valid NDJSON parseable by the `CockpitStreamEvent` Zod schema (already used by `cockpit watch`).
- [ ] `armed\n` sentinel remains a bare literal line (not JSON) so existing `--armed`-signaling logic is unaffected.
- [ ] `--exit-on-epic-complete` exits after emitting the `epic-complete` NDJSON line, matching current semantics.

### US3: Doorbell stays observable and testable end-to-end

**As a** maintainer of `packages/generacy/src/cli/commands/cockpit/doorbell/`,
**I want** the line-emission contract exercised by tests on both the smee path and the poll-fallback path,
**So that** future regressions collapsing lines back to bare-type strings are caught in CI.

**Acceptance Criteria**:
- [ ] Existing doorbell tests updated to assert NDJSON payload shape (not just the discriminator).
- [ ] At least one test covers the smee path emitting a classified `to` gate state from labels alone (no `gh` calls in test setup).
- [ ] At least one test covers a `pr-checks` / `completed:validate` event carrying a `checks` verdict.

## Functional Requirements

| ID     | Requirement                                                                                                                                                        | Priority | Notes                                                                             |
|--------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|-----------------------------------------------------------------------------------|
| FR-001 | `lineForEvent` (`doorbell/subscribe.ts`) MUST serialize the whole `CockpitStreamEvent` as NDJSON, mirroring `watch/emit.ts:emit()`.                                 | P1       | Single point of change for the line format.                                        |
| FR-002 | Change applies to both the smee webhook path (`doorbell.ts` `onEvent`) and the poll-fallback path (`subscribe.ts` `subscribeAndEmit`).                              | P1       | Consumers cannot depend on which path produced the line.                           |
| FR-003 | On the smee path, `webhook-to-event.ts` MUST populate `to` (and `from` when derivable) via `classifyIssue` over `issue.labels` — no GitHub call added.               | P1       | Poll path already does this; parity is the goal.                                   |
| FR-004 | Merge-gate check verdict MUST be stamped on `pr-checks` and `completed:validate` events as `checks: 'green' \| 'red' \| 'pending'`, computed once in the doorbell.  | P1       | Extend the existing `maybeRefreshAggregate` pathway.                               |
| FR-005 | The `armed\n` sentinel line MUST remain a bare literal (not JSON-wrapped) to preserve current arming detection.                                                     | P1       | See `doorbell.ts`; consumers grep for the literal.                                 |
| FR-006 | `--exit-on-epic-complete` MUST still exit after emitting the `epic-complete` line, in the new NDJSON shape.                                                         | P1       | Semantics preserved, format changed.                                               |
| FR-007 | Emitted event lines MUST validate against the existing `CockpitStreamEvent` Zod schema (extended with the optional `checks` field where applicable).                | P1       | One schema, both consumers.                                                        |
| FR-008 | A changeset (minor bump — the doorbell stdout contract is a public interface for the skill) MUST be added to `.changeset/`.                                          | P1       | Required by the repo-wide changeset CI gate; see CLAUDE.md.                        |
| FR-009 | *(Follow-up / optional)* Wire `{ cache, rateLimitScheduler }` into the MCP server's `gh` wrapper (`mcp/server.ts:50`) so the resolver path is also cached/throttled. | P3       | Lower priority once FR-001–FR-004 remove the per-event re-query load.               |

## Success Criteria

| ID     | Metric                                                             | Target                                             | Measurement                                                                                              |
|--------|--------------------------------------------------------------------|----------------------------------------------------|----------------------------------------------------------------------------------------------------------|
| SC-001 | GraphQL points consumed per hour by a running `/cockpit:auto`.     | ≤ ~500 pts/hr (down from ~5000 pts/hr).             | Observed on a 15-ref epic with the paired skill change #437 landed. `gh api rate_limit` snapshots.        |
| SC-002 | Net-new GitHub calls added to the doorbell smee path per event.    | 0.                                                 | Static inspection + tests asserting no `gh` invocations in `webhook-to-event.ts` classification path.     |
| SC-003 | Doorbell stdout line format is NDJSON on both paths.               | 100 % of non-sentinel lines parse as NDJSON.        | Existing + new doorbell tests.                                                                            |
| SC-004 | `armed\n` and `epic-complete` exit semantics preserved.            | Zero regression.                                    | Existing exit-semantics tests still pass with no modification of their assertions on `armed`.             |

## Assumptions

- The paired skill change ([`generacy-ai/agency#437`](https://github.com/generacy-ai/agency/issues/437)) will drop the per-event `cockpit_status` re-check and instead parse the NDJSON line content, including removing the `auto.md:53` "the parent NEVER parses lines for content" mandate. Ordering is not load-bearing at runtime (skill degrades gracefully against bare-type lines), but both must land for the rate-limit fix to take effect.
- `classifyIssue` in `watch/diff.ts` is authoritative for gate-state derivation from labels alone — no additional context required. It's the same function the poll path already uses.
- `maybeRefreshAggregate` is the right stamping point for `checks` verdicts; the doorbell is already the site of aggregate-state recomputation for `phase-complete` / `epic-complete`.
- The `CockpitStreamEvent` Zod schema can be extended with an optional `checks` field without a breaking-change to `cockpit watch` consumers.

## Out of Scope

- Cloud-side rate-limit dashboarding / alerting (defense in depth).
- Retry classification for `403`/`429` rate-limit failures — already covered by PR #982.
- Reworking `cockpit_status` fan-out shape (~28 GraphQL calls for a 15-ref epic). This spec removes the per-event *invocation* of `cockpit_status`; it does not touch what happens when it *is* invoked.
- Wiring caching/throttling into the MCP `gh` wrapper (FR-009 — captured as follow-up, not blocker).
- Any change to the `armed\n` sentinel format.

## Cross-Repo Coordination

Per our one-issue-per-repo rule, the auto-skill consumer lives in [generacy-ai/agency#437](https://github.com/generacy-ai/agency/issues/437). The skill must:
- Parse the NDJSON line content directly.
- Drop the per-event `cockpit_status` re-check.
- Remove the `auto.md:53` "the parent NEVER parses lines for content" mandate.

Land in lockstep. The skill change is written to degrade gracefully against a bare-type line, so ordering is not load-bearing at runtime — but the rate-limit fix requires both.

## Context

Follow-up to the doorbell real-time work (#970 / #978 / #980). PR #982 (classify rate-limit errors as retriable) is defense-in-depth for when the limit *is* hit — this issue removes the load that hits it.

---

*Generated by speckit*

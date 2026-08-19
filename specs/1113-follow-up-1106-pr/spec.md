# Feature Specification: Pin the PrSnapshot read-through path (follow-up to #1106)

**Branch**: `1113-follow-up-1106-pr` | **Date**: 2026-08-19 | **Status**: Draft
**Workflow**: `speckit-bugfix`

## Summary

Follow-up to #1106 / PR #1109 (merged as `674cc228`). PR #1109 fixed the PrSnapshot
cache-key casing bug centrally, inside `snapshotKey` (`watch/snapshot.ts:46`), and every
non-test caller routes through it: `watch/poll-loop.ts:93` (write side — key built from
the operator-typed epic-body `repo`) and `doorbell/smee-source.ts:375` (read side — key
built from the GitHub-canonical webhook `ev.repo`). That fix is correct and is pinned by
`snapshotKey — #1106 case-insensitive lookup invariant` unit tests.

Those tests pin the **invariant in isolation** (`snapshotKey('A/B', …) === snapshotKey('a/b', …)`)
but nothing asserts that `SmeeDoorbellSource.processEventBlock` actually *routes through*
`snapshotKey` when it reads the read-through `PrSnapshot` cache. The write side (poll-loop)
stores normalized (lowercased) keys; the read side (smee-source) is the only place a naive
refactor could re-introduce the casing mismatch.

**This is a test-only change.** The #1106 production fix is complete and mutation-verified;
this feature adds the missing regression coverage and makes no production code change.

## Failure Scenario Being Pinned

A future refactor inlines the lookup key at `smee-source.ts:375` as
`` `${ev.repo}#pr#${ev.number}` `` (payload-canonical casing) while `poll-loop` keeps
writing normalized keys via `snapshotKey`. For an epic whose body references
`Painworth/Doc-Intel` (operator casing) while GitHub emits canonical `painworth/doc-intel`
(or vice-versa), every `pr-checks` / `completed:validate` event's cache lookup misses and
the event is emitted with `checks: undefined` again — and the **whole suite stays green**,
because no test exercises the call path with a case mismatch across the write/read boundary.

The existing integration tests in `doorbell/__tests__/smee-source.integration.test.ts`
(lines ~377–483) populate `prev` with `snapshotKey('o/r', 'pr', 42)` and drive events with
the same lowercase `o/r` repo — so no casing divergence is exercised and an inlined lookup
would still pass. This is the same class of gap round-2 review caught one level down in
`buildRefSet`.

## User Stories

### US1: Read-through cache path is regression-protected against casing drift

**As a** maintainer of the cockpit doorbell,
**I want** a test that drives `processEventBlock` end-to-end with a write/read casing
mismatch across the `snapshotKey` boundary,
**So that** any future refactor that inlines the `smee-source.ts:375` lookup key (dropping
the `snapshotKey` normalization) turns the suite red instead of silently re-shipping the
`checks: undefined` bug.

**Acceptance Criteria**:
- [ ] New **dedicated `it` block(s)** are added; the existing lowercase `it.each`
      (`smee-source.integration.test.ts:355-392`) and `completed:validate` tests are left
      unchanged (they are the control pinning `error`/`pending` mappings under homogeneous
      casing). *(Clarified Q2=A)*
- [ ] A test populates the `prev` `SnapshotMap` the way `poll-loop` does — a `PrSnapshot`
      whose key is derived through `snapshotKey`, with a write/read casing mismatch.
- [ ] **Both casing-divergence directions** are covered: (1) write mixed-case
      (`Painworth/Doc-Intel` via `snapshotKey`) + read canonical-lowercase payload, and
      (2) write canonical-lowercase + read **mixed-case** payload. Direction (2) is
      load-bearing: because `snapshotKey` lowercases at write time, only a mixed-case
      *payload* surfaces the inlined line-375 lookup mutation. *(Clarified Q1=B)*
- [ ] Each direction drives `processEventBlock` with both a `pr-checks` and a
      `completed:validate` `label-change` event.
- [ ] The test asserts the emitted `CockpitStreamEvent` has `checks` set to the expected
      wire value (from `mapChecks(snap.checksRollup)`) — **not** `undefined`.
- [ ] Rollup breadth is a **single representative per branch** (`success`→green for both
      `pr-checks` and `completed:validate`); `pending`/`none` rollups are excluded as they
      map to `undefined` regardless of hit/miss and add no mutation-sensitivity. *(Clarified Q3=A)*
- [ ] Mutation check: replacing `snapshotKey(ev.repo, 'pr', ev.number)` at `smee-source.ts:375`
      with an inlined `` `${ev.repo}#pr#${ev.number}` `` makes the new test fail (killed by the
      read-mixed direction).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add **dedicated `it` block(s)** (not folded into the existing `it.each`; existing lowercase tests left unchanged) that drive `SmeeDoorbellSource.processEventBlock` via the existing harness in `smee-source.integration.test.ts`, with a `prev` cache and payload exhibiting a write/read casing mismatch. | P1 | Reuse existing `setPrev` / `fakePrSnapshot` helpers. Dedicated-`it` precedent at line 209. *(Q2=A)* |
| FR-002 | The test MUST assert the emitted event's `checks` field equals the expected wire value derived from the cached `PrSnapshot.checksRollup`, for both the `pr-checks` event and the `completed:validate` `label-change` event branches at `smee-source.ts:369–373`. Use a **single representative rollup** (`success`→green) per branch. | P1 | Both branches share the read-through lookup. Skip `pending`/`none` (both map to `undefined`). *(Q3=A)* |
| FR-003 | Cover **both** casing-divergence directions: (1) write mixed-case via `snapshotKey` + read canonical-lowercase payload, and (2) write canonical-lowercase + read **mixed-case** payload. Direction (2) is the only one sensitive to the inlined line-375 lookup (since `snapshotKey` lowercases at write time). | P1 | The read-mixed casing divergence is the load-bearing part. *(Q1=B)* |
| FR-004 | No production code change. Only test file(s) under `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/` are added or modified. | P1 | Test-only bugfix. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | New test passes against current `smee-source.ts`. | Green | `pnpm --filter @generacy-ai/generacy test smee-source` |
| SC-002 | Mutation sensitivity: inlining the `snapshotKey` lookup at `smee-source.ts:375` with payload-canonical casing turns the new test red. | Red on mutation | Manually apply the mutation, run the suite, confirm failure, revert. |
| SC-003 | Change is test-only. | 0 non-test production lines changed | `git diff --stat` shows only `__tests__/` files. |

## Assumptions

- The existing integration harness (`setPrev`, `fakePrSnapshot`, `processEventBlock` access
  via `as unknown as` cast) in `smee-source.integration.test.ts` is the right place to add
  the new case-mismatch scenario; no new harness is required.
- `mapChecks` (imported in `smee-source.ts`) maps `checksRollup` → wire `checks` value; the
  test asserts against its output for a known rollup (e.g. `success` → green, `failure` → red).
- A `pr-checks` or `completed:validate` payload can be constructed through the existing
  `webhookToStreamEvent` path such that it emits an `issue-transition` event matching the
  read-through branch condition.

## Out of Scope

- Any change to the #1106 production fix (`snapshotKey` normalization, `buildRefSet`,
  `webhook-to-event.ts`, `scope/writer.ts`, `queue.ts`) — that work is complete and verified.
- Adding read-through cache coverage for `IssueSnapshot` (only `PrSnapshot` at
  `smee-source.ts:375` is in scope).
- Refactoring `smee-source.ts` or `snapshot.ts`.

---

*Generated by speckit*

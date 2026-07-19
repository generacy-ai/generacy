# Clarifications

**Feature**: Carry event content on the `/cockpit:auto` doorbell wake line
**Issue**: [generacy-ai/generacy#985](https://github.com/generacy-ai/generacy/issues/985)

## Batch 1 — 2026-07-17

### Q1: `checks` value mapping
**Context**: FR-004 introduces `checks: 'green' | 'red' | 'pending'`. The existing `ChecksRollup` type in `watch/snapshot.ts:6` has 5 values (`pending | success | failure | none | error`), and the root-cause section mentions "all required checks green + PR is mergeable". Without a defined mapping, implementation and tests can't be written consistently.
**Question**: How should each existing state map to the 3-value `checks` field, and does `green` require PR mergeability in addition to check state?
**Options**:
- A: Strict mapping — `success` → `green`; `failure|error` → `red`; `pending|none` → `pending`. Mergeability is **not** factored in (checks-only).
- B: Merge-gate mapping — `green` = all checks `success` **AND** PR `mergeable === true`; `red` = any check `failure|error` **OR** PR `mergeable === false`; `pending` = anything else (including `none`).
- C: Nullable `green` — same as A, but `none` (no checks configured) maps to `green` (nothing to gate on) rather than `pending`.

**Answer**: **A** — strict checks-only mapping (`success` → `green`; `failure|error` → `red`; `pending|none` → `pending`). Deliberately keep PR mergeability OUT of `checks`: mergeability already surfaces as the `merge-conflicts` label (→ dispatch class D.11) and is captured in `to`/`labels`, so folding it into `checks` would conflate two concerns and muddy the field. Map `none` → `pending` (not `green`) so the skill falls back to one authoritative query rather than risk a premature `green` when required checks haven't posted yet.

### Q2: How `checks` is computed on the doorbell without re-adding load
**Context**: FR-004 says "computed once in the doorbell" via `maybeRefreshAggregate`. But `maybeRefreshAggregate` currently invokes `runOnePoll` (~28 GraphQL calls per 15-ref epic) and today only fires on completion triggers, never on `pr-checks`. Extending it to `pr-checks` (which fires per check-run completion — dozens per PR) and `completed:validate` label events could re-introduce the very load this issue removes, conflicting with SC-002 ("zero net-new GitHub calls added in the doorbell smee path per event").
**Question**: What is the intended cost profile for computing `checks`?
**Options**:
- A: Full `maybeRefreshAggregate` fan-out per `pr-checks` / `completed:validate` event (accept the added cost; SC-002 applies only to `to` classification, not to `checks`).
- B: Lightweight targeted query — a single "check status for this PR" GraphQL call per event (not a full epic aggregate refresh).
- C: Coalesce/debounce — one refresh per epic per short window (e.g. dedupe within 5s) even if multiple `pr-checks` events arrive, and reuse the last-computed rollup for events inside the window.
- D: Read-through from the existing periodic poll's cached `checksRollup` on the PR's `PrSnapshot`; do not perform any doorbell-side GraphQL for `checks` — accept possible staleness up to the poll interval.

**Answer**: **D** — no doorbell-side GraphQL for `checks`. Read through the cached `checksRollup` on the PR snapshot when one is available; otherwise leave it absent. Rationale: `pr-checks` fires per check-run (dozens per PR), so any per-event query (A/B) or even a debounced aggregate refresh (C) re-introduces exactly the load this issue removes and violates SC-002. The merge decision (D.5/D.6) fires at most once per issue at the terminal gate, so the single authoritative query belongs there in the skill (agency #437 Q4=B), not eagerly in the doorbell. Keeps the smee event path at zero net-new calls.

### Q3: `from` on smee-path events
**Context**: FR-003 says the smee path should populate `to` (and `from` when derivable) via `classifyIssue` over `issue.labels`. But `classifyIssue` returns the current classification only — deriving `from` requires knowing the previous classification. The poll path (`watch/diff.ts`) gets it by diffing prev/curr snapshots; the smee path receives only the post-transition webhook payload.
**Question**: What should `from` be on smee-path events?
**Options**:
- A: Always `null` on smee events. Only `to` is populated. Consumers must not rely on `from` for smee-originated lines.
- B: Doorbell maintains an in-memory per-issue last-seen classification cache (keyed on `${owner}/${repo}#${number}`) so `from` can be filled on subsequent smee events. Cache warm-up: cold start → `null`; falls back to `null` on cache miss.
- C: `from` is `null` for `label-change` events but populated for lifecycle transitions where the "from" is implicit (e.g. `issue-closed` → `from` = current classification derived from labels).

**Answer**: **A** — `from` is always `null` on smee-path events; only `to` is populated. Dispatch keys on `to`, not `from`, so filling `from` buys nothing, and the in-memory last-seen cache (B) adds stateful complexity that is unreliable across cold start / cache miss / doorbell restart. Consumers must not rely on `from` for smee-originated lines.

### Q4: `checks` when computation fails or the PR isn't resolvable
**Context**: `maybeRefreshAggregate` already fails gracefully (returns identity output on `resolveEpic` or `runOnePoll` errors, per `aggregate-on-demand.ts:64,82`). For `completed:validate` label events on an issue, the associated PR may not exist yet (spec/plan phase). For `pr-checks` events, the check query may time out. FR-004 doesn't specify how `checks` should appear on the emitted line in these cases.
**Question**: When `checks` cannot be authoritatively determined, what appears on the event line?
**Options**:
- A: Field is omitted entirely (optional in the schema).
- B: Field is set to `'pending'` — indistinguishable from checks legitimately in-flight.
- C: Field is set to a distinct sentinel value (e.g. `'unknown'` — requires extending the enum to 4 values).
- D: Field is omitted if there is no associated PR at all; set to `'pending'` if the PR exists but check state is unresolved.

**Answer**: **A** — omit `checks` entirely when it cannot be authoritatively determined (optional field; enum stays 3 values). The skill treats absent and `pending` identically (fall back to one query — see agency #437 Q4=B), so a distinct sentinel (C) or the omit/pending split (D) adds branching with no behavioural payoff. `checks` is present only when a cached rollup is decisively `green` or `red`.

### Q5: SC-001 measurement obligation
**Context**: SC-001 targets ≤ ~500 GraphQL pts/hr "on a 15-ref epic with the paired skill change #437 landed". But #437 is in a separate repo (`generacy-ai/agency`) and per the spec "ordering is not load-bearing at runtime". This affects definition-of-done for #985 in isolation: does merging #985 require an actual live measurement (requires #437 already landed), or does it require only that the engine-side changes make the reduction *possible* once #437 lands?
**Question**: What does "meeting SC-001" require for this issue's PR?
**Options**:
- A: Actual measurement — a live `/cockpit:auto` run over a 15-ref epic with #437 landed, reporting `gh api rate_limit` deltas. #985 blocks on #437 for this reason.
- B: Reasoned inference — merging #985 is unblocked as long as FR-001–FR-004 are satisfied and static analysis confirms no new `gh` calls in the smee event path; the measurement is a follow-up validation task (documented as such).
- C: Synthetic bench — a doorbell-only integration test with a stubbed skill consumer that asserts zero `cockpit_status` calls when NDJSON lines are consumed; treated as a proxy for SC-001.

**Answer**: **B** — reasoned inference unblocks #985: satisfy FR-001–FR-004 and confirm via static analysis + unit tests that the smee event path adds zero new `gh` calls. Do not block #985 on #437 landing (A): the spec says ordering is not load-bearing, and cross-repo merge coupling would deadlock. The live end-to-end GraphQL-delta measurement is a documented follow-up validation task once both PRs are in.

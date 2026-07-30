# Research: PR review feedback must continue processing after a workflow completes

## Decision log

### D1: Evidence prefix set for the widened orchestration guard

**Decision**: `agent:*` OR `workflow:*` OR `completed:*`.

**Rationale**:
- `workflow:*` is added at dispatch alongside `agent:in-progress` (`label-monitor-service.ts:399-403`) and is **never removed** by any code path in either repo. Grep-verified across `packages/orchestrator/src/**/*.ts` and `packages/generacy/src/cli/commands/cockpit/**/*.ts`.
- `completed:*` is only cleared by the requeue path (`label-monitor-service.ts:397-403`), which re-adds `workflow:*` in the same `addLabels` call. So the union `{workflow:*, completed:*}` is never simultaneously empty on an issue that has been orchestrated at least once.
- `agent:*` is retained in the set for currently-active workflows so the old happy path keeps working with zero behaviour change during the workflow's active phases.

**Rejected alternatives**:
- **Sticky `agent:*` while unmerged PR is open** (issue's Option 1) — needs a hook that removes it on merge/close. No such hook exists: the issue-webhook consumer only handles `action === 'labeled'` (`routes/webhooks.ts:71-73`), no `pull_request.closed`/`merged` consumer runs, and `cockpit merge` mutates zero issue labels. Shipping this creates a new invariant with no maintainer.
- **Accept ANY of the four prefixes including `phase:*`** — see D2.
- **Only `workflow:*`** — too strict. `resolveWorkflowFromLabels` explicitly documents pre-existing issues that legitimately lack `workflow:*` (`label-monitor-service.ts:259-270`) but do carry `completed:*` after finishing. Rejecting these would regress a live path.

**Source**: clarifications.md Q1=B, spec Assumptions lines 116-117, `label-monitor-service.ts:259-270,397-403`.

### D2: Exclude `phase:*` from the guard's positive evidence set

**Decision**: `phase:*` alone is not sufficient orchestration evidence.

**Rationale**:
- `phase:*` is the least durable of the four prefixes — removed at phase start, phase complete, and wholesale by `ensureCleanup` (`label-manager.ts:171-177`, `:205`, `:395-403`).
- `workflow:<name>` and `agent:in-progress` are added in the SAME `addLabels` call at dispatch, before any phase runs. So an issue cannot reach `phase:specify` without already carrying `workflow:*` — the "workflow assigned but engine dropped it before writing `workflow:*`" case doesn't exist in this engine.
- `phase:*` is load-bearing for `LabelMonitorService` bookkeeping — a human hand-applying it would trigger unrelated engine behaviour, meaning accepting it as guard evidence would double-count as a workflow-mutating action.

**Source**: clarifications.md Q4=B, spec Assumptions line 117.

### D3: Discriminate `PrLinker` return type to name the failing gate

**Decision**: Replace `linkPrToIssue: Promise<PrToIssueLink | null>` with a discriminated union:
```ts
type PrLinkResult =
  | { kind: 'ok'; link: PrToIssueLink }
  | { kind: 'no-link' }
  | { kind: 'no-issue'; issueNumber: number }
  | { kind: 'not-orchestrated'; issueNumber: number };
```

**Rationale**:
- FR-005 requires the monitor's `info` log to name which of `no-link` / `assignees-empty` / `not-orchestrated` fired.
- The current `null` return collapses "no link found" and "link found but issue not orchestrated" into the same signal at the call site.
- A second `getIssue` call at the monitor to re-derive the gate would double the API cost per drop (and is racy against label edits).

**Rejected alternatives**:
- **Second `getIssue` in monitor** — costs +1 API call per drop; racy across label edits.
- **`{ link: PrToIssueLink | null; reason: string }` shape** — less type-safe than the discriminant; harder to exhaustively check.
- **Callback / observer for logging inside `PrLinker`** — inverts control, spreads log-level policy into the linker.

**Blast radius verification**: grep-audit of `PrLinker` callers:
```
packages/orchestrator/src/services/pr-feedback-monitor-service.ts  (only prod caller)
packages/orchestrator/src/worker/__tests__/pr-linker.test.ts       (tests)
```
Zero external consumers. Widening the return type is safe.

### D4: Log-level gating strategy for FR-004

**Decision**: Lift to `info` only when `probeUnresolvedThreads(...)` returns true, called at drop time (not at happy-path time).

**Rationale**:
- Spec FR-004 explicitly scopes the level lift to "PR has pending human feedback that the monitor is declining to process". The whole point is diagnostic signal — zero-unresolved drops are boring noise.
- Two of the three gates (no-link, not-orchestrated) fire BEFORE the existing GraphQL `getPRReviewThreads` call at `:201`, so we cannot piggyback on the existing fetch for level gating.
- The extra GraphQL call is **only on the drop branch**. Steady-state healthy polling pays nothing. Per FR-004 the wrong-cluster gate is explicitly excluded from this treatment — it stays at `debug` unconditionally, so we don't pay the probe cost on foreign-cluster PRs (the dominant volume in a shared repo).
- GraphQL budget impact analysis: 8 monitored repos × ~5 PRs each × 60s poll = ~2400 polls/hour. Under normal ops the vast majority of these produce `link.kind === 'ok'` and enter the existing GraphQL branch — the probe is redundant with the main fetch. Only on drops (link null OR not-orchestrated OR assignees-empty) does the probe add cost. In the bug state (issue at `completed:validate`, monitor dropping every review) the probe fires up to ~2400 times/hour per stuck PR — one order of magnitude below the 5k/hr limit and the cost lands only during exactly the diagnostic window operators care about.

**Rejected alternatives**:
- **Lift all three gates unconditionally** — floods `info` logs on repos with many non-orchestrated PRs (open-source contributions, dependabot PRs).
- **Lift only after N consecutive drops** — stateful; needs new bookkeeping in `MonitorState`; incident-response value is negligible (operators would see the transition anyway).
- **Reuse an existing thread-count cache** — the monitor's `lastUnresolvedThreadCount` map is only populated on the happy path (`:283, :315, :355, :363`); on a drop the cache is empty by construction.

### D5: Merged-PR detection source

**Decision**: Read `payload.pull_request.merged` from the webhook; hardcode `prMerged: false` on the poll path.

**Rationale**:
- The webhook payload always carries `merged: boolean` and `merged_at: string | null` (GitHub PR webhook schema, applicable to `pull_request_review.submitted` and `pull_request_review_comment.created`).
- The poll path uses `client.listOpenPullRequests(owner, repo)` (`pr-feedback-monitor-service.ts:577`) which returns only open PRs by definition — so `prMerged` is guaranteed false on that path.
- Placing the signal on the event object (rather than re-fetching PR state in the monitor) keeps the gate a pure-function check and avoids racing against the merge itself.

**Rejected alternatives**:
- **Fetch `client.getPullRequest(owner, repo, prNumber)` in the monitor** — extra API call per event; racy against post-merge state; makes the poll path pay for a signal it doesn't need.
- **Check `payload.pull_request.state === 'closed'`** — `state` doesn't distinguish "merged" from "closed without merging"; `merged` is the authoritative field.

### D6: Gate location for merged-PR — before or after `PrLinker`?

**Decision**: Before `PrLinker`.

**Rationale**:
- Spec US4: "The gate fires BEFORE any checkout / fetch / push code path can run — it is a pre-enqueue gate, not a handler-side abort."
- Placing it first also avoids the GraphQL `getPRReviewThreads` cost on merged PRs, which is a small budget win.
- No dependency on link resolution — the merged signal comes from the event, not the linked issue.

### D7: No changes to `cockpit_advance`

**Decision**: `cockpit_advance` behaviour unchanged.

**Rationale**:
- Per Q1=B: the chosen evidence-set (`workflow:*` / `completed:*`) is preserved by `cockpit_advance` already. `cockpit advance` at `advance.ts:168` only ADDS `completed:<gate>` — it removes nothing.
- The actual `agent:paused` stripper is `LabelManager.onResumeStart` (`label-manager.ts:345-347`), which is irrelevant once the guard no longer keys on `agent:*`.
- Spec Out of Scope explicitly excludes advance-side changes.

## Implementation patterns

### Prefix-set check pattern

Match the codebase's existing style for label prefix testing:
```ts
issue.labels.some((l) => ORCHESTRATION_PREFIXES.some((p) => l.name.startsWith(p)))
```
Rather than an inline three-way OR. Matches `l.startsWith('blocked:')` idiom already used in `pr-feedback-monitor-service.ts:342` and `label-monitor-service.ts` `blocked:` skip loop.

### Discriminated-union return pattern

Follows the same shape used elsewhere in orchestrator (`AdaptivePollDecision`, `MonitorState` variants). Keeps exhaustive `switch (result.kind)` checks tractable in TypeScript strict mode.

### Log-line convention

Match the `blocked:*` skip log at `pr-feedback-monitor-service.ts:342-353` for the info-level drop shape:
```ts
this.logger.info(
  { owner, repo, prNumber, issueNumber?, gate: '<name>', ... },
  `PR-feedback event dropped by ${gate} gate (...)`,
);
```

## Key sources

- **spec.md** (this feature)
- **clarifications.md** (this feature) — Q1=B, Q2=B, Q3=B, Q4=B
- `packages/orchestrator/src/worker/pr-linker.ts:115` — current guard
- `packages/orchestrator/src/services/pr-feedback-monitor-service.ts:148-182` — four-gate drop chain
- `packages/orchestrator/src/services/label-monitor-service.ts:259-270,397-403` — durability proof for the evidence set
- `packages/orchestrator/src/worker/label-manager.ts:171-177,205,345-347,395-403` — `phase:*` and `agent:paused` removal sites (proving the exclusion + Q1 rationale)
- `packages/generacy/src/cli/commands/cockpit/advance.ts:168` — advance-only-adds-completed:* proof
- `packages/generacy/src/cli/commands/cockpit/merge.ts:306` — merged-branch deletion path (motivates FR-008)
- `packages/orchestrator/src/services/repo-checkout.ts:110` — `git fetch origin` without `--prune` (proves the resurrected-branch defect)
- `packages/orchestrator/src/routes/pr-webhooks.ts:74-92` vs `pr-feedback-monitor-service.ts:546,570` — webhook forwards all reviews; poll lists open only

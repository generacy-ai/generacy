# Implementation Plan: PR review feedback must continue processing after a workflow completes

**Feature**: Widen the PR-feedback orchestration guard so reviews on completed workflows still enqueue; make silent drops observable; block reviews on merged PRs from resurrecting deleted branches.
**Branch**: `1049-problem-pr-review-feedback`
**Status**: Complete

## Summary

Three surgical changes ship in one PR:

1. **`PrLinker.linkPrToIssue` orchestration guard** (`packages/orchestrator/src/worker/pr-linker.ts`) — replace the `agent:*`-only test with a union: `agent:*` OR `workflow:*` OR `completed:*`. `phase:*` alone is deliberately excluded. Restores the enqueue path for reviews posted after `completed:validate` (FR-001, FR-002, FR-003, FR-006).

2. **Drop-gate log-level lift + gate naming** (`packages/orchestrator/src/services/pr-feedback-monitor-service.ts`) — the three qualifying drop gates in `processPrReviewEvent` (no-link, assignees-empty, not-orchestrated) log at `info` and name the responsible gate whenever the PR has at least one unresolved review thread. The wrong-cluster gate stays at `debug` unconditionally (FR-004, FR-005). Because two of the three gates fire *before* the GraphQL `getPRReviewThreads` call, they need a cheap "has unresolved threads" check; a REST `getPRReviewCommentCount` (or existing GraphQL abbreviated fetch) is used only when the gate is about to drop, so happy-path polls pay nothing extra.

3. **Merged-PR gate** (`packages/orchestrator/src/services/pr-feedback-monitor-service.ts` + `packages/orchestrator/src/routes/pr-webhooks.ts` + `packages/orchestrator/src/types/monitor.ts`) — extend `PrReviewEvent` with a `prMerged: boolean` field; webhook route reads it from `payload.pull_request.merged`; monitor rejects merged PRs before `PrLinker` runs, logging at `info` with the gate name (FR-008). Poll path always sets `false` (poll lists open PRs only), so this gate protects the webhook path specifically.

No changes to `parsePrBody`, the assignee-cluster check, the thread-trust filter, or the `blocked:*` skip gate (FR-007). No changes to `cockpit_advance` (Q1=B; the chosen evidence-set is durable across advance by construction).

## Technical Context

- **Language / runtime**: TypeScript (Node.js ≥22, ESM)
- **Test framework**: Vitest (existing suites: `pr-linker.test.ts`, `pr-feedback-monitor-service.test.ts`, `pr-webhooks.test.ts`)
- **Dependencies**: None added. Uses existing `@generacy-ai/workflow-engine` `GitHubClient` interface, existing `PrLinker`, existing webhook payload type.
- **Packages touched**:
  - `@generacy-ai/orchestrator` (source + tests) — non-test src/ changes → changeset required, `patch` bump (defect fix under `workflow:speckit-bugfix`).
- **Changeset**: `.changeset/1049-pr-feedback-post-validate-guard.md` — `@generacy-ai/orchestrator: patch`. New label vocabulary is NOT introduced (existing labels reused as read-only evidence), so no `workflow-engine` bump.

## Project Structure

```
packages/orchestrator/src/
├── worker/
│   ├── pr-linker.ts                           # MODIFY: widen orchestration guard (FR-001)
│   └── __tests__/pr-linker.test.ts            # MODIFY: add union-guard tests (SC-002)
├── services/
│   ├── pr-feedback-monitor-service.ts         # MODIFY: log-level lift + merged-PR gate (FR-004, FR-005, FR-008)
│   └── __tests__/pr-feedback-monitor-service.test.ts  # MODIFY: gate-log-level tests + merged-gate tests (SC-004, SC-006)
├── routes/
│   ├── pr-webhooks.ts                         # MODIFY: populate PrReviewEvent.prMerged from payload
│   └── __tests__/pr-webhooks.test.ts          # MODIFY: assert merged-PR event carries prMerged=true (SC-006)
├── types/
│   └── monitor.ts                             # MODIFY: PrReviewEvent gains prMerged: boolean
└── __tests__/
    └── pr-feedback-integration.test.ts        # OPTIONAL: end-to-end regression covering all four gates

.changeset/
└── 1049-pr-feedback-post-validate-guard.md    # NEW: @generacy-ai/orchestrator: patch

specs/1049-problem-pr-review-feedback/
├── spec.md                                    # UNCHANGED (read-only)
├── clarifications.md                          # UNCHANGED
├── plan.md                                    # THIS FILE
├── research.md                                # NEW
├── data-model.md                              # NEW
├── quickstart.md                              # NEW
└── contracts/
    ├── orchestration-guard.md                 # NEW: predicate contract
    └── drop-gate-logging.md                   # NEW: log-line contract
```

## Change Detail

### 1. `PrLinker.linkPrToIssue` — widen guard (FR-001)

Current (`pr-linker.ts:115`):
```ts
const isOrchestrated = issue.labels.some((l) => l.name.startsWith('agent:'));
```

Replace with:
```ts
const ORCHESTRATION_PREFIXES = ['agent:', 'workflow:', 'completed:'] as const;
const isOrchestrated = issue.labels.some((l) =>
  ORCHESTRATION_PREFIXES.some((prefix) => l.name.startsWith(prefix)),
);
```

- `phase:*` intentionally excluded per Q4=B — least durable prefix, engine bookkeeping, plausibly hand-applied.
- Log-line wording updated: `'Linked issue carries no orchestration evidence (no agent:*, workflow:*, or completed:* label) — skipping non-orchestrated issue'`. Log level stays `debug` here; the info-level naming happens at the monitor-service call site (`pr-feedback-monitor-service.ts:150-154`), where the "has unresolved thread" signal is available.
- No API change to `PrLinker`; no change to link resolution or `parsePrBody`.

### 2. Monitor drop-gate log-level lift + naming (FR-004, FR-005)

The three qualifying gates in `PrFeedbackMonitorService.processPrReviewEvent`:

- **G-link** (`:149-154`): `link === null` from `PrLinker`.
- **G-assignees-empty** (`:162-167`): `clusterGithubUsername` set AND `assignees.length === 0`.
- **G-not-orchestrated**: the `null` path from `PrLinker` when link resolved but orchestration check failed. Today this collapses into G-link because `PrLinker` returns `null` for both. **Design decision**: `PrLinker` returns a discriminated result so the monitor can distinguish and name the gate. See §3 below.

The wrong-cluster gate (`:169-174`) stays `debug` per Q3=B — expected steady-state noise in multi-cluster shared repos, runs before the GraphQL fetch.

**Log-level decision** (per FR-004): only lift to `info` when the PR has at least one unresolved review thread. Since two of the three gates fire *before* the GraphQL thread fetch, we need a cheap probe. Approach:

- Extract a small helper `probeUnresolvedThreads(client, owner, repo, prNumber): Promise<boolean>` that runs the existing `getPRReviewThreads` GraphQL call and returns `threads.some(t => !t.isResolved)`. Only invoked at drop time (i.e. off the hot path). One extra GraphQL call per dropped-review event on the info branch — not per poll cycle.
- **Not** called for the wrong-cluster gate (Q3=B / spec Assumption line 118), preserving the GraphQL budget on foreign-cluster PRs.

Log-line shape:
```
logger.info(
  { owner, repo, prNumber, issueNumber?, gate: 'not-orchestrated' | 'no-link' | 'assignees-empty' },
  `PR-feedback event dropped by ${gate} gate (PR has ${count} unresolved thread(s))`,
);
```

At `debug` (PR has zero unresolved threads), the existing log lines are preserved with only the `gate:` field added — no behaviour change under quiet PRs.

### 3. `PrLinker` result discrimination (implementation seam for FR-005)

`PrLinker.linkPrToIssue` today returns `PrToIssueLink | null`. Widen the failure shape so the monitor can name the gate:

```ts
type PrLinkFailure =
  | { kind: 'no-link' }
  | { kind: 'no-issue'; issueNumber: number }             // getIssue threw
  | { kind: 'not-orchestrated'; issueNumber: number };    // guard rejected
type PrLinkResult = { kind: 'ok'; link: PrToIssueLink } | PrLinkFailure;
```

- Non-breaking to internal callers: only two exist (`pr-feedback-monitor-service.ts:148`, `label-monitor-service.ts` for `agent:paused` resume — read-only usage of a link result, if any). Every caller is inside `@generacy-ai/orchestrator/src`.
- `PrLinker` continues to log the *reason* at `debug`; the *level lift* is the caller's responsibility (only the monitor cares).
- Alternative considered: keep the current `null` return and re-fetch the issue in the monitor to determine which gate fired. Rejected — costs a second `getIssue` call per drop.

### 4. Merged-PR gate (FR-008)

`PrReviewEvent` (in `packages/orchestrator/src/types/monitor.ts:76-89`) gains one field:
```ts
export interface PrReviewEvent {
  ...
  prMerged: boolean;  // NEW: true when the PR is merged (webhook path only)
}
```

- **Webhook** (`pr-webhooks.ts:109-116`): populate `prMerged: payload.pull_request.merged ?? false`. Extend `GitHubPrReviewWebhookPayload.pull_request` (in `types/monitor.ts:124-131`) with `merged?: boolean; merged_at?: string | null`. Both optional — the GitHub payload always includes them for the review events we filter to (`pull_request_review.submitted`, `pull_request_review_comment.created`), but keeping them optional preserves backward-compat with any test doubles.
- **Poll** (`pr-feedback-monitor-service.ts:pollRepo`): `listOpenPullRequests` guarantees `state === 'open'`, so we can hardcode `prMerged: false` when constructing `PrReviewEvent`.
- **Gate location** (`processPrReviewEvent`, first thing after `Processing PR review event from ${source}`):
  ```ts
  if (event.prMerged) {
    logger.info(
      { owner, repo, prNumber, gate: 'merged-pr', source },
      'PR-feedback event dropped by merged-pr gate (PR is merged; reviews on merged PRs are not processed)',
    );
    return false;
  }
  ```
- Runs **before** `PrLinker` (spec: "gate fires BEFORE any checkout / fetch / push code path can run — it is a pre-enqueue gate"). No probe required — merged state is a first-class signal in the event.

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo (checked). Applying CLAUDE.md rules instead:

- ✅ Changeset gate: `.changeset/1049-pr-feedback-post-validate-guard.md` added — `@generacy-ai/orchestrator: patch` (defect fix, `workflow:speckit-bugfix`). No new public API on `workflow-engine`; the label vocabulary is *read* not *written*.
- ✅ Do not add error handling for scenarios that can't happen: the merged-PR gate reads `event.prMerged`, which is populated at both source sites. Optional `payload.pull_request.merged` gets a `?? false` default — that's a boundary sanitization, not defensive validation.
- ✅ No new abstractions beyond what the task requires: the union-prefix check is one predicate; the `PrLinkResult` discriminated union is the minimum needed to name the failing gate.
- ✅ No comments explaining what code does. One comment explains **why** `phase:*` is excluded (Q4 rationale is non-obvious and load-bearing).
- ✅ No documentation files created outside `specs/`.

## Acceptance Mapping

| Acceptance criterion | Delivered by |
|---|---|
| US1: Post-validate reviews still enqueue | Widened guard in `PrLinker` (§1) |
| US1: Regardless of workflow | Guard is workflow-agnostic (all `workflow:*` accepted) |
| US1: Re-review after `cockpit_advance` still enqueues | Evidence-set (`workflow:*` / `completed:*`) is untouched by advance (Q1=B) |
| US2: No speckit labels → still rejected | Same predicate, negated: none of the three prefixes present ⇒ null return |
| US2: `phase:*` alone → still rejected | `phase:*` excluded from prefix list (Q4=B) |
| US2: No `Closes #NNNN` → still rejected at link stage | Link stage unchanged (FR-007) |
| US3: Drop on PR with unresolved thread → `info` + gate name | Log-level lift in monitor (§2) |
| US3: Wrong-cluster stays at `debug` | Explicit carve-out (Q3=B) |
| US3: Zero-unresolved drops stay at `debug` | Probe returns false ⇒ level stays `debug` |
| US4: Reviews on merged PRs don't enqueue | Merged-PR gate (§4) |
| US4: Merged refusal logged at `info` with gate name | Same log-line shape as §2 |
| US4: Gate fires before checkout/fetch/push | Pre-enqueue location in `processPrReviewEvent` |

## Success Criteria → Test Mapping

- **SC-001**: New test in `pr-linker.test.ts` — issue with only `completed:validate` label → returns non-null link. Also in `pr-feedback-monitor-service.test.ts` — full path enqueues.
- **SC-002**: `pr-linker.test.ts` — `[{ name: 'phase:specify' }]` → returns null with `kind: 'not-orchestrated'`; `[]` → returns null.
- **SC-003**: Test asserts guard accepts `workflow:speckit-feature` + `completed:validate` + `completed:implementation-review` (post-advance shape) — no dependence on any `agent:*` label.
- **SC-004**: `pr-feedback-monitor-service.test.ts` — mock a PR with one unresolved thread + inject each of the three gates → assert `logger.info` called with `gate: <name>` field. Wrong-cluster case with unresolved thread → assert `logger.debug` called (not `info`).
- **SC-005**: Observational (post-ship monitoring — not a test artifact).
- **SC-006**: `pr-webhooks.test.ts` extension — webhook payload with `pull_request.merged: true` → `processPrReviewEvent` called with `prMerged: true` → asserted no enqueue + `info` log with `gate: 'merged-pr'`. Sibling assertion in `pr-feedback-monitor-service.test.ts` that no `git`-touching code path (checkout, fetch, push) runs.

## Rollout & Risk

- **Blast radius**: three files changed + tests. All changes gated by the existing monitor invocation site — no new call sites.
- **Regression risk in adjacent flow**: the `PrLinker` return-type widening from `PrToIssueLink | null` to `PrLinkResult` is the only public-shape change inside orchestrator. Grep-verified: only `pr-feedback-monitor-service.ts` consumes it. Callers that just want the link get `result.kind === 'ok' ? result.link : null`.
- **Log-volume risk**: FR-004's log-level lift adds at most one `info` line per PR per poll cycle per drop, only on PRs that already have unresolved threads. Existing monitor already emits one `info` line per poll cycle (`Processing PR review event from poll` at `:134-137`); volume roughly doubles for PRs stuck in a drop state, which is exactly the diagnostic signal operators want.
- **Rollback**: single revert. Feature flag not needed — the bug being fixed is a false-negative silent drop, not a false-positive engagement.

## Next Step

`/speckit:tasks` to generate the ordered task list.

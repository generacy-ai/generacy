# Contract: Drop-gate Logging

**Location**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` — `processPrReviewEvent`.

## Gate catalogue

Five gates can reject a `PrReviewEvent` before enqueue. Their ordering, log level, and message shape are specified below.

| # | Gate | Condition | Order | Level policy | Names itself? |
|---|---|---|---|---|---|
| G1 | `merged-pr` | `event.prMerged === true` | **1st** (before `PrLinker`) | Always `info` | Yes |
| G2 | `no-link` | `PrLinker` returns `{ kind: 'no-link' }` | 2nd | `info` if PR has ≥1 unresolved thread, else `debug` | Yes |
| G3 | `not-orchestrated` | `PrLinker` returns `{ kind: 'not-orchestrated', ... }` | 2nd | `info` if PR has ≥1 unresolved thread, else `debug` | Yes |
| G3b | `no-issue` | `PrLinker` returns `{ kind: 'no-issue', ... }` (getIssue threw) | 2nd | `warn` (unchanged — this is a transient error, not a policy drop) | Yes |
| G4 | `assignees-empty` | `clusterGithubUsername` set AND `link.assignees.length === 0` | 3rd | `info` if PR has ≥1 unresolved thread, else `debug` | Yes |
| G5 | `wrong-cluster` | `clusterGithubUsername` set AND `!assignees.includes(clusterGithubUsername)` | 4th | **Always `debug`** (Q3=B — expected steady-state noise) | Field present but level fixed |

Existing gates that remain unchanged in log-level policy but should carry the same `gate:` field for consistency:
- `blocked:*` (`pr-feedback-monitor-service.ts:342-353`) — already `info`; add `gate: 'blocked-label-present'` field for parity.
- Zero-unresolved (`:265-282`) — stays `debug`/`info` on transition-edge; no gate field needed (not a drop with pending feedback).
- Zero-trusted (`:291-317`) — stays `warn`; no gate field needed.

## Log-line shape

### Level-lifted gates (G2, G3, G4)

```ts
this.logger.info(
  {
    owner,
    repo,
    prNumber,
    issueNumber?,   // present when link resolved (G3, G4); absent for G2
    gate: '<gate-name>',
    source,
    unresolvedThreads: <number>,
  },
  `PR-feedback event dropped by <gate-name> gate (PR has <N> unresolved thread(s))`,
);
```

When the PR has zero unresolved threads, the same site emits:
```ts
this.logger.debug(
  {
    owner, repo, prNumber, issueNumber?, gate: '<gate-name>', source,
    unresolvedThreads: 0,
  },
  `PR-feedback event dropped by <gate-name> gate (no unresolved threads)`,
);
```

### Merged-PR gate (G1)

Fires before any probe or link work. Always `info`.
```ts
this.logger.info(
  { owner, repo, prNumber, gate: 'merged-pr', source },
  'PR-feedback event dropped by merged-pr gate (PR is merged; reviews on merged PRs are not processed)',
);
```

### Wrong-cluster gate (G5)

Unchanged from today. Add `gate:` field for uniformity.
```ts
this.logger.debug(
  { owner, repo, issueNumber, prNumber, assignees, gate: 'wrong-cluster', source },
  'Skipping PR feedback: linked issue not assigned to this cluster',
);
```

### No-issue gate (G3b)

Unchanged from today's `PrLinker` warn. If we surface it at the monitor:
```ts
this.logger.warn(
  { owner, repo, prNumber, issueNumber, gate: 'no-issue', source },
  'PR-feedback event dropped by no-issue gate (linked issue could not be fetched)',
);
```

## Probe helper

```ts
async function probeUnresolvedThreads(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<number>;   // returns count of unresolved threads (any trust)
```

- Reuses existing `client.getPRReviewThreads(owner, repo, prNumber)`.
- Filters `threads.filter(t => !t.isResolved)`.
- **Not** invoked for G1 (merged-pr — hardcoded `info`) or G5 (wrong-cluster — hardcoded `debug`).
- **Not** invoked for the level-lifted gates (G2, G3, G4) when `event.source === 'poll'`. The poll path iterates every open PR in every monitored repo on every cycle; an unconditional GraphQL probe there would amplify to ~60 queries/hour per unlinked/non-orchestrated/unassigned PR against a shared 5 000/hr GitHub budget, and an `info` line per such PR would spam every 60 s indefinitely. Poll-source drops always log at `debug` regardless of thread count.
- Errors during the probe are non-fatal — the drop log falls back to `debug` with `probeError: <msg>` field. (Rationale: the probe is an observability aid; a failed probe must not itself become an error signal.)

### Poll-path log-line shape

```ts
this.logger.debug(
  { owner, repo, prNumber, issueNumber?, gate: '<gate-name>', source: 'poll' },
  `PR-feedback event dropped by <gate-name> gate (poll path — probe skipped)`,
);
```

## Invariants asserted by tests (SC-004)

- **INV-1**: A `no-link` drop on a PR with 1 unresolved thread emits exactly one `logger.info` call whose object has `gate: 'no-link'` and whose message contains `no-link`.
- **INV-2**: An `assignees-empty` drop on a PR with 1 unresolved thread emits exactly one `logger.info` call with `gate: 'assignees-empty'`.
- **INV-3**: A `not-orchestrated` drop (issue with only `bug` label) on a PR with 1 unresolved thread emits exactly one `logger.info` call with `gate: 'not-orchestrated'`.
- **INV-4**: A `wrong-cluster` drop on a PR with 1 unresolved thread emits `logger.debug`, NOT `logger.info`. Assertion is negative on `.info` and positive on `.debug`.
- **INV-5**: A `merged-pr` drop always emits `logger.info` with `gate: 'merged-pr'`, regardless of thread count. The probe is not called.
- **INV-6**: A drop of any type on a PR with 0 unresolved threads emits `logger.debug` (not `info`). Also asserts `.info` is NOT called for that drop.

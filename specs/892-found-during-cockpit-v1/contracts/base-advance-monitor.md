# Contract: `BaseAdvanceMonitorService`

**Feature**: `892-found-during-cockpit-v1`
**Covers**: FR-001, FR-002; Q1→D, Q2→B, D2, D6.

## Purpose

Detect base-branch head-SHA advances on a poll cadence and, per advance, enqueue exactly one `cockpit resume` per open PR at `failed:validate` targeting that base. Read-only wrt GitHub state; the only side effect is a queue enqueue + a Redis dedupe write.

## Constructor

```ts
new BaseAdvanceMonitorService(
  logger: Logger,
  createClient: GitHubClientFactory,
  config: BaseAdvanceMonitorConfig,
  phaseTracker: PhaseTracker,                       // must expose isDuplicateRaw / markProcessedRaw
  enqueueResume: ResumeEnqueueCallback,
  tokenProvider?: () => Promise<string | undefined>,
  authHealth?: AuthHealthSink,                      // #762 pattern; optional
)
```

- `enqueueResume` is invoked *after* the base-advance detection but *before* the dedupe write. If it throws, the dedupe key is not written and the next cycle retries.
- `authHealth` receives `recordResult({ ok: false, statusCode: 401 })` on `GhAuthError` from any `GitHubClient` call. Non-401 errors are logged at `warn` and skip the failing scope (per-repo or per-group), never `recordResult`.

## Lifecycle

```ts
async startPolling(): Promise<void>
async stopPolling(): Promise<void>
```

- Idempotent: `startPolling` while already started is a no-op with a `warn` log.
- `stopPolling` awaits in-flight `pollCycle` before resolving.
- Polling loop uses `AbortController`; SIGTERM triggers `stopPolling` via the orchestrator's shutdown hook (same wiring as `LabelMonitorService`).

## Poll cycle contract

Each cycle:

1. For each `{ owner, repo }` in `config.repositories`, call `pollRepo(owner, repo)` with a semaphore of size `config.concurrency`.
2. Errors thrown from `pollRepo` are caught by the cycle driver, logged at `warn`, and do NOT abort the cycle for other repos.

### `pollRepo(owner, repo)` contract

1. Create `GitHubClient` via `createClient({ owner, repo, tokenProvider })`.
2. Enumerate open PRs at `failed:validate` via `github.listOpenPullRequests(owner, repo)` + label filter. Cost: 1 REST call per repo per cycle (same as `LabelMonitorService`).
3. Group PRs by `pr.base` (base-branch name).
4. For each `baseBranch` group:
   a. Call `github.getRefHeadSha(owner, repo, baseBranch)` — 1 REST call per group per cycle.
   b. On `GhAuthError` (HTTP 401): `authHealth.recordResult(credentialId, { ok: false, statusCode: 401 })`, `warn` log, skip this group. Other groups in the same cycle continue.
   c. On other errors: `warn` log, skip this group. No `authHealth` call.
   d. On success: `newSha` is the current base head.
   e. For each PR in the group:
      - Build key: `base-advance-tracker:${owner}:${repo}:${pr.issueNumber}:${newSha}`.
      - `phaseTracker.isDuplicateRaw(key)` → `true` → skip (already re-armed for this SHA).
      - `phaseTracker.isDuplicateRaw(key)` → `false` → call `enqueueResume({ owner, repo, issueNumber: pr.issueNumber, reason: 'base-advance', newSha })`.
        - Success → `phaseTracker.markProcessedRaw(key)`.
        - Throw → `warn` log with `{ owner, repo, issueNumber: pr.issueNumber, newSha, error }`. Do NOT mark processed. Next cycle retries.

### Enqueue idempotency (SC-002)

Across cycles, an `(issue, newSha)` pair produces exactly one successful `enqueueResume` call. This is enforced by the atomic `SET NX` semantics of `PhaseTrackerService.markProcessedRaw` (existing implementation). Within a single cycle, a repeat is not possible — the PR list is walked once.

Boot behavior: on cluster start, no `base-advance-tracker:` keys exist. Every currently-failing PR gets one re-arm on the first cycle. Bounded blast radius: at most one Claude spawn per PR (per resume path's idempotency guarantees).

### Ordering guarantees (D7)

- `BaseAdvanceMonitorService` MUST NOT invoke `ValidateFixHandler` directly. Its only outward-facing effect is `enqueueResume` calls.
- The fix cycle is triggered structurally from the resume-driven validate re-run's `catch` block, gated by `WorkerContext.resumeReason === 'base-advance'`. Any drift here is a spec violation caught by reviewer checklist.

## Failure modes

| Failure | Behavior | Recovery |
|---------|----------|----------|
| Redis unavailable (`phaseTracker.isDuplicateRaw` returns `false` gracefully) | Every PR gets one enqueue per cycle for the current SHA. Dedupe leaks to "once per cycle per SHA." | Reactivate Redis; leaks stop. Bounded blast radius: at most `pollIntervalMs / cycle_duration` extra enqueues per PR per hour. Downstream queue in-flight dedupe (#879) collapses parallel spawns. |
| `gh api commits/{ref}` returns 404 (base branch deleted/renamed) | Skip group, `warn` log with `{ owner, repo, baseBranch, error }`. No `authHealth` recordResult. | Operator investigates. Next cycle retries. |
| `enqueueResume` throws | `warn` log; dedupe not written. | Next cycle retries. If persistent, indicates a broken resume handler — operator alerted via log volume. |
| `github.listOpenPullRequests` throws non-auth error | Skip this repo entirely for this cycle. Other repos continue. | Next cycle retries. |
| Malformed SHA from `getRefHeadSha` | Throws at interface boundary; caught by pollRepo's group loop; group skipped. | Escalates as a bug — malformed SHA shouldn't leak past the interface. |

## Test surface

Injections: `phaseTracker` stub (implements `isDuplicateRaw` / `markProcessedRaw`), `createClient` stub returning a canned `GitHubClient`, `enqueueResume` stub (`vi.fn`), `authHealth` stub.

Required test cases:
1. **Happy path** — one repo, one failing PR, one base branch, SHA changes between cycle 1 and cycle 2. Assert: cycle 1 enqueues (dedupe key set); cycle 2 enqueues again for new SHA (new dedupe key); cycle 3 with same SHA does not enqueue.
2. **Multi-PR grouping** — one repo, three failing PRs sharing one base, one base SHA. Assert: 1 `getRefHeadSha` call, 3 enqueues in cycle 1, 0 in cycle 2 (same SHA).
3. **Multi-base grouping** — one repo, two failing PRs on different bases. Assert: 2 `getRefHeadSha` calls, 2 enqueues.
4. **Boot re-arm** — start monitor with 5 stranded PRs; first cycle enqueues all 5.
5. **`GhAuthError` on getRefHeadSha** — assert `authHealth.recordResult(_, { ok: false, statusCode: 401 })` called; group skipped; other groups in same cycle proceed.
6. **Enqueue failure** — `enqueueResume` throws once; assert `markProcessedRaw` NOT called; next cycle retries; second attempt succeeds → key written.
7. **`stopPolling` mid-cycle** — abort during a `pollRepo`; assert `stopPolling` resolves after in-flight work completes.
8. **Empty repo** — no failing PRs; assert no `getRefHeadSha` calls; no enqueues.

## Non-goals

- Not responsible for label state on the issue. Enqueue side effects (transitioning `failed:validate` → `phase:validate`) happen on the resume worker path.
- Not responsible for cross-repo coordination. Each repo is polled independently; there is no "epic" scope (D1).
- Not responsible for triggering the fix cycle (D7). Ordering invariant enforced structurally elsewhere.

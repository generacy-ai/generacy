# Research: Wire the smee doorbell end-to-end

## Question 1: Which resolver call site owns the workspace-mirror write?

**Decision**: `SmeeChannelResolver.writePersistedFile()` performs the mirror
write **after** the cluster-internal atomic write succeeds. Best-effort:
mirror-write failures emit a structured `warn` log but never fail
`writePersistedFile`, and never cause `resolve()` to return `null`.

**Why**:
- The cluster-internal file at `/var/lib/generacy/smee-channel` remains the
  authoritative source. If the mirror write fails, orchestrator behavior is
  unchanged (matches today).
- `writePersistedFile` is the single existing write site — the write happens
  once per boot after tier-3 provisioning, and tier-2 persisted-read hits
  don't re-write. The reader in `channel-discovery.ts` handles the
  cluster-internal fallback, so a mirror file that only appears after the
  first re-provision is still safe.
- Tier-2 persisted-read hits are also common (boot reuses the persisted URL
  across restarts). For SC-001 to hold on a restart, the mirror must be
  written on the persisted-read branch too. **Decision**: also write the
  mirror after a successful tier-2 `readPersistedFile()`, guarded by "mirror
  file missing OR content differs" (avoid burning inodes on every boot).

**Alternatives considered**:
- **A**: New standalone `WorkspaceMirrorWriter` service invoked from
  `server.ts` after `SmeeChannelResolver.resolve()`. Rejected: adds a
  parallel write path, one more object to wire, more places to forget the
  new write on re-provision. Keeping the mirror inside `SmeeChannelResolver`
  makes "URL persisted" and "URL mirrored" a single atomic step.
- **B**: Write only on tier-3 provisioning (not tier-2 persisted-read).
  Rejected: an orchestrator restart that reuses the persisted URL would
  leave the mirror stale/missing until the next re-provision (rare).
- **C**: Watch the cluster-internal file with `fs.watch` and mirror on
  change. Rejected: `fs.watch` semantics are unreliable across Docker /
  bind-mount volumes (also called out in Q4=A of the spec).

**Sources**:
- `packages/orchestrator/src/services/smee-channel-resolver.ts:71-104` —
  `resolve()` calls `writePersistedFile` after provisioning.
- `packages/orchestrator/src/services/smee-channel-resolver.ts:170-186` —
  atomic write (tmp + rename, mode 0600).

## Question 2: Walk-up vs. absolute-path reader?

**Decision**: Both — walk-up first, absolute `/workspaces/.generacy/cockpit/
smee-channel` next, then today's `/var/lib/generacy/smee-channel`
cluster-internal fallback.

Reader order:
1. `COCKPIT_DOORBELL_SMEE_URL` env override (unchanged).
2. Walk up from `cwd` to the nearest ancestor directory containing
   `.generacy/cockpit/smee-channel`. Stops at the first hit.
3. `/workspaces/.generacy/cockpit/smee-channel` absolute default.
4. `channelFilePath` (default `/var/lib/generacy/smee-channel`).

**Why**:
- Walk-up mirrors `resolveIssueContext` (#807) — the same pattern operators
  are used to for `.agency/` and other workspace-relative artifacts. From a
  cwd of `/workspaces/generacy/packages/...`, walk-up naturally lands on
  `/workspaces/.generacy/cockpit/smee-channel` when it's on the shared
  volume root.
- Absolute-path fallback is the direct hit even from a cwd outside the
  shared volume (e.g., `HOME=/root` in a bare test harness), keeps behavior
  deterministic without a `cwd` assumption.
- Cluster-internal fallback preserves today's shipped behavior when the
  doorbell runs inside the orchestrator container (the smoke-test path).

**Alternatives considered**:
- **A**: Absolute path only. Rejected: operators may launch from a chroot
  or bind-mounted subtree where `/workspaces/.generacy/` doesn't render at
  the expected absolute path. Walk-up handles that case robustly.
- **B**: Walk-up only. Rejected: from a `cwd` outside any workspace tree,
  the walk-up terminates at `/` with no hit; adding an explicit absolute
  fallback protects the "obvious" case without relying on cwd.

**Sources**:
- `packages/generacy/src/cli/commands/cockpit/resolver.ts` and
  `packages/generacy/src/cli/commands/cockpit/context.ts` — cwd walk-up
  precedent in cockpit.

## Question 3: Reuse `rateLimitScheduler` for FR-B backoff?

**Decision**: Yes — reuse the doorbell's already-wired
`rateLimitScheduler` (`doorbell.ts:511-514`) for the ~2 min initial retry
window. No new scheduler machinery.

**Why**:
- `rateLimitScheduler` already handles 429 spacing, `Retry-After` headers,
  and low-watermark backoff. Wrapping the two startup call sites in a thin
  `runWithRetry` envelope that calls `scheduler.noteResponseHeaders` on each
  attempt and reads `getCurrentIntervalMs()` for spacing is a natural fit.
- The scheduler is stateful across calls, so real rate-limit headers seen
  during a doorbell run inform subsequent retries — not just the first
  attempt.

**Late-startup retry (~5 min)** is *not* the scheduler's job; it's a plain
`setInterval` gated on process-liveness (mirrors `SourceSelector`'s
`rePromoteTimer` at `source-selector.ts:150-163`). Rationale: the scheduler
represents "how long to wait before the next `gh` attempt given rate-limit
signals"; the late-startup retry represents "how often to re-invoke the
startup path once we've exhausted the initial window". Different concerns.

**Alternatives considered**:
- **A**: Custom exponential backoff (2s → 4s → 8s → 16s → 32s → 64s
  capped) implemented inside `StartupRetrySchedule`. Rejected: duplicates
  logic the scheduler already handles; scheduler-aware backoff also reacts
  correctly to `Retry-After` responses seen mid-run, which a naive counter
  cannot.
- **B**: Reuse `SmeeDoorbellSource`'s own reconnect ladder. Rejected: that
  ladder is for SSE stream disconnection (not `gh` API errors), covers the
  runtime path (not startup), and the classifier concerns are different
  (SSE has no HTTP error class beyond "response.ok === false").

**Sources**:
- `packages/cockpit/src/gh/rate-limit-scheduler.ts:23-30` — public API.
- `packages/generacy/src/cli/commands/cockpit/doorbell.ts:511-514` —
  scheduler already constructed and passed via `deps.rateLimitScheduler`.

## Question 4: Error classifier — where does it live and how does it work?

**Decision**: A single pure function `classifyGhError(err: unknown) →
GhErrorClass` in `doorbell/startup-retry.ts`, called by
`StartupRetrySchedule.runWithRetry`. Discriminated union output:
`{ kind: 'retriable' } | { kind: 'permanent', reason: string }`.

Classification rules (matches Q3=B):

**Retriable**:
- `err.code ∈ { ECONNRESET, ETIMEDOUT, ENOTFOUND, ECONNREFUSED, EPIPE }`
- Message contains `socket hang up`
- Message contains an HTTP status marker in `{ 429, 500, 502, 503, 504 }`

**Permanent**:
- HTTP `401` OR message contains `Bad credentials`
- HTTP `403` OR message contains `SAML enforcement` / `scope` /
  `not accessible by`
- HTTP `404` OR message contains `Not Found` (in the epic-not-found
  context)
- Message starts with `error parsing` / `expected JSON` (malformed `gh`
  output)

**Fallback**: unknown patterns are treated as **permanent**, exiting `3`.
Rationale: an unrecognized error class is more likely to be a genuine
misconfiguration than a transient network blip. The alternative (default
retriable) risks silent doorbell processes on genuinely broken states.

**Why not message-string only (Q3 option C)**: brittle to `gh` output
changes. We check `error.code` first (structured), fall back to message
patterns only for HTTP status detection where `gh` doesn't surface a code.

**Sources**:
- Existing `gh` error handling in `packages/orchestrator/src/services/
  wizard-creds-token-provider.ts` and
  `packages/workflow-engine/src/actions/github/client/gh-cli.ts` — the same
  patterns work here (HTTP status parsed from stderr; message matching for
  auth errors).
- `GhAuthError` in `gh-cli.ts` (#762) is precedent for a typed subclass of
  gh errors, though we don't need a class hierarchy here — a discriminated
  return is enough.

## Question 5: Workspace-mirror boot-time preflight?

**Decision**: No preflight — attempt the write at persist time; on failure
(EACCES, EROFS, ENOSPC, EPERM), emit **one** structured `warn` log
including the path and error code, and continue.

**Why**:
- Preflighting the workspace mount would add boot latency and a code path
  that must stay in sync with the actual write behavior. If the volume is
  writable at boot but not at re-provision (rare — permissions don't
  usually change), a preflight-only check would give false confidence.
- The mirror-write failure is benign at the orchestrator level: the
  cluster-internal path is unchanged, so the poll-fallback continues to
  work for anyone reading the cluster-internal file inside the container.
  What breaks is the operator-session doorbell, which will observe
  `discoverChannelUrl → null` and start in poll-fallback mode — the same
  behavior as today.
- The Assumption in the spec (`workspace-volume root is writable by the
  orchestrator uid`) is verified operationally, not code-enforced. The
  structured warn log gives operators the diagnostic they need if the
  volume isn't writable.

**Alternatives considered**:
- **A**: Preflight at server boot: attempt to `mkdir -p /workspaces/.
  generacy/cockpit/` and record whether it succeeds, then skip the mirror
  write if it didn't. Rejected: the preflight would run inside `server.ts`,
  adding a startup step for a best-effort behavior; the runtime write path
  handles the same errors identically with less code.

## Question 6: Does `SourceSelector` need a new startup-transient state?

**Decision**: No. The retry envelope keeps the process alive; the existing
`SourceSelector` sees no state changes during the initial 2-min window. On
exhaustion, `runSmeeMode` returns null (as today), and `runDoorbell`'s
existing `startSmeeMode → false → startPollMode` fallback path fires. If
`startPollMode`'s `acquireEpicBus` is also inside the retry envelope, the
same retry policy applies — no source-state churn during retries.

The runtime `SourceSelector` state machine remains:
- `smee-attempt` (initial) → `smee-active` (on first SSE connect success)
  → `poll-fallback` (on runtime demotion) → `smee-attempt` (on re-promote
  tick) → `smee-active` (on re-promote success).

Startup retries all happen **before** `SourceSelector.transition()` fires;
they only affect *when* `smee-active` (or the first `poll-fallback` fallback)
is reached, not *which* mode is chosen.

**Sources**:
- `packages/generacy/src/cli/commands/cockpit/doorbell/source-selector.ts`
  — state machine unchanged.

## Constraints revisited

- **agency#431** contract: `armed\n` written before source selection; stderr
  `source=…` line as source-settled signal. Both unchanged.
- **Stdout event line**: `event.type\n` via `lineForEvent`. Unchanged.
- **No new volume mounts.** FR-A relies exclusively on the existing
  `*_workspace` volume that's already shared between orchestrator and
  operator sessions.

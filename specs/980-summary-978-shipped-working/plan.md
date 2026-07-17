# Implementation Plan: Wire the smee doorbell end-to-end

**Feature**: Deliver the resolved smee channel URL to the operator's `/cockpit:auto` session via the shared workspace volume, and make the doorbell's startup `gh` calls survive transient failures instead of `exit(2)`-ing the process.
**Branch**: `980-summary-978-shipped-working`
**Status**: Complete

## Summary

#978 shipped a working smee-mode doorbell, but two engine-side gaps prevent it from being reachable end-to-end in the real deployment topology:

1. **Channel URL is invisible to the operator.** `SmeeChannelResolver`
   (`packages/orchestrator/src/services/smee-channel-resolver.ts`) persists the
   resolved URL to `/var/lib/generacy/smee-channel` on the cluster-internal
   `generacy-data` volume. The operator `/cockpit:auto` session runs in a
   separate devcontainer/tunnel that does not mount that volume, so
   `channel-discovery.ts` returns `null` → **poll-fallback**.
2. **Doorbell dies on a single `gh` blip.** Both `runPollMode`'s
   `acquireEpicBus` (`doorbell.ts:150-155`) and `runSmeeMode`'s
   `SmeeDoorbellSource.start()` → `resolveEpic` (`smee-source.ts:171`)
   propagate `gh` errors → all-sources-failed → `exit(2)`. Agency `#431` is
   passive by contract (Q3=A), so the run silently degrades to the 5-min
   `ScheduleWakeup` heartbeat.

This spec closes both gaps without touching the doorbell's protocol surface or the agency skill:

1. **FR-A — cross-container channel delivery.** Extend `SmeeChannelResolver`
   with a second write to a **single** cluster-scoped file at the shared
   workspace-volume root: `/workspaces/.generacy/cockpit/smee-channel` (Q1=C).
   Extend `channel-discovery.ts`'s lookup chain to prefer the walked-up
   `.generacy/cockpit/smee-channel`, then the absolute
   `/workspaces/.generacy/cockpit/smee-channel`, keeping today's
   `COCKPIT_DOORBELL_SMEE_URL` env and `/var/lib/generacy/smee-channel`
   fallbacks. One write per re-provision; reader walks up from cwd so it
   works from any repo workspace under the shared volume.

2. **FR-B — startup resilience with two-tier retry (Q2=D + Q3=B).** Wrap the
   two startup `gh` sites (`acquireEpicBus` in `runPollMode`,
   `SmeeDoorbellSource.start()`'s `resolveEpic`) in a shared
   `StartupRetrySchedule` that:
   - Classifies errors: **retriable** = HTTP 429 / network
     (ECONNRESET/ETIMEDOUT/ENOTFOUND/ECONNREFUSED/socket hang up) / 5xx
     (500/502/503/504). **Permanent** = 401 "Bad credentials" / 403 SSO or
     scope / 404 not-found / malformed `gh` output.
   - On **retriable**, backs off exponentially via the already-wired
     `rateLimitScheduler` for a bounded ~2 min *initial* window; on
     exhaustion, transitions to a periodic ~5 min *late-startup retry*
     while the process stays alive. Never `exit(2)` on transient failure.
   - On **permanent**, emits a distinct diagnostic on stderr
     (`cockpit doorbell: permanent-error kind=<class> …`) and exits `3`
     (distinguishable from today's silent `exit(2)`).
   - Wires the existing `SourceSelector` — retries during startup keep the
     mode as `smee-attempt` (with the process alive); on ultimate transient
     exhaustion the doorbell demotes to `poll-fallback` via the same
     `smee-runtime-lost` transition the runtime SSE-loss path already uses.

3. **File permissions.** Workspace-relative file is mode `0644` (Q5=B) with
   bare-URL content — symmetric with the cluster-internal fallback, readable
   across the writer↔reader uid boundary (orchestrator container vs.
   operator devcontainer/tunnel).

Mid-run re-provision is explicitly out of scope (Q4=A): the doorbell reads
the channel file once at startup. The channel URL is persisted and stable
across restarts, so this is rare and benign (the passive skill's heartbeat
still advances the run).

## Technical Context

- **Language/Version**: TypeScript (ESM, Node >=22)
- **Primary Dependencies**: `zod` (existing), native `node:fs/promises` and
  `node:path`. No new deps. `rateLimitScheduler` is already wired to the
  doorbell's `GhCliWrapper` in `doorbellCommand()`
  (`doorbell.ts:511-514`), so FR-B reuses infrastructure — this spec adds
  no new scheduler machinery, only a startup call-site retry envelope.
- **Packages touched**:
  - `packages/orchestrator/` — `SmeeChannelResolver` gains an optional
    workspace-mirror write path; wire config through `SmeeConfigSchema`.
  - `packages/generacy/` — `channel-discovery.ts` lookup chain extended;
    new `StartupRetrySchedule` in `doorbell/startup-retry.ts`; `runDoorbell`
    wraps the two startup `gh` sites.
  - No changes to `@generacy-ai/cockpit` (no new exports needed;
    `rateLimitScheduler` already lives there).
- **Test runner**: Vitest, matching existing convention in
  `packages/generacy/src/cli/commands/cockpit/__tests__/`,
  `.../doorbell/__tests__/`, and
  `packages/orchestrator/src/services/__tests__/`.
- **Storage**: Filesystem — one bare-URL file per persist point (cluster-
  internal at mode 0600, workspace-relative at mode 0644). No new
  persistence layer.
- **Performance goals**: SC-001 — end-to-end doorbell wake latency ≤ ~3s p95
  on smee-live clusters from an operator session that does not mount
  `generacy-data`. SC-002/SC-003 — process stays alive across single-shot
  and sustained (10-min) transient outages, self-heals in ≤ one late-startup
  retry cycle (~5 min).
- **Constraints**:
  - **No change to the `armed\n` timing** (agency#431 depends on it, spec
    Assumption preserved from #978 Q5=A).
  - **No change to stdout event line shape** (`event.type\n` via
    `lineForEvent`).
  - **No change to the agency skill** (spec asserts FR-B satisfies the
    passive-recovery contract at `#431` Q3=A).
  - **No new volume mounts.** FR-A works because the `*_workspace` volume
    is already shared across the operator↔cluster boundary (auto ledger
    lives on it).

## Constitution Check

No `.specify/memory/constitution.md` in repo. Skipped.

## Project Structure

### Documentation (this feature)

```
specs/980-summary-978-shipped-working/
├── plan.md                            # this file
├── research.md                        # technology decisions
├── data-model.md                      # types and interfaces
├── quickstart.md                      # verify locally
├── contracts/
│   ├── channel-discovery.md           # lookup-chain contract (FR-002)
│   ├── smee-channel-resolver.md       # workspace-mirror write contract (FR-001, FR-008)
│   └── startup-retry.md               # StartupRetrySchedule contract (FR-003, FR-004, FR-005)
└── clarifications.md                  # (existing)
```

### Source code changes

```
packages/orchestrator/src/
├── config/schema.ts                   # add SmeeConfigSchema.workspaceMirrorPath (optional)
├── config/loader.ts                   # env: SMEE_WORKSPACE_MIRROR_PATH
└── services/
    ├── smee-channel-resolver.ts       # dual-write: cluster-internal + workspace-mirror
    └── __tests__/
        └── smee-channel-resolver.test.ts   # + workspace-mirror write cases

packages/generacy/src/cli/commands/cockpit/
├── doorbell.ts                        # wrap acquireEpicBus + smee start in StartupRetrySchedule
└── doorbell/
    ├── channel-discovery.ts           # extend lookup chain (walk-up + absolute + fallback)
    ├── startup-retry.ts               # NEW: StartupRetrySchedule + error classifier
    └── __tests__/
        ├── channel-discovery.test.ts       # + walk-up + cluster-internal-fallback cases
        └── startup-retry.test.ts           # NEW: retriable/permanent matrix + timer cadence
```

## Phase 0: Research

See `research.md`. Six questions:

1. **Which resolver call site owns the dual-write?**
   → `SmeeChannelResolver.writePersistedFile` mirrors to the workspace path
   after the atomic cluster-internal write succeeds (best-effort, warn on
   failure — never fails the whole boot).
2. **Should we walk up from `cwd` or read only the absolute path?**
   → Both. Walk-up handles operators whose cwd is deep in a repo tree;
   absolute path is the direct hit from the volume root. `cwd`-first mirrors
   `resolveIssueContext` (#807) and lets tests inject cwd via a test seam.
3. **Which `rateLimitScheduler` behavior do we reuse for the ~2 min initial
   window?**
   → Its response-header + retry-after backoff. We do **not** add a new
   scheduler. Late-startup retry (~5 min) is a plain `setInterval` gated on
   process-liveness — same pattern as `SourceSelector`'s `rePromoteTimer`.
4. **What error classifier is used at both call sites?**
   → A single shared `classifyGhError(err)` that pattern-matches on message +
   error code fields exposed by `GhCliWrapper` / the `gh` CLI's stderr text.
   Q3=B rejected message-string-only classification; we prefer error-code
   fields where they exist, fall back to well-known message patterns for the
   `gh` CLI's HTTP status output.
5. **Does the workspace-mirror write need a separate `writable`-check at
   boot?**
   → No — mirror-write failures are best-effort (Q5=B "mode 0644" +
   Assumption "verify writable"). On EACCES/EROFS, emit one structured warn
   log with the path and fall back to poll-only visibility. The
   cluster-internal path is unchanged and remains the source of truth.
6. **Does FR-B need to distinguish smee-startup vs. poll-startup for the
   `SourceSelector` line?**
   → No new source label. The initial `SourceSelector` line is decided by
   `discovery == null` (unchanged). What FR-B changes is that a smee-attempt
   failure during startup no longer collapses immediately to poll-fallback
   — the process retries within the initial window (still `smee-attempt`)
   before either succeeding, permanently failing (`exit(3)`), or demoting
   to `poll-fallback` on exhaustion (existing `smee-runtime-lost`
   transition).

## Phase 1: Design

See `data-model.md` for full type signatures. Two new interfaces:

- **`StartupRetrySchedule`** (`packages/generacy/.../doorbell/startup-retry.ts`)
  — envelope around a `Promise`-returning task. Public API:
  `runWithRetry<T>(task, opts) → Promise<T>`. Classifies errors, backs off
  transient failures within the initial window via `rateLimitScheduler`,
  transitions to a periodic late-startup retry on exhaustion.
- **`GhErrorClass`** — discriminated union: `retriable | permanent`. The
  classifier is a pure function that inspects `Error.code`, HTTP status
  strings in the message, and known permanent-error markers.

Extended surface:

- **`SmeeConfigSchema`** gains optional `workspaceMirrorPath` (default
  `/workspaces/.generacy/cockpit/smee-channel`; unset via config → the
  resolver skips the mirror write).
- **`SmeeChannelResolverOptions`** gains optional `workspaceMirrorPath`.
- **`ChannelDiscoveryInput`** gains optional `cwd` (default
  `process.cwd()`) and `workspaceMirrorPath` (default
  `/workspaces/.generacy/cockpit/smee-channel`).

See `contracts/*.md` for each contract's precise behavior.

## Phase 2: Task planning

Not part of `/plan`; run `/speckit:tasks` to generate the ordered task
list from the artifacts above.

## Complexity Tracking

None. The two changes are surgical and reuse existing infrastructure:

- FR-A adds one filesystem write and reorders one filesystem-read chain.
  No new volume mounts, no new IPC.
- FR-B adds one retry envelope + error classifier around two existing call
  sites. Reuses the already-wired `rateLimitScheduler` for backoff and the
  existing `SourceSelector` for demotion transitions.

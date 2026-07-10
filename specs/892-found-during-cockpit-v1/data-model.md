# Data Model: Base-advance re-validate + bounded validate-fix cycle

**Feature**: `892-found-during-cockpit-v1`
**Companion**: [plan.md](./plan.md), [research.md](./research.md)

## Redis key layouts

### `base-advance-tracker:` — per (issue, base SHA) dedupe

**Key**: `base-advance-tracker:<owner>:<repo>:<issueNumber>:<baseSha>`

- `owner`, `repo`: repository coordinates (lower-case).
- `issueNumber`: integer, no leading zeros. Same value as the PR-linked issue number.
- `baseSha`: full 40-character lower-case hex SHA of the base branch head at the moment the monitor observed the advance.

**Value**: `"1"` (opaque marker; presence-only).
**TTL**: 86400 seconds (24 h). Same default as `phase-tracker:`.
**Cardinality**: bounded by (open failing PRs) × (distinct base SHAs seen within TTL). In practice: dozens to low hundreds per cluster.
**Writer**: `BaseAdvanceMonitorService.pollRepo()` — atomic `SET key "1" NX EX 86400` via `PhaseTrackerService.markProcessedRaw(key)`.
**Reader**: `BaseAdvanceMonitorService.pollRepo()` — `EXISTS key` via `PhaseTrackerService.isDuplicateRaw(key)` before enqueueing a resume.
**Deleter**: none. Keys age out on TTL.

**Semantics**: presence means "this issue has been re-armed for this specific base SHA; don't re-arm again until the SHA changes." A new base advance produces a new SHA → new key → next re-arm.

### `phase-tracker:` `validate-fix:<hash>` — per (issue, evidence) fix-cycle dedupe

**Key**: `phase-tracker:<owner>:<repo>:<issueNumber>:validate-fix:<evidenceHash>`

- Uses the existing `phase-tracker:` namespace.
- Phase suffix: `validate-fix:<evidenceHash>` where `evidenceHash` is 64-character lower-case hex SHA-256.

**Value**: `"1"`.
**TTL**: 86400 seconds (24 h). Existing `PhaseTrackerService` default.
**Cardinality**: bounded by (distinct evidence hashes ever seen per issue) × (open failing PRs). Typically 1–3 per PR (first red + one or two hash-distinct re-reds).
**Writer**: `ValidateFixHandler.handle()` — `phaseTracker.markProcessed(owner, repo, issue, `validate-fix:${hash}`)` before spawning the fix agent.
**Reader**: `ValidateFixHandler.handle()` — `phaseTracker.isDuplicate(owner, repo, issue, `validate-fix:${hash}`)` at entry. Hit → escalation, no spawn.
**Deleter**: none. Keys age out on TTL. Human escalation may DEL manually to allow a retry after operator investigation.

**Semantics**: presence means "we already spent our one autonomous attempt on this exact red for this issue." Same hash → escalation gate. Different hash → fresh attempt allowed.

### Existing `phase-tracker:` keys — UNCHANGED

- `phase-tracker:<owner>:<repo>:<issue>:process:<phase>` — resume-check dedupe (label-monitor).
- `phase-tracker:<owner>:<repo>:<issue>:resume:<gate>` — resume-enqueue dedupe (label-monitor + #849 paired-clear).

No changes to layout, TTL, writers, or readers.

## Core types

### `BaseAdvanceMonitorConfig`

```ts
export interface BaseAdvanceMonitorConfig {
  /** Poll interval in ms. Default: reuses LabelMonitorService.pollIntervalMs (60000). */
  pollIntervalMs: number;
  /** Repositories to poll. Same shape as LabelMonitorService.repositories. */
  repositories: Array<{ owner: string; repo: string }>;
  /** Max concurrent pollRepo() calls per cycle. Default: 4. */
  concurrency: number;
}
```

**Source**: `packages/orchestrator/src/services/base-advance-monitor-service.ts`.
**Provenance**: derived from `WorkerConfig` fields already used by `LabelMonitorService`. No new config surface.

### `ResumeItem` (enqueue payload)

```ts
export interface ResumeItem {
  owner: string;
  repo: string;
  issueNumber: number;
  /** Why the resume was enqueued. */
  reason: 'base-advance';
  /** Base SHA that triggered the resume — surfaces in worker context. */
  newSha: string;
}
```

**Source**: `packages/orchestrator/src/services/base-advance-monitor-service.ts` (exported).
**Consumers**: `enqueueResume` callback wired in `server.ts` (production points at the `cockpit resume` handler; tests inject a stub).
**Surface for handler**: `WorkerContext.resumeReason` and `WorkerContext.baseSha` — the fix handler reads these to gate the ordering invariant (D7).

### `EvidenceExtract`

```ts
export interface EvidenceExtract {
  /** Sorted by `id` (lexicographic). */
  failures: Array<{
    /** Stable identifier. Formats:
     *  - `module:<repo-relative path>`      (Next.js "Cannot find module ...")
     *  - `type:<repo-relative path>:<summary>` (Type error at path)
     *  - `test:<test name>`                 (vitest "×" line)
     *  - `hash:<16-hex>`                    (fallback — SHA-256 first 16 hex of normalized transcript)
     */
    id: string;
    /** First error line, un-decorated but normalized (ANSI/timestamps/paths stripped). */
    firstError: string;
  }>;
}
```

**Source**: `packages/orchestrator/src/worker/evidence-hash.ts` (exported).
**Serialization for hashing**: `JSON.stringify({ failures })` with `failures` already sorted. Ensures deterministic byte-for-byte output across processes.

### `EvidenceHashResult`

```ts
export interface EvidenceHashResult {
  /** SHA-256 hex (64 chars, lower-case). */
  hash: string;
  /** Canonical input to the hash — surfaces in prompt + logs. */
  extract: EvidenceExtract;
}
```

**Source**: `packages/orchestrator/src/worker/evidence-hash.ts` (exported).
**Purpose**: `hash` is identity; `extract` is included in the fix prompt so the agent sees exactly what identity we claimed.

### `ClearResumeDedupeCallback` / `ResumeEnqueueCallback`

`ResumeEnqueueCallback` (new):

```ts
export type ResumeEnqueueCallback = (item: ResumeItem) => Promise<void>;
```

**Source**: `packages/orchestrator/src/services/base-advance-monitor-service.ts`.
**Contract**: wired at construction; called at most once per `(issue, newSha)` per cycle. Errors are logged at `warn` and the dedupe key is NOT written (retry next cycle).

### `ValidateFixIntent` (agent-launcher intent kind)

```ts
export interface ValidateFixIntent {
  kind: 'validate-fix';
  prNumber: number;
  prompt: string;              // full stdout-inclusive fix prompt (FR-005)
  evidenceHash: string;        // 64-hex; surfaced in launcher observability
}
```

**Source**: `packages/orchestrator/src/launcher/types.ts` (extended intent union).
**Routing**: same plugin dispatch as `pr-feedback` intent; the plugin routes to the same worker prompt shell. No new plugin needed.

## Relay event payloads

### `cluster.validate-fix` — new channel

Emitted via existing `POST /internal/relay-events` IPC route (#594/#598/#600). Wire shape (per #600):

```json
{
  "event": "cluster.validate-fix",
  "data": {
    "status": "attempted" | "escalated" | "blocked",
    "owner": "acme",
    "repo": "widgets",
    "issueNumber": 892,
    "prNumber": 42,
    "evidenceHash": "abc123…",
    "reason": "duplicate-evidence-hash" | "no-diff" | null,
    "timestamp": "2026-07-09T22:00:00.000Z"
  },
  "timestamp": "2026-07-09T22:00:00.000Z"
}
```

**Status values**:
- `attempted` — one autonomous fix attempt made; committed and pushed. Re-validate will fire from the resume path; may still red.
- `escalated` — duplicate evidence hash → escalation label applied. No spawn.
- `blocked` — spawn ran but produced no diff (#883 termination). `blocked:stuck-validate-fix` label applied.

**Emitter**: `ValidateFixHandler.emitEvent?.(...)` (constructor-injected, optional).
**Consumers**: cloud subscribers — cockpit dashboard, activity feed. Out of scope for #892.

## Validation rules

### Base-advance dedupe key

- `baseSha` MUST match `/^[0-9a-f]{40}$/`. Enforced at `GitHubClient.getRefHeadSha` return site (D8) — throws on malformed response. A malformed value never reaches the key builder.
- `issueNumber` MUST be `> 0`. Enforced upstream by `listOpenPullRequests` schema.
- `owner`, `repo` MUST be non-empty lower-case identifiers. Enforced upstream by `BaseAdvanceMonitorConfig.repositories` shape.

### Evidence hash

- Input stdout: no upper bound in the type; practical bound is CLI output size (~few MB).
- Empty stdout produces a stable hash of `{ failures: [{ id: "hash:<16hex-of-empty-normalized>", firstError: "" }] }` — well-defined via fallback path.
- Normalization is applied *once* to stdout; extraction reads the normalized transcript. Re-normalizing already-normalized text is idempotent (guards against caller mistakes).
- Hash is 64-character lower-case hex. Any other shape indicates a bug.

### Sibling-owned file list

- `collectSiblingOwnedFiles` returns `string[]` — repo-relative POSIX paths as reported by `gh pr diff --name-only`.
- Deduplicated (single `Set` pass).
- Order not guaranteed. Callers MUST NOT assume ordering for hash inputs (the sibling-guard file list is NOT part of the evidence hash — it's prompt content only).

## Relationships between entities

- **`BaseAdvanceMonitorService`** observes → **`base-advance-tracker:` keys** (writes) → gates → **enqueue to resume queue** → **`cockpit resume` handler** (companion issue) → new worker cycle → `PhaseLoop` sets `WorkerContext.resumeReason = 'base-advance'`.
- **`PhaseLoop.validate.catch`** consults → **`WorkerContext.resumeReason`** → gates invocation of → **`ValidateFixHandler.handle()`**.
- **`ValidateFixHandler.handle()`** computes → **`EvidenceHashResult`** → checks → **`phase-tracker:validate-fix:<hash>`** → if new, marks + spawns → **`AgentLauncher.launch({ intent: 'validate-fix' })`** → **`commitAndPushChanges`** (#883) → emits → **`cluster.validate-fix`** event.
- **`GitHubClient.getRefHeadSha`** (new interface method) supports → **`BaseAdvanceMonitorService.pollRepo`**.
- **`PhaseTrackerService`** (unchanged interface + two new passthroughs) backs → **both new dedupe surfaces** — no interface split, no new service class.

## State transitions

### Base-advance dedupe

```text
(no key)   --monitor observes new baseSha, enqueue succeeds-->  key exists (TTL 24h)
key exists --same baseSha observed again-->                     no-op (isDuplicate → skip)
key exists --TTL expires-->                                     (no key)                     [self-heal after 24h idle]
(no key)   --monitor observes new baseSha, enqueue fails-->     (no key)                     [retry next cycle]
```

### Validate-fix dedupe

```text
(no key)   --first spawn on this evidence hash-->               key exists (TTL 24h)
key exists --same evidence hash-->                              escalation (no spawn)
key exists --different evidence hash-->                         new key, fresh spawn allowed
key exists --operator DEL-->                                    (no key)                     [manual re-arm after investigation]
```

### `failed:validate` label lifecycle (existing, unchanged)

```text
phase:validate --CLI exit non-zero--> failed:validate  (via LabelManager.onError('validate'))
failed:validate --resume enqueued-->  phase:validate   (via LabelManager.onStart on next cycle)
```

The `failed:validate` label is applied and cleared by existing code. This feature does NOT change label lifecycle — it changes when a resume is *enqueued* (via the base-advance monitor) and what happens *inside* the re-run's validate catch block (via `ValidateFixHandler`).

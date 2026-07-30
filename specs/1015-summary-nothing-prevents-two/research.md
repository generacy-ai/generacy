# Research: Active-driver claim per cockpit scope

**Feature**: #1015 | **Branch**: `1015-summary-nothing-prevents-two`

## R-1 — Claim storage medium (GitHub artifact vs. local file vs. in-memory)

**Decision**: Store the claim marker on the scope issue itself — a fenced HTML comment as source of truth + a `cockpit:claimed` label as an enumeration index. Corresponds to spec Q1 → C.

**Alternatives considered**:

- **In-process registry (rejected)**. Every `/cockpit:auto` invocation typically spawns its own MCP server process (per spec: "if each conversation spawns its own MCP server process, the sessions don't even share the registry"). A registry keyed in process memory therefore cannot see the other session by construction. The existing `event-bus-registry.ts` refcount model works for observers inside a shared process, but does nothing across MCP-process boundaries.
- **Disk lock file (rejected)**. Multiple concurrent auto sessions may run in different containers (operator laptop vs. orchestrator worker), so a lock file in one filesystem cannot bind a session in another. Also fails to survive container restarts.
- **Comment-only, no label (rejected)**. Discovery would require listing all comments on the scope issue every arm — an O(n) scan on every scope. The label acts as a cheap enumeration hint ("is there a claim at all?") so callers issue the comment list only when the label is present.
- **Label-only, no comment (rejected)**. Cannot carry per-session state (session id, heartbeat timestamp, ledger pointer). Label descriptions are not machine-parseable in a stable way and cannot be atomically updated with the claim state.

**Sources**:
- Spec §Q1 (2026-07-21): "C — Structured comment as the source of truth ... plus a `cockpit:claimed` label as a pure enumeration/status index. On any disagreement the comment wins."
- Existing skill artifact `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_relay_clarify_answers.ts` — establishes the `<!-- cockpit:answers vN -->` fenced-marker pattern used successfully elsewhere.

## R-2 — MCP tool boundary (single verb-dispatch tool vs. discrete tools vs. hybrid)

**Decision**: **Hybrid** — one `cockpit_claim` tool for idempotent acquire-or-refresh-or-takeover, plus a separate `cockpit_release`. Corresponds to spec Q2 → C.

**Alternatives considered**:

- **Single tool with verb arg (rejected)**. Would collapse the surface but obscures the distinct arg validation between `acquire`/`refresh`/`takeover` (all shape-identical) vs. `release` (only needs sessionId + scope). Also complicates the auth surface if future work adds per-verb scoping.
- **Four discrete tools (rejected)**. `cockpit_heartbeat` and `cockpit_acquire` are the same idempotent operation with different implicit intent — folding them together makes the primary hot-path call site trivially cheap (auto loop just calls `cockpit_claim` on every wake).

**Sources**:
- Spec §Q2 answer: "C — `cockpit_claim` as an idempotent acquire-or-refresh ... with `takeover: true` as a flag, plus a separate explicit `cockpit_release`."

## R-3 — Heartbeat cadence and staleness threshold

**Decision**: Piggyback on the auto-loop wake cycle. Per-tick `cockpit_claim` call IS the heartbeat. No dedicated timer. **Absolute staleness threshold = 10 minutes** (600 seconds). Corresponds to spec Q3 → D.

**Rationale**:
- Auto loop is prose-driven (LLM-in-loop) with harness-controlled wake signals (`Monitor` doorbell + `ScheduleWakeup` heartbeat, per `agency/packages/claude-plugin-cockpit/commands/auto.md` step 4). It cannot reliably hold a fixed-interval timer.
- 60-120s fixed cadences would consume ~30-60 writes/hr from the shared 5k/hr GitHub budget for every active session, for no additional recovery benefit.
- Live-session wake gaps are comfortably under 10 minutes in practice (Monitor typically fires within seconds of a GitHub event; heartbeat fallback fires every 5 min per auto.md C4).
- 10-minute absolute threshold acceptable for the crashed-session recovery case (US3).

**Alternatives considered** (from spec Q3):
- A: 60s / 3min — snappy but ~60 writes/hr burden.
- B: 120s / 6min — half the burden but still requires a dedicated timer.
- C: 300s / 15min — better budget but longer crash recovery.
- D: **Piggyback + 10min** (chosen).

## R-4 — Takeover surfaces

**Decision**: All three surfaces (Q4 → D) — they compose rather than compete:

1. **MCP primitive**: `cockpit_claim` with `takeover: true` — the mechanism.
2. **CLI flag**: `/cockpit:auto ... --takeover` — express intent at invocation time.
3. **Interactive gate**: refusal payload from `cockpit_claim` without `takeover: true` surfaces as an operator gate in the auto skill; on Accept, skill re-invokes `cockpit_claim` with `takeover: true`.

**Sources**:
- Spec §Q4 answer: "D — All three, because they compose rather than compete."

## R-5 — Verification cost (per-dispatch read vs. heartbeat-only vs. opportunistic)

**Decision**: Verify on heartbeat + opportunistically on dispatches that already read the scope issue. **No mandatory extra GitHub read on any driving dispatch**. Corresponds to spec Q5 → C.

**Rationale**:
- Auto loop calls `cockpit_claim` on every wake as the heartbeat (per R-3). That single call already reports "lost claim" at zero additional cost when someone else has taken over.
- Detection lag is bounded by wake cadence (worst case ≈ 10 min for a healthy session between heartbeat fires with no Monitor traffic, well within the SC-004 target of "one wake cycle").
- Alternative (per-dispatch read) would ~triple GitHub read volume for zero latency benefit on the median case.

**Sources**:
- Spec §Q5 answer: "C — Verify on heartbeat plus opportunistically on any dispatch that already reads the scope issue."

## R-6 — Session id derivation

**Decision**: Reuse the existing `INSTANCE_NONCE` from `packages/generacy/src/cli/commands/cockpit/mcp/event-bus.ts:72`. 16 hex chars, generated once at MCP server startup via `crypto.randomBytes(8)`.

**Rationale**:
- One `/cockpit:auto` invocation spawns one MCP server process, which generates one `INSTANCE_NONCE`. Same-process re-arm keeps the same session id — critical for FR-006 (heartbeat re-verifies "I still hold the claim").
- Alternative (fresh UUID per `cockpit_claim` call) rejected: a re-arm within the same MCP process would false-positive as a takeover.
- Alternative (ledger-slug hash) rejected: the ledger path is caller-supplied; a caller with two ledger files of the same slug (or a crafted slug) could spoof another session's id.
- Plan-phase deferred per spec Clarifications trailer ("Session id derivation (UUID / INSTANCE_NONCE / ledger-slug hash)").

**Public wire shape**: `cockpit_claim` accepts `sessionId: string` (opaque; `min(1).max(64)`, `/^[a-f0-9]{16,64}$/`). Skill supplies `INSTANCE_NONCE`. Tests supply arbitrary hex strings.

## R-7 — Comment marker format

**Decision**: HTML comment fence containing a single JSON object on its own line. Modeled on the existing `cockpit_relay_clarify_answers` marker pattern.

```markdown
<!-- cockpit:claim v1 -->
```json
{
  "version": 1,
  "sessionId": "<16-64 hex chars>",
  "heldSince": "<ISO-8601>",
  "heartbeatAt": "<ISO-8601>",
  "ledger": ".generacy/cockpit/auto-runs/<slug>-<timestamp>.ledger",
  "scope": "owner/repo#N"
}
```

**Rationale**:
- HTML comment fence keeps the marker invisible in rendered issue view.
- Explicit `version` field for future migration.
- Fenced JSON block within the comment (rather than compact single-line) makes it hand-readable when operators inspect the issue directly.
- `heldSince` is not strictly needed for the algorithm but is useful for observability / debugging ("how long has this session been driving?").
- `scope` is redundant with the issue URL but makes copy-paste debugging easier.

**Detection**: A comment is a claim marker iff its body **starts with** `<!-- cockpit:claim v1 -->` (case-sensitive), then contains a fenced ```` ```json ```` block whose parse succeeds against `ClaimMarkerSchema`. Non-matching comments are ignored during discovery (per R-1: comment is source of truth, orphaned label tolerated).

**Sources**:
- Existing pattern in `tools/cockpit_relay_clarify_answers.ts` (fenced marker + structured JSON).
- Spec FR-002.

## R-8 — Refusal payload shape

**Decision**: When `cockpit_claim` returns a refusal, it returns `{ status: 'error', class: 'claim-conflict', detail: <human message>, hint?: <takeover instructions>, holder: ClaimPayload }`. The `holder` field carries the incumbent's full comment payload (`sessionId`, `heartbeatAt`, `ledger`, `heldSince`) so the calling skill can render an actionable gate without a second GitHub call.

**Rationale**:
- FR-004: "the caller MUST surface a refusal identifying the other session id and ledger path."
- Callers need the payload structured, not just a rendered string, so the skill can present a `Takeover / Cancel` gate with typed fields.
- New `ErrorClass` value: `'claim-conflict'`. Distinct from `'contended'` (used by scope-writer for retry-exhaustion) and `'gate-refusal'` (used for label-state refusals).

**Sources**:
- Spec FR-004.
- Existing pattern in `errors.ts` (`ErrorClass` enum — extend, don't rename).

## R-9 — Discovery algorithm (label + comment consistency)

**Decision**: On any arm/refresh, the algorithm is:

1. Fetch scope issue: labels + comments (single `gh issue view --json labels,comments` call).
2. Filter comments whose body starts with `<!-- cockpit:claim v1 -->`. Parse the fenced JSON. Validate against `ClaimMarkerSchema`.
3. Compute `livePayloads` = parsed markers whose `heartbeatAt` is within the last 10 minutes (per R-3).
4. **Zero live payloads → no active claim** (regardless of label).
   - If label `cockpit:claimed` present: remove it (orphaned-label tolerance, FR-003).
   - Delete any stale claim marker comments (best-effort — record but don't fail on delete errors).
   - Return `no-claim`.
5. **One live payload → active claim**. Return `{ holder: payload, commentId: <that comment's id> }`.
6. **≥2 live payloads → race**. Rare — indicates two sessions raced acquire. Resolution: **oldest `heldSince` wins**; younger claims are treated as stale and deleted. Return `{ holder: <oldest>, commentId: <that comment's id> }`.

**Rationale**:
- Fresh full listing per operation trades one GitHub read for absolute correctness (no cache staleness).
- Oldest-wins tiebreaker on race is deterministic and matches "first acquirer keeps the claim."
- Orphaned-label removal is best-effort at discovery time (spec FR-003).

## R-10 — Acquire / takeover as read-modify-write

**Decision**: Two-phase, non-atomic (GitHub has no CAS on comments). The algorithm:

**Acquire (no existing claim)**:
1. Discover (per R-9).
2. If `no-claim`: `postIssueComment` with marker, then `addLabels(['cockpit:claimed'])`.
3. Re-discover to verify our comment is the winner (race guard).
   - If our sessionId is the sole live holder → success.
   - If a different session's sessionId is now the sole live holder → we lost the race; delete our just-posted comment, return refusal payload.

**Refresh (same session already holds)**:
1. Discover; verify `holder.sessionId === ourSessionId`.
2. `editIssueComment(holder.commentId, <marker with fresh heartbeatAt>)`.
3. Return `{ status: 'ok', action: 'refreshed' }`.

**Takeover (`takeover: true`, existing claim by different session)**:
1. Discover; capture `holder` details for the return payload.
2. Delete incumbent's comment via `deleteIssueComment(holder.commentId)`.
3. Post our own marker comment; ensure label present.
4. Re-discover to verify (race guard, same as acquire).
5. Return `{ status: 'ok', action: 'taken-over', displaced: <old holder> }`.

**Refuse (existing claim by different session, no `takeover: true`)**:
1. Discover; return `{ status: 'error', class: 'claim-conflict', holder: <holder payload>, hint }`.

**Rationale**:
- Post-then-verify is the standard race-guard for GitHub artifacts (matches `writeScopeWithRetry` pattern in `packages/generacy/src/cli/commands/cockpit/scope/retry.ts`).
- Delete-then-post for takeover (rather than post-then-delete) minimizes the window where two live markers exist. The R-9 oldest-wins tiebreaker handles the residual race window.
- No retry loop on the acquire race — a single re-verify is sufficient; if we lose, the caller can retry at the next wake tick.

## R-11 — Release semantics

**Decision**: `cockpit_release` accepts `{ scope, sessionId }`. Two-write operation:

1. Discover.
2. If `holder.sessionId !== sessionId`: no-op (return `{ ok, action: 'not-holder' }`). Don't error — release should be idempotent.
3. `deleteIssueComment(holder.commentId)`.
4. `removeLabel('cockpit:claimed')`.

**Rationale**:
- Idempotent-on-not-holder mirrors the "release a claim you already lost" case cleanly (e.g., after takeover, superseded session calls release; should succeed as no-op).
- Delete-then-remove order matches acquire's inverse (label is enumeration index; removing it last means an interrupted release leaves a discoverable orphan that arm-time tolerance handles per FR-003).

## R-12 — `gh` CLI capability gap

**Finding**: The existing `GhCliWrapper` at `packages/cockpit/src/gh/wrapper.ts:1585` has `postIssueComment` but no edit or delete.

**Decision**: Extend `GhWrapper` interface + `GhCliWrapper` implementation with:

- `editIssueComment(repo: string, commentId: number, body: string): Promise<void>` — uses `gh api -X PATCH repos/{repo}/issues/comments/{commentId} -f body=<body>`.
- `deleteIssueComment(repo: string, commentId: number): Promise<void>` — uses `gh api -X DELETE repos/{repo}/issues/comments/{commentId}`.
- Extend `IssueComment` type with `id: number` (GraphQL `databaseId` — the REST API's numeric comment id).
- Update `fetchIssueComments` and `IssueCommentsRawSchema` to include `databaseId` in the `gh issue view --json comments` query. (Requires bumping the `--json` field set from `comments` to `comments` with `databaseId`; verify `gh issue view` supports this fielding.)

**Sources**:
- GitHub REST API docs: `PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}` and `DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}` — both stable, standard scopes.
- `gh api` is already used throughout the wrapper (see `fetchIssueTimeline` at line 1627).
- `packages/cockpit` bump is `minor` per D-2 in plan.md.

## R-13 — Testing approach

**Decision**: Follow the sibling `parity-*.test.ts` pattern.

**Unit-level (`claim/__tests__/`)**:
- `marker.test.ts`: format → parse round-trip; malformed markers rejected; version mismatch rejected.
- `discover.test.ts`: 0/1/N live payloads; stale-only markers; orphaned label.
- `acquire.test.ts`: acquire happy path; refresh happy path; takeover happy path; refuse path; two-caller race (verify oldest-wins).
- `release.test.ts`: release-as-holder happy path; release-as-non-holder no-op; release-with-no-claim no-op.

**MCP-boundary (`mcp/__tests__/parity-claim.test.ts`, `parity-release.test.ts`)**:
- Input validation (Zod errors → `class: 'invalid-args'`).
- Wrong-kind (PR passed instead of issue) → `class: 'wrong-kind'`.
- Claim conflict returns `class: 'claim-conflict'` with populated `holder`.
- Takeover surface accepted from MCP arg.

**Regression guard (`observer-independence.test.ts`)**:
- Assert that `cockpit_status`, `cockpit_context`, `cockpit_await_events` do not import from `claim/` (static analysis on module imports). SC-005.

**Integration (implicit, via existing test infrastructure)**:
- Two `cockpitClaim` calls in the same test that stubs a shared GhWrapper for the same scope: second call refuses (SC-001).
- Two `cockpitClaim` calls on different scopes with distinct stubs: both succeed (SC-002).
- Stale-claim recovery: heartbeatAt older than 10 min → new acquire succeeds without takeover (SC-003).
- Takeover semantics: after B takes over, A's next refresh detects `holder.sessionId !== A.sessionId` (SC-004).

## R-14 — What is deliberately NOT researched

- **Skill-side auto.md changes**: In the `agency` repo, out of scope for this branch. Tracked as follow-up.
- **Configurable staleness threshold**: Spec §Out of Scope — the 10-minute value is fixed.
- **Non-scope claims**: Spec §Out of Scope — claims are per-scope only (epic or tracking issue), not per-child-issue or per-PR.
- **Per-user worker lease cap**: Spec §Out of Scope — orchestrator concern.
- **In-flight session retrofit**: Spec §Out of Scope — the change takes effect on the next `/cockpit:auto` arm.

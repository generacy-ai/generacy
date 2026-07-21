# Tasks: Active-driver claim per cockpit scope

**Input**: Design documents from `/specs/1015-summary-nothing-prevents-two/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = refuse second driver, US2 = takeover, US3 = stale self-clear)

---

## Phase 1: `GhWrapper` capability gap (foundation)

The claim mechanism needs `editIssueComment` + `deleteIssueComment` and a `commentId` on `IssueComment`. Every downstream task depends on this. `@generacy-ai/cockpit` bump justification (D-2).

- [ ] T001 [US1,US2,US3] Extend `IssueComment` with `id: number` (REST-numeric comment id, sourced from GraphQL `databaseId`) in `packages/cockpit/src/gh/wrapper.ts`. Update `IssueCommentsRawSchema` to accept `databaseId`, update the mapping in `fetchIssueComments` to populate `id`, and — per research.md R-12 — extend the `gh issue view --json comments` fielding (or fall back to `gh api repos/{repo}/issues/{n}/comments`) so `id` is present in the response.
- [ ] T002 [US1,US2,US3] Add `editIssueComment(repo: string, commentId: number, body: string): Promise<void>` to the `GhWrapper` interface and `GhCliWrapper` impl in `packages/cockpit/src/gh/wrapper.ts`. Use `gh api -X PATCH repos/{repo}/issues/comments/{commentId} -f body=<body>`. Fail on non-zero exit (see `failIfNonZero` pattern).
- [ ] T003 [US2,US3] Add `deleteIssueComment(repo: string, commentId: number): Promise<void>` to the `GhWrapper` interface and `GhCliWrapper` impl in `packages/cockpit/src/gh/wrapper.ts`. Use `gh api -X DELETE repos/{repo}/issues/comments/{commentId}`. Treat 404 / "not found" stderr as idempotent success (already deleted); other non-zero exits fail.

---

## Phase 2: Types, schemas, and errors (foundation)

All types + Zod schemas live under `packages/generacy/src/cli/commands/cockpit/mcp/claim/` (new folder) and one extension in `mcp/errors.ts` + `mcp/schemas.ts`. Zod is the runtime source of truth per data-model.md.

- [ ] T004 [P] [US1,US2,US3] Create `packages/generacy/src/cli/commands/cockpit/mcp/claim/payload.ts`. Export `ClaimPayload` interface, `ClaimPayloadSchema` (Zod strict object per data-model.md §ClaimPayload — `version: z.literal(1)`, `sessionId: /^[a-f0-9]{16,64}$/`, ISO-8601 datetimes with offset, `ledger: 1..512`, scope `^[^/\s]+/[^/\s#]+#\d+$`), `LiveClaim`, `DiscoverResult`, `AcquireResult`, `ReleaseResult`, and `RefusalPayload` types.
- [ ] T005 [P] [US1] Add `ErrorClass` value `'claim-conflict'` to `packages/generacy/src/cli/commands/cockpit/mcp/errors.ts` alongside the existing `'contended'` / `'gate-refusal'` / `'wrong-kind'` / `'invalid-args'` / `'transport'` / `'scope-not-found'` / `'internal'` union. Ensure downstream `ToolErrorResult` typing accepts the new class.
- [ ] T006 [US1,US2,US3] In `packages/generacy/src/cli/commands/cockpit/mcp/schemas.ts` add `CockpitClaimInputSchema` (`scope: IssueRefInputSchema`, `sessionId: /^[a-f0-9]{16,64}$/`, `ledger: 1..512`, `takeover: z.boolean().default(false)`, `.strict()`) and `CockpitReleaseInputSchema` (`scope`, `sessionId`, `.strict()`). Depends on T004 for the `sessionId` regex constant.

---

## Phase 3: Marker parse/format (leaf, pure)

- [ ] T007 [P] [US1,US2,US3] Create `packages/generacy/src/cli/commands/cockpit/mcp/claim/marker.ts`. Export `MARKER_PREFIX = '<!-- cockpit:claim v1 -->'`, `formatMarker(payload: ClaimPayload): string` (wraps `JSON.stringify(payload, null, 2)` in the fixed HTML-comment + fenced-json body per contracts/claim-marker.md), and `parseMarker(body: string): ClaimPayload | null` (starts-with prefix check → extract ```` ```json ```` fence → `JSON.parse` → `ClaimPayloadSchema.parse` → return payload; `null` on any failure). Depends on T004.
- [ ] T008 [P] [US1,US2,US3] Create `packages/generacy/src/cli/commands/cockpit/mcp/claim/__tests__/marker.test.ts` with vitest cases: round-trip format→parse identity; missing prefix → null; corrupt JSON → null; wrong inner `version` field → null; extra fields (should fail `.strict()`) → null; body with trailing whitespace still parses. Depends on T007.

---

## Phase 4: Discovery, acquire, release (business logic — SEQUENTIAL, share the `GhWrapper` contract)

Discovery is a shared dependency of acquire, refresh, takeover, and release paths. Race-guard is post-write re-discover per R-9 / R-10.

- [ ] T009 [US1,US2,US3] Create `packages/generacy/src/cli/commands/cockpit/mcp/claim/discover.ts`. Export `discoverClaim(gh: GhWrapper, repo: string, issue: number, now: Date): Promise<DiscoverResult>`. Single `gh issue view --json labels,comments` call (via existing wrapper methods `fetchIssueLabels` + `fetchIssueComments`); filter comments via `parseMarker`; compute `livePayloads` = markers with `heartbeatAt` within last 10 min (600s absolute per R-3/FR-008); zero live → `no-claim` (best-effort delete stale markers, best-effort remove orphaned `cockpit:claimed` label per FR-003); one live → `held`; ≥2 live → oldest-`heldSince` wins, delete younger duplicates. Failures during best-effort deletes are logged and swallowed. Depends on T001, T002, T003, T004, T007.
- [ ] T010 [US1,US2] Create `packages/generacy/src/cli/commands/cockpit/mcp/claim/acquire.ts`. Export `acquireClaim({ gh, scope: { owner, repo, number }, sessionId, ledger, takeover, now }): Promise<AcquireResult | RefusalPayload>`. Implements the four branches from R-10: **acquire** (no-claim → postIssueComment + addLabels(['cockpit:claimed']) → re-discover verify → success or delete-our-comment + refuse), **refresh** (same session holds → editIssueComment with new `heartbeatAt`), **takeover** (`takeover: true` && different session → deleteIssueComment(incumbent) + postIssueComment(us) + ensure label + re-discover verify + return `taken-over` with `displaced`), **refuse** (different session && no takeover → return refusal). Stale claim treated as no-claim regardless of `sessionId` / `takeover`. Uses `formatMarker` for bodies. Post-then-verify race guard is single-shot (no retry loop). Depends on T009.
- [ ] T011 [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/claim/release.ts`. Export `releaseClaim({ gh, scope, sessionId, now }): Promise<ReleaseResult>`. Discover → holder is us → `deleteIssueComment` then `removeLabels(['cockpit:claimed'])` → return `released` with `releasedClaim`. Holder is different → return `not-holder` with `currentHolder`, no writes. No claim → return `no-claim`, best-effort orphaned-label cleanup only. Never returns `claim-conflict` (per contracts/cockpit_release.md). Depends on T009.

---

## Phase 5: Unit tests for business logic (parallel — separate files)

- [ ] T012 [P] [US1,US2,US3] Create `packages/generacy/src/cli/commands/cockpit/mcp/claim/__tests__/discover.test.ts` covering: no claim + no label → `no-claim`; no claim + orphaned label → `no-claim` with label-removal side effect; single live claim → `held`; single stale claim (`heartbeatAt` > 10 min old) → `no-claim` with stale-comment deletion; two live claims race → oldest-`heldSince` wins, younger deleted; malformed marker comment → skipped (not fatal); delete failure during best-effort cleanup → still returns correct kind. Uses a stub `GhWrapper`. Injects a fixed `now`. Depends on T009.
- [ ] T013 [P] [US1,US2] Create `packages/generacy/src/cli/commands/cockpit/mcp/claim/__tests__/acquire.test.ts` covering: acquire happy path (writes = comment post + label add); refresh happy path (writes = 1 edit; label untouched); takeover happy path (writes = delete + post; `displaced` populated); refuse path (returns refusal with populated `holder`, no writes); two-caller acquire race (post-verify pass makes both re-discover; loser deletes own comment + returns refusal); stale incumbent treated as no-claim; takeover-when-already-holder returns `refreshed` per contracts/cockpit_claim.md §Idempotency. Stub `GhWrapper`, fixed `now`. Depends on T010.
- [ ] T014 [P] [US1,US3] Create `packages/generacy/src/cli/commands/cockpit/mcp/claim/__tests__/release.test.ts` covering: release-as-holder → `released`, 2 writes; release-as-non-holder while claim exists → `not-holder`, 0 writes; release with no claim → `no-claim`, 0 writes normally + 1 write on orphaned label; delete failure surface (transport → propagates; 404 → success). Depends on T011.

---

## Phase 6: MCP tool handlers + server registration

- [ ] T015 [US1,US2,US3] Create `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_claim.ts`. Export `cockpitClaim(args: CockpitClaimInput, deps): Promise<ToolResult>`. Normalize `scope` via existing `normalizeIssueRef` (returns `wrong-kind` for PRs). Delegate to `acquireClaim`. On success return `{ status: 'ok', data: { action, claim, commentUrl, displaced? } }`. On refusal return `{ status: 'error', class: 'claim-conflict', detail, hint, holder, commentUrl }` with the exact `detail` and `hint` templates from contracts/refusal-payload.md §Field contracts (load-bearing strings). Map gh CLI failures to `class: 'transport'` / `'scope-not-found'`. Depends on T005, T006, T010.
- [ ] T016 [US1,US2,US3] Create `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_release.ts`. Export `cockpitRelease(args, deps): Promise<ToolResult>`. Normalize scope, delegate to `releaseClaim`, return `{ status: 'ok', data: { action, ... } }`. Map gh CLI failures to `transport` / `scope-not-found`. Never emits `claim-conflict`. Depends on T006, T011.
- [ ] T017 [US1,US2,US3] Register both tools in `packages/generacy/src/cli/commands/cockpit/mcp/server.ts` via `server.registerTool('cockpit_claim', { description, inputSchema: CockpitClaimInputSchema }, handler)` and same for `cockpit_release` (patterns per quickstart.md §For implementers). Depends on T015, T016.

---

## Phase 7: MCP-boundary tests + observer regression guard

- [ ] T018 [P] [US1,US2] Create `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-claim.test.ts` following the sibling `parity-advance.test.ts` shape: Zod-boundary validation (missing/malformed `sessionId`, `takeover` non-boolean, unqualified scope) → `class: 'invalid-args'`; PR scope → `class: 'wrong-kind'`; claim-conflict returns `class: 'claim-conflict'` with populated `holder` + exact `detail`/`hint` templates; takeover accepted via MCP arg; `structuredContent` envelope round-trips through the tool boundary intact. Depends on T017.
- [ ] T019 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-release.test.ts`: Zod validation; PR scope → `wrong-kind`; happy `released`; `not-holder` returned as success (never error); `no-claim` returned as success. Depends on T017.
- [ ] T020 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/observer-independence.test.ts` (SC-005 regression guard). Static-import scan: read the source of `cockpit_status.ts`, `cockpit_context.ts`, `cockpit_await_events.ts`, `cockpit_watch` (if present as an MCP tool); assert none of them `import` from `../claim/` or the `cockpit_claim` / `cockpit_release` handlers. Include `cockpit_scope_add` / `cockpit_scope_remove` if the test also wants to prove scope-writers don't inadvertently touch the claim. Depends on T017.

---

## Phase 8: Changeset

- [ ] T021 [US1,US2,US3] Add `.changeset/1015-active-driver-claim.md` bumping `@generacy-ai/generacy` **minor** and `@generacy-ai/cockpit` **minor** with summary "Add cockpit_claim + cockpit_release MCP tools for per-scope active-driver claim (#1015)." Must be a **newly added** file (CLAUDE.md gate; per plan.md D-2).

---

## Dependencies & Execution Order

**Sequential foundation** (blocks everything downstream):
- T001 → T002 → T003 (all mutate `packages/cockpit/src/gh/wrapper.ts`, same-file so no parallelization)
- T004 (payload types) must complete before T006, T007
- T005 (error class) must complete before T015

**Parallel opportunities within Phase 2**:
- T004 and T005 touch different files → run in parallel.
- T006 must wait for T004 (imports the `sessionId` shape).

**Parallel opportunities within Phase 3**:
- T007 and T008 both live under `claim/` but touch different files (`marker.ts` vs. `__tests__/marker.test.ts`) → T008 sequential after T007.

**Phase 4 is strictly sequential** — `acquire.ts` and `release.ts` both consume `discover.ts`; writing them in parallel invites drift on the discovery contract.

**Parallel opportunities within Phase 5**:
- T012, T013, T014 are all independent test files → run in parallel.

**Phase 6 sequential**:
- T015 depends on T010; T016 depends on T011; T017 depends on both.

**Parallel opportunities within Phase 7**:
- T018, T019, T020 are three independent test files → run in parallel.

**Phase 8**: T021 can be added at any time after T017, but land it with the implementation so the CI changeset gate passes on the first push.

**Story delivery**:
- **US1 (refuse second driver)**: T001–T009, T010 (refuse branch), T015, T017, T018, T020, T021 — MVP.
- **US2 (takeover)**: adds T010 (takeover branch) + T013 takeover cases + T018 takeover cases.
- **US3 (stale self-clear)**: adds T009 stale handling + T012 stale + T014 no-claim path.

---

## Notes

- No `packages/claude-plugin-cockpit/commands/*.md` playbook files are edited by this branch (plan.md §Project Structure explicitly scopes the auto.md wiring to a follow-up in the `agency` repo). Therefore no `playbook-verification.test.ts` re-pin task is emitted.
- No orchestrator changes (plan.md constitution re-check). The feature is entirely CLI/MCP surface.
- `sessionId` derivation is `INSTANCE_NONCE` — a caller responsibility per plan.md D-1; the tool never generates or validates identity beyond the regex shape.
- `now` is injected everywhere (discover / acquire / release) so tests can pin time without mocking `Date` globally.

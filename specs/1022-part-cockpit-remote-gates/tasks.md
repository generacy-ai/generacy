# Tasks: Cockpit MCP — `cockpit_gate_open` + `cockpit_gate_ack`

**Input**: Design documents from `/specs/1022-part-cockpit-remote-gates/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (this feature is single-story; all tasks tagged `[US1]`)

---

## Phase 1: Local schemas + options resolver

Foundation. No dependencies on the rest of the tree; these two files unblock everything else.

- [ ] T001 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts`
      exporting `GateRecordSchema` (passthrough on `z.record(z.unknown()).and(z.object({}).passthrough())`),
      `GateAckInputSchema` (`.strict()` with `gateId`, `outcome`, `detail?`), and the response envelopes
      `GateOpenResponseSchema` (`.passthrough()` asserting `gateId: string, status: string`) and
      `GateAckResponseSchema` (opaque `z.record(z.unknown())`). Also export inferred types
      `GateRecord`, `GateAckInput`, `GateOpenResponse`, `GateAckResponse`. Add a header comment
      citing `contracts/cockpit_gate_open.md` and the epic's `cockpit-remote-gates-plan.md` as the
      wire-contract source of truth (see data-model.md § "Core types" for the exact shapes).

- [ ] T002 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/gates/options.ts`
      exporting `interface GateClientOptions { baseUrl: string; timeoutMs: number; fetchImpl: typeof fetch }`
      and `resolveGateOptions(deps: Pick<BuildMcpServerDeps, 'orchestratorUrl' | 'orchestratorTimeoutMs' | 'fetchImpl'>, env?: NodeJS.ProcessEnv): GateClientOptions`
      with the precedence chain `arg > env['ORCHESTRATOR_URL'] > 'http://127.0.0.1:3100'` for `baseUrl`,
      `arg > 5000` for `timeoutMs`, `arg > global fetch` for `fetchImpl` (see data-model.md § "Options-bag schema").
      Import `BuildMcpServerDeps` from `../server.js`. Do not read `process.env` outside this file.

---

## Phase 2: HTTP client + tests

Depends on Phase 1. `client.ts` is the beating heart of both tools; its unit tests are the primary
correctness surface for the error-mapping table.

- [ ] T003 [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/gates/client.ts` exporting
      one function `invokeGate<T>(request: { method: 'POST'; path: string; body: unknown }, options: GateClientOptions): Promise<ToolResult<T>>`.
      Implementation:
      1. Build absolute URL as `new URL(request.path, options.baseUrl).toString()` — path always starts with `/cockpit/gates`.
      2. Create `AbortController`; `setTimeout(() => controller.abort(), options.timeoutMs)`.
      3. Call `options.fetchImpl(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(request.body), signal: controller.signal })`.
      4. On thrown error: classify `AbortError` → `transport` with detail `"orchestrator request timed out after ${timeoutMs}ms"`; anything else → `transport` with `err.message` first-line.
      5. On 2xx: parse body as JSON; on parse failure → `internal` with detail `"orchestrator returned non-JSON <verb> response"` (verb inferred from path).
      6. On non-2xx: switch by `res.status` — 400 → `invalid-args`, 404 → `unknown-gate`, 409 → `invalid-args`, other 4xx → `internal`, 5xx → `transport`. `detail` = first non-empty line of response body (mirror `firstLineOr` helper in `errors.ts:195`).
      7. Return `ToolOkResult<T>` on 2xx, `ToolErrorResult` otherwise, using the envelope factory pattern from `mcp/errors.ts:96-193`.
      Note: envelope-shape validation for `cockpit_gate_open`'s required `{gateId, status}` fields is done by the caller (T005), not here — this file is verb-agnostic.

- [ ] T004 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/gates/__tests__/options.test.ts`
      covering `resolveGateOptions` precedence (see research.md R2): (a) arg wins over env and default,
      (b) env wins over default when arg omitted, (c) default when both omitted, (d) `orchestratorTimeoutMs` default of 5000,
      (e) `fetchImpl` falls back to global `fetch` when arg omitted, (f) `env` parameter is defaulted to `process.env` but does not read it when a custom env is passed.

- [ ] T005 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/gates/__tests__/client.test.ts`
      covering the R4 error-mapping table (see contracts/error-mapping.md): 2xx happy path, HTTP 400 → `invalid-args`,
      HTTP 401 → `internal`, HTTP 403 → `internal`, HTTP 404 → `unknown-gate`, HTTP 405 → `internal`,
      HTTP 409 → `invalid-args`, HTTP 410 → `internal`, HTTP 429 → `internal`, HTTP 500 → `transport`,
      HTTP 502 → `transport`, HTTP 503 → `transport`, network error (`fetchImpl` throws) → `transport`,
      timeout (`AbortController` fires, uses `signal.addEventListener('abort', ...)` pattern from quickstart.md §
      "Timeout test") → `transport` with detail matching `/timed out after \d+ms/`, 2xx with non-JSON body → `internal`.
      All 14+ cases via a spy `fetchImpl`; no `global.fetch` monkey-patch.

---

## Phase 3: MCP-boundary schema exports

Depends on Phase 1 (`gates/schemas.ts`). Elevates the internal Zod schemas to the MCP boundary
so the tool handlers can consume them via `mcp/schemas.ts` re-exports (matches the pattern used
by every other cockpit MCP tool — see `parity-*.test.ts` imports).

- [ ] T006 [US1] Modify `packages/generacy/src/cli/commands/cockpit/mcp/schemas.ts` to export
      `CockpitGateOpenInputSchema` and `CockpitGateAckInputSchema` (data-model.md § "MCP-boundary schemas"),
      plus their inferred types `CockpitGateOpenInput` and `CockpitGateAckInput`. The schemas re-use
      the ones defined in `gates/schemas.ts` (T001) — this file is a stable public-import surface for
      the tool handlers and the audit tests.

---

## Phase 4: Tool handlers

Depends on Phases 2 (client.ts) and 3 (schemas.ts).

- [ ] T007 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_open.ts`
      exporting `cockpitGateOpen(input: unknown, deps: BuildMcpServerDeps): Promise<ToolResult<CockpitGateOpenData>>`.
      Implementation: (1) parse `input` with `CockpitGateOpenInputSchema`; on Zod fail → `invalid-args`
      with detail = issues joined by `; `. (2) `const options = resolveGateOptions(deps)`. (3) Call
      `invokeGate<CockpitGateOpenData>({ method: 'POST', path: '/cockpit/gates', body: parsed }, options)`.
      (4) On 2xx, additionally assert `{ gateId: string, status: string }` via
      `GateOpenResponseSchema.safeParse(result.data)`; on shape violation return `internal` with detail
      `"orchestrator returned malformed gate-open response"`. Export the type
      `CockpitGateOpenData = { gateId: string; status: string; [k: string]: unknown }`.

- [ ] T008 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_ack.ts`
      exporting `cockpitGateAck(input: unknown, deps: BuildMcpServerDeps): Promise<ToolResult<CockpitGateAckData>>`.
      Implementation: (1) parse `input` with `CockpitGateAckInputSchema` (strict); on Zod fail → `invalid-args`.
      (2) `const options = resolveGateOptions(deps)`. (3) Call
      `invokeGate<CockpitGateAckData>({ method: 'POST', path: \`/cockpit/gates/\${encodeURIComponent(parsed.gateId)}/ack\`, body: { outcome: parsed.outcome, detail: parsed.detail } }, options)`.
      Response body is opaque — no envelope-shape assertion (contracts/cockpit_gate_ack.md § "Output — success").
      Export the type `CockpitGateAckData = Record<string, unknown>`.

---

## Phase 5: Server registration + invariant-#1 exception header

Depends on Phase 4. Wires the two handlers into the MCP-server tool list.

- [ ] T009 [US1] Modify `packages/generacy/src/cli/commands/cockpit/mcp/server.ts`:
      (a) Extend `BuildMcpServerDeps` (currently at ~`:42`) with three optional fields:
      `orchestratorUrl?: string`, `orchestratorTimeoutMs?: number`, `fetchImpl?: typeof fetch`.
      (b) At the END of the tool registration chain (after `cockpit_await_events`) — register
      `cockpit_gate_open` and `cockpit_gate_ack` in that order, each `registerTool` calling into
      the T007/T008 handlers with the destructured `deps` object.
      (c) Immediately above the two new registrations, add a header comment documenting the Q3 → A
      exception to design invariant #1 (see spec.md § "Clarified decisions" and research.md R8):
      the two tools intentionally do NOT have a `generacy cockpit gate-open|gate-ack` CLI twin because
      they are only usable from within a driving `/cockpit:auto` session; mocked-orchestrator unit
      tests cover the same code paths a CLI would exercise.

---

## Phase 6: Parity & audit tests

Depends on Phase 5. These are MCP-boundary tests that invoke the tools through the built server
(the `parity-*.test.ts` pattern established by `parity-claim.test.ts`).

- [ ] T010 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-gate-open.test.ts`
      following the parity-claim.test.ts injection pattern (quickstart.md §
      "Verifying the injection seam"). Cover the 11 rows in
      contracts/cockpit_gate_open.md § "Test surface": happy 200, passthrough field forwarded,
      input not an object, HTTP 400, 404, 409, 401, 500, network error, timeout, and 2xx with
      missing `gateId`. Assert via the ToolResult envelope (`status: 'ok'` / `status: 'error', class: '...'`).

- [ ] T011 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-gate-ack.test.ts`
      covering the 13 rows in contracts/cockpit_gate_ack.md § "Test surface": happy 200 with JSON body,
      2xx non-JSON, missing `gateId`, missing `outcome`, empty `gateId`, extra key (strict-mode
      rejection), HTTP 400/404/409/500, network error, timeout, and — importantly — a `detail`-present
      case that asserts the POST body reaching the spy `fetchImpl` contains `{ outcome, detail }`
      verbatim (proves the wire-format decision from T008).

- [ ] T012 [US1] Modify `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/tool-schema-audit.test.ts`
      to add `cockpit_gate_open` and `cockpit_gate_ack` entries to the `EXPECTED_KIND` table
      (both `'issue'`-shaped in intent, though the actual "kind" categorization is documented at
      the top of that file — pick the closest match, likely `'none'` or a new `'gate'` bucket per
      the existing convention; if a new bucket is introduced, add it to the type union at the file
      header). Also add `cockpit_gate_open: null` and `cockpit_gate_ack: null` to the
      `NO_CLI_VERB_TOOLS` companion table so the audit's forcing-function assertion passes.
      Assert the two new tool names appear in the `listTools` output from a `buildMcpServer({})` call
      (matches the sweep at `tool-schema-audit.test.ts:102-111`).

---

## Phase 7: Changeset

- [ ] T013 [US1] Create `.changeset/1022-cockpit-remote-gates-mcp.md` with frontmatter
      `'@generacy-ai/generacy': minor` and body
      `feat(cockpit-mcp): add \`cockpit_gate_open\` and \`cockpit_gate_ack\` HTTP-client tools for the Cockpit Remote Gates epic (#1022).`
      Bump reason: two new MCP tools = new capability. No `@generacy-ai/cockpit` package changes → no bump there
      (verified: this branch touches only `packages/generacy/**`; see plan.md § "Project Structure").

---

## Phase 8: Verification

- [ ] T014 [US1] Playbook coupling — informational verification only.
      Files edited by this issue: **none** in `packages/claude-plugin-cockpit/commands/*.md`.
      plan.md § "Project Structure" mentions `packages/claude-plugin-cockpit/commands/auto.md` in an
      out-of-scope-for-this-branch note ("Skill-side prose … tracked separately in the epic P4"),
      and that file does not exist in this repo (`packages/claude-plugin-cockpit/` is an agency-repo
      package, not a generacy-repo package). The `playbook-verification.test.ts` pin-audit test likewise
      lives in the `agency` repo, not here. **Verify manually before shipping** that no
      `packages/claude-plugin-cockpit/commands/*.md` edits sneak into the PR diff; if they do, the
      agency-repo pin sites must be re-pinned in the sibling P4 PR. Re-pinning means updating the
      assertion to the NEW contract established by the playbook edit. **Do NOT weaken or delete an
      assertion to make the test pass** — the pin is a drift audit; weakening it deletes its value.

- [ ] T015 [US1] Run `pnpm --filter @generacy-ai/generacy build` and `pnpm --filter @generacy-ai/generacy test -- gate`
      (quickstart.md § "Landing the change" step 6). Both must pass green before opening the PR.
      Also `pnpm --filter @generacy-ai/generacy typecheck` (or the local equivalent) — the
      `BuildMcpServerDeps` extension is a public interface change so type errors will surface
      throughout the MCP boundary if the schema exports (T006) are wrong.

---

## Dependencies & Execution Order

**Sequential phase boundaries** (each phase blocks the next):

1. **Phase 1** (`gates/schemas.ts`, `gates/options.ts`) — no dependencies; T001 and T002 are `[P]`.
2. **Phase 2** (`gates/client.ts` + tests) — needs Phase 1. T003 blocks T005; T004 is `[P]` with T005.
3. **Phase 3** (`mcp/schemas.ts` re-exports) — needs T001.
4. **Phase 4** (tool handlers) — needs T003 (client) and T006 (schema re-exports). T007 and T008 are `[P]`.
5. **Phase 5** (`mcp/server.ts` registration) — needs T007 and T008.
6. **Phase 6** (parity + audit tests) — needs T009. T010, T011, T012 are `[P]`.
7. **Phase 7** (changeset) — can run any time after Phase 5 (needed for CI green, not for other tasks).
8. **Phase 8** (verification) — last.

**Parallelization summary**:

- Phase 1: T001 ‖ T002.
- Phase 2: T004 ‖ T005 after T003.
- Phase 4: T007 ‖ T008.
- Phase 6: T010 ‖ T011 ‖ T012.

**Total tasks**: 15. **Suggested next step**: `/speckit:implement` to begin execution.

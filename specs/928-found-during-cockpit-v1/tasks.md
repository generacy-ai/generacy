# Tasks: cockpit_merge issue-ref contract fix

**Input**: Design documents from `/specs/928-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = single-story fix)

## Phase 1: Resolver shape change (foundation)

- [ ] T001 [US1] Extend `PullRequestRefResolution` union in `packages/cockpit/src/gh/wrapper.ts` (lines 80–84) with a new zero-field arm `{ kind: 'pr-number' }`. Update the union docstring with invariants I-6 (zero-field variant) and I-7 (tier-1-only emission).
- [ ] T002 [US1] Extend `Tier1InitialResponseSchema` (and the tier-1 GraphQL query if needed) in `packages/cockpit/src/gh/wrapper.ts` so tier-1 surfaces "the requested `<number>` is a `PullRequest`, not an `Issue`" natively via `Node.__typename` (zero extra round-trips). Return `{ kind: 'pr-number' }` immediately when detected — do not fall through to tier-2/tier-3.
- [ ] T003 [US1] Add exhaustive-check `never` guards at every existing `resolveIssueToPRRef` result callsite so the new arm surfaces at build time. Fix any callsites the type-checker flags with an appropriate branch (defer to T005 for `runMerge`).
- [ ] T004 [P] [US1] Add a test case in `packages/cockpit/src/gh/__tests__/wrapper.tier1-shape-drift.test.ts` that stubs the tier-1 response for a PR-numbered node and asserts `{ kind: 'pr-number' }` returns without invoking tier-2/tier-3.

## Phase 2: CLI `runMerge` — consume the new arm

- [ ] T005 [US1] In `packages/generacy/src/cli/commands/cockpit/merge.ts` `runMerge` (around line 309), add a `pr-number` branch after the `unresolved` branch: return `{ exitCode: 2, stdout: serializeFailingCheckJson(buildFailingCheckPayload({ reason: 'pr-number', pr: null, issue: issueRef, hint: '#${issue} is a pull request; pass the issue number (e.g. the issue whose closing PR is #${issue}).' })) }`. Terminate the discriminated switch with `const _: never = resolution;`.
- [ ] T006 [US1] Extend `buildFailingCheckPayload` (in `packages/generacy/src/cli/commands/cockpit/merge.ts`) `reason` union to include `'pr-number'`, and thread through the new required `hint` field for that arm (nullable/omitted on other arms).
- [ ] T007 [P] [US1] Add a case to the existing merge tests (`packages/generacy/src/cli/commands/cockpit/__tests__/merge.test.ts` or equivalent) that stubs `resolveIssueToPRRef` returning `{ kind: 'pr-number' }` and asserts `exitCode === 2`, `stdout` JSON contains `reason: 'pr-number'` and the guidance hint. This case also closes CLI finding #906 (`cockpit merge 15` on a PR number).

## Phase 3: MCP schemas + qualified-forms helper

- [ ] T008 [US1] Rewrite `CockpitMergeInputSchema` in `packages/generacy/src/cli/commands/cockpit/mcp/schemas.ts` (around line 86): rename field `pr` → `issue` (typed `IssueRefInputSchema`), add optional `pr: z.number().int().positive().optional()`, keep `.strict()`. Add the redirection handling: either a `.superRefine()` that detects `pr: <IssueRefInput>` (non-numeric) and issues the typed message, or an intercept in the tool handler (T012) — pick whichever reads clearer.
- [ ] T009 [P] [US1] Add `assertQualifiedString(value: string): ParsedQualified | { error: string }` helper to `packages/generacy/src/cli/commands/cockpit/mcp/ref-input.ts`. Accepts either the `^([^/\s]+)/([^/\s#]+)#(\d+)$` short-form or a full GitHub URL (reuse existing URL parser from `resolver.ts`). Returns typed rejection copy naming the accepted forms when neither matches. Export for use across all seven MCP tools.

## Phase 4: MCP envelope-mapping helper + handler rewrite

- [ ] T010 [US1] Add `toMcpResult<T>(cliJsonStdout: string, exitCode: number): ToolResult<T>` to `packages/generacy/src/cli/commands/cockpit/mcp/errors.ts` (alongside the existing `mapCockpitExitToToolError`). Implement the mapping table from data-model.md §`toMcpResult` (`exit=0 → ok`, `exit=2 + reason='pr-number' → wrong-kind` with `hint`, other `exit=2` reasons → `gate-refusal`, missing/other reason → `invalid-args`, `exit=3 → gate-refusal`, `exit=1 → transport`, `exit≥4 → internal`, non-JSON stdout → `internal`).
- [ ] T011 [US1] Rewrite `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_merge.ts`: correct the docstring (issue-in-PR-out; optional `pr` mirrors CLI `--pr <number>`); change `expects: 'pr'` → `expects: 'issue'`; parse `{ issue: IssueRefInput; pr?: number }`; call `assertQualifiedString` when `input.issue` is a bare string; when `parsed.data.pr` is present call `runMergeWithExplicitPr({ issue: normalized.value.ref.number, prNumber: parsed.data.pr })`, else call `runMerge({ issue: normalized.value.ref.number })`; wrap result with `toMcpResult(result.stdout, result.exitCode)`.
- [ ] T012 [US1] In the same handler, implement the old-field-name redirection (Q5 → B): if Zod parse fails with an unknown-key error and the raw input carries a `pr` key whose type is non-numeric, override the detail with `"the 'pr' field was renamed to 'issue'; pass the issue ref, not the PR number"`. (Skip if T008 handled this at the schema layer.)

## Phase 5: Regression tests

- [ ] T013 [US1] Expand `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-merge.test.ts` with the distinct-number fixture (issue #2 ↔ PR #15). Cover all 10 branches from plan.md §Step 6: happy path, `pr-number`, `unresolved`, `ambiguous`, `pr-is-draft`, `checks-failing`, `pr` escape-hatch success, `pr` escape-hatch linkage refusal, old-field-name redirection, MCP bare-string rejection. Each case must assert `toMcpResult(cliOutput, exitCode)` deep-equals the observed MCP `ToolResult`. Document the distinct-number fixture invariant at the top of the file.
- [ ] T014 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/envelope-mapping.test.ts` with direct unit tests over `toMcpResult()` — one per exit-code/reason combination from the contract table. No gh stub; fast. Includes a negative case that a novel `reason` string on `exit=2` falls through to `invalid-args` (not silently `gate-refusal`).
- [ ] T015 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/tool-schema-audit.test.ts` with the hardcoded per-verb table from data-model.md §`Reference-Kind Audit Table` (7 entries: `cockpit_status: 'epic'`, `cockpit_context: 'issue'`, `cockpit_advance: 'issue'`, `cockpit_resume: 'issue'`, `cockpit_queue: 'epic'`, `cockpit_merge: 'issue'`, `cockpit_await_events: 'epic'`). For each entry: grep the MCP handler source for `normalizeIssueRef({ expects: '...' })` and assert equality; grep the Commander verb file for the usage token (`<issue>`, `<epic>`, `<issue-ref>`, etc.) and assert canonicalization matches. Fail loudly on missing table entry when a new `cockpit_*.ts` tool is added.

## Phase 6: Drift sweep

- [ ] T016 [P] [US1] FR-004 docstring audit — skim each `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_*.ts` (seven files) docstring and correct any that misdescribe the wrapped CLI verb's ref kind. The audit-table test (T015) catches schema-vs-source drift; this sweep catches human-readable drift.
- [ ] T017 [P] [US1] Q5 companion sweep — run `git grep -n "cockpit_merge" -- 'agency/**' 'specs/**'` and rename any `{ pr: <IssueRefInput> }` payloads to `{ issue: <IssueRefInput> }`. Leave `{ pr: <number> }` (the escape hatch) untouched.

## Dependencies & Execution Order

**Sequential chain (must respect order)**:
- Phase 1 (T001 → T002 → T003) — resolver shape lands first; every exhaustive-check callsite reveals itself.
- Phase 2 (T005 → T006) — depends on T001/T002 (new arm exists) and T003 (build-time enforcement of the switch).
- Phase 3 (T008) — depends on nothing from Phase 1/2 (schema-only), but Phase 4 depends on it.
- Phase 4 (T010 → T011 → T012) — T010 must land before T011 (handler calls the helper); T012 may be folded into T008 or T011.
- Phase 5 (T013) — depends on Phases 1–4 complete (touches all layers). T013 is the load-bearing regression; ship last but before Phase 6 sweep.

**Parallel opportunities**:
- T004 (resolver test) [P] — parallel with T005/T006 once T002 lands.
- T007 (CLI merge test) [P] — parallel with Phase 3/4 work once T005/T006 land.
- T009 (`assertQualifiedString` helper) [P] — parallel with T008; independent file.
- T014 (envelope-mapping unit test) [P] — parallel with T013 once T010 lands.
- T015 (tool-schema-audit test) [P] — parallel with T013/T014; independent file, only reads sources.
- T016 (docstring sweep) [P] — parallel with T017; independent file scope.
- T017 (playbook sweep) [P] — parallel with T016; independent scope.

**Critical path**: T001 → T002 → T005 → T011 → T013 (five-hop, blocks SC-001/SC-002/SC-003).

## Suggested Next Step

Run `/speckit:implement` to begin execution.

---

*Generated by speckit for #928*

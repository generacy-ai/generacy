# Tasks: Re-justify `cockpit_gate_list`'s `runId` drop after generacy-cloud#894

**Input**: Design documents from `/specs/1080-problem-cockpit-gate-list/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md, clarifications.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Baseline capture

- [X] T001 Capture SC-001 pre-fix baseline (five expected matches) and SC-002 identifier-token counts by running from repo root:
  ```
  grep -rniE "runId requires generation|would 400|would produce a 400|RFC-7807" packages/generacy/src/cli/commands/cockpit/
  grep -c "agency#471"        packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_list.ts
  grep -c "generacy-cloud#894" packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_list.ts
  ```
  Record output in the PR description or a scratch note — the post-fix run must return 0 for the first grep (SC-001) and ≥1 for each token grep (SC-002).

## Phase 2: Prose rewrites (comment-only; no behavior change)

- [X] T002 [P] [US1] Rewrite the 10-line handler comment at `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_list.ts:50-59` per FR-001 and research.md Decision 2 (paraphrase into the file's compressed voice; do NOT copy issue Ask #1 verbatim per Q5=B). The rewritten block MUST preserve all four load-bearing facts:
  1. The drop is a *policy*, not a workaround for a cloud refine.
  2. The cloud accepts `?runId=` as a real equality filter as of `generacy-cloud#894` (so this is not a validation gap being papered over).
  3. `agency#471`'s startup-sweep adoption path depends on `cockpit_gate_list` returning **prior** runs' gates — a run-filtered list at startup returns `{gates:[]}` by construction and silently defeats adoption.
  4. Forwarding is a behavior change requiring a named consumer; the correct extension path is an explicit opt-in for run-scoped list, NOT removing the drop (Q4=A — state the direction, do not design the API shape).
  Keep secondary sentences (a) parity with `cockpit_gate_status` (schema accepts `runId`, handler MUST NOT propagate) and (b) handler does NOT emit `runIdSource` log line per #1067 Q3=C. DELETE the stale (c) "cloud follow-up is a separate generacy-cloud issue" sentence (that follow-up shipped as `generacy-cloud#894` and the primary paragraph already names it). The literal tokens `agency#471` and `generacy-cloud#894` MUST appear at least once each in the new comment (SC-002 grep gate). No mention of "would 400", "RFC-7807", or "runId requires generation" (SC-001 grep gate). The handler code block at lines 47-63 (`resolveGateOptions`, `createGateQueryClient`, `listInput` construction) MUST remain byte-identical (FR-004 / SC-004).

- [X] T003 [P] [US2] Shrink the docblock on `CockpitGateListInputSchema.runId` at `packages/generacy/src/cli/commands/cockpit/mcp/gates/query-schemas.ts:65-74` per FR-002 and research.md Decision 3 (Q2=B: one-line fact + cross-link). Target wording (adjust to file's block-comment convention):
  ```
  /** Accepted for MCP-surface parity with `cockpit_gate_status`. Handler drops
   *  it before the cloud call — see `tools/cockpit_gate_list.ts` for rationale. */
  ```
  The one-liner MUST state the *fact* that the handler drops the field (a bare `// see …` cross-link is insufficient per Q2 answer). The Zod shape (`z.string().min(1).optional()`) on line 75, the `.strict()` boundary on line 77, and the `CockpitGateListInput` type export on line 78 MUST remain byte-identical. No mention of "would 400", "RFC-7807", "runId requires generation", or the deleted refine.

## Phase 3: Test updates

- [X] T004 [US3] Rename the existing wire-level test description at `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-gate-list.test.ts:234` per FR-003 and Q1=A. Change the current `it('handler drops runId before the client call — outbound URL never carries runId', ...)` to something like `it('outbound list URL never carries runId (wire-level guard)', ...)`. The current name claims a client-seam guarantee but the assertion (`expect(url).not.toContain('runId=')` / `run_id=`) operates at the wire — the exact "prose asserts more than the artifact does" failure mode that produced this issue. The body of the test (spy on `fetchImpl`, `runId` + `gateType` inputs, both `runId=` and `run_id=` URL checks) MUST remain byte-identical. Test description MUST NOT reference the vanished 400 rationale.

- [X] T005 [US3] Add a new client-seam test in the same `describe('#1067 — CockpitGateListInputSchema runId widening', ...)` block at `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-gate-list.test.ts` (immediately after the renamed wire-level test — around line 248). Per FR-003 / SC-003 and research.md Decision 1: use `vi.mock('../gates/query-client.js', ...)` at file top (or `vi.hoisted(() => …)` for the spy factory to satisfy hoisting) to replace `createGateQueryClient` with a factory returning a spy-backed `listGates`. Invoke `cockpitGateList` with an input carrying `issueRef`, `gateType`, AND `runId`, then assert:
  - `spy.mock.calls[0][0]` (the argument object passed to `client.listGates`) has NO `runId` property (use `expect(...).not.toHaveProperty('runId')` or `Object.keys(arg)` assertion).
  - The argument object DOES carry `issueRef` and (when supplied) `gateType`.
  Test description MUST name the client-seam guarantee (e.g. `'handler strips runId before invoking client.listGates (client-seam guard)'`) and MUST NOT reference the vanished 400 rationale. This test is the load-bearing pin for the handler-level claim that the wire-level guard cannot see (see research.md Decision 5 table).

## Phase 4: Changeset

- [X] T006 Add `.changeset/1080-runid-drop-rejustification.md` per plan.md § Changeset:
  ```
  ---
  "@generacy-ai/generacy": patch
  ---

  Re-justify the handler-side `runId` drop in `cockpit_gate_list` after
  generacy-cloud#894 (documentation-and-test-only; behavior byte-identical).
  ```
  New file (`--diff-filter=A` per CLAUDE.md changeset gate). `patch` bump because the change is non-test comment prose under `packages/generacy/src/` with no public API surface change (spec Assumption 8). Do NOT use `pnpm changeset --empty` — a corrected justification IS a shipped correctness note for downstream integrators reading the comment via unpkg / GitHub source view.

## Phase 5: Verification

- [X] T007 Run SC-001 post-fix grep from repo root (quickstart.md § 1):
  ```
  grep -rniE "runId requires generation|would 400|would produce a 400|RFC-7807" packages/generacy/src/cli/commands/cockpit/
  ```
  MUST return zero matches. If any hit appears, either the T002 or T003 rewrite left stale prose OR a new site was introduced — fix before proceeding.

- [X] T008 Run SC-002 post-fix identifier-token check (quickstart.md § 1):
  ```
  grep -c "agency#471"        packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_list.ts
  grep -c "generacy-cloud#894" packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_list.ts
  ```
  MUST return ≥1 for each. Discipline reminder from clarifications Q5 and research.md Decision 2: this checks identifier tokens, NOT prose shapes. Do not grep for `startup-sweep`, `run-agnostic`, or any sentence fragment — that would train weakening the check.

- [X] T009 Run SC-003 test-suite verification (quickstart.md § 2):
  ```
  cd packages/generacy && pnpm vitest run src/cli/commands/cockpit/mcp/__tests__/parity-gate-list.test.ts
  ```
  MUST show both the renamed wire-level test (T004) AND the new client-seam test (T005) green, plus every existing test in the `#1067 — CockpitGateListInputSchema runId widening` describe block still passing. Two guards, both green, against unchanged handler code.

- [X] T010 Run SC-005 non-test-file diff sanity check (quickstart.md § 4) from repo root:
  ```
  git diff develop -- packages/generacy/src/ | grep -E "^[-+][^-+]" | grep -vE "^[+-]\s*(//|\*)" | grep -vE "^\+\+\+|^---"
  ```
  MUST produce **empty output** for non-test files. Any non-comment hit outside test files means production code changed unintentionally — investigate and revert unless it is a comment-block boundary shift. Confirms handler at `cockpit_gate_list.ts:47-63` and schema shape at `query-schemas.ts:75-77` are byte-identical (FR-004 / SC-004).

- [X] T011 Run SC-004 + full-package guard (quickstart.md § 3) from `packages/generacy`:
  ```
  pnpm build && pnpm typecheck && pnpm vitest run
  ```
  MUST show all existing tests green with zero new failures. `vi.mock('../gates/query-client.js', ...)` must not break the observer-independence import-scan at `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/observer-independence.test.ts` (this change does not touch imports, so it stays green by construction — verify).

## Dependencies & Execution Order

**Phase order** (sequential):

- Phase 1 (T001) → Phase 2 (T002, T003) → Phase 3 (T004, T005) → Phase 4 (T006) → Phase 5 (T007–T011).
- Baseline (T001) precedes rewrites so the "5 matches → 0 matches" and "0 tokens → ≥1 token" deltas are observable.
- Verification (T007–T011) requires all edits (T002–T006) landed.

**Parallel opportunities within phases**:

- **Phase 2**: T002 and T003 touch different files (`cockpit_gate_list.ts` vs `query-schemas.ts`); marked `[P]` — safe to run concurrently.
- **Phase 3**: T004 (rename existing test description) and T005 (add new test) both touch `parity-gate-list.test.ts`. NOT parallel — T004 rewrites lines 234-247 in the existing `describe` block and T005 adds a new `it` block adjacent to it in the same block. Do T004 first, then T005 (avoids merge conflicts on the same lines).
- **Phase 5**: T007–T011 are read-only verifications and can run in any order (or in parallel).

**Playbook coupling**: none. Spec references `agency/packages/claude-plugin-cockpit/commands/auto.md` but only as an out-of-scope, different-repo file (spec §Out of Scope + Assumption 5 + FR-005 = "no cross-repo PR"). `packages/claude-plugin-cockpit/` does not exist in this repo, so `playbook-verification.test.ts` cannot be pinned here.

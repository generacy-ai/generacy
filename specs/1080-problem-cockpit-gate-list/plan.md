# Implementation Plan: Re-justify `cockpit_gate_list`'s `runId` drop after generacy-cloud#894

**Feature**: Re-justify `cockpit_gate_list`'s `runId` drop after generacy-cloud#894
**Branch**: `1080-problem-cockpit-gate-list`
**Status**: Complete

## Summary

Rewrite three prose sites in `packages/generacy/src/cli/commands/cockpit/mcp/` that currently justify the handler-side `runId` drop by naming a cloud Zod refine (`.refine((q) => q.runId === undefined || q.generation !== undefined, { message: 'runId requires generation' })`) that generacy-cloud#894 has already replaced with a real `where('runId', '==', X)` equality filter. Also fix one test whose *name* claims a client-seam guarantee while its *assertion* is at the wire, and add a second test that actually pins the client-seam claim.

The drop stays byte-for-byte identical. Only the justification and the test-name/coverage change. The new justification: the drop is a *policy* — a run-agnostic list is the primitive `agency#471`'s startup-sweep adoption pass depends on (a run-filtered list at startup returns `{gates:[]}` by construction and silently defeats adoption).

## Technical Context

- **Package**: `@generacy-ai/generacy` (also `@generacy-ai/orchestrator` if any test utility crosses — verified below: no orchestrator touch).
- **Language**: TypeScript, ESM, Node >=22.
- **Test framework**: Vitest.
- **Files touched (three prose + one test-rename + one test-add)**:
  - `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_list.ts:50-59` — replace the 10-line handler comment (FR-001).
  - `packages/generacy/src/cli/commands/cockpit/mcp/gates/query-schemas.ts:65-74` — shrink docblock on `CockpitGateListInputSchema.runId` to one line (FR-002).
  - `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-gate-list.test.ts:234-247` — rename existing describe/it wording; add adjacent `it` block that mocks `createGateQueryClient` (FR-003).
- **Zero production code path change** (FR-004): the handler still does `const listInput = { issueRef, ...(gateType !== undefined ? { gateType } : {}) };` — no `runId` propagation.
- **Zero new files** in `src/`. Test change is confined to the existing `parity-gate-list.test.ts` describe block at `line 190`.

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo. Constitution check trivially passes. Governing rules for this change come from `CLAUDE.md` (changeset gate) and the existing observer-independence import-scan at `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/observer-independence.test.ts` (this change does not touch imports, so it stays green by construction).

## Project Structure

```
packages/generacy/src/cli/commands/cockpit/mcp/
├── tools/
│   └── cockpit_gate_list.ts           ← FR-001: rewrite lines 50-59 (comment-only)
├── gates/
│   ├── query-schemas.ts               ← FR-002: shrink docblock on runId field (lines 65-74)
│   └── query-client.ts                 ← UNTOUCHED (buildListUrl already never sets runId)
└── __tests__/
    └── parity-gate-list.test.ts       ← FR-003: rename existing test (line 234) + add client-seam test in the same describe block
```

## Files NOT Touched (explicit)

- `packages/generacy/src/cli/commands/cockpit/mcp/gates/query-client.ts` — `buildListUrl` at `:112-116` is the *second* structural drop site (never sets `runId` on list). Correct as-is and load-bearing for the wire-level guard's independent coverage value (Q1=A).
- `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts` — write-path schemas; unrelated.
- `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_status.ts` — different tool; its `runId` handling is correct and stays.
- `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/observer-independence.test.ts` — import graph unchanged.
- `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/cockpit-gate-status-runid.test.ts` — status tool, not list.
- `agency/packages/claude-plugin-cockpit/commands/auto.md:86` — different repo, already fixed (`grep -c "would 400" = 0` per Assumption 5). Sibling scope collapsed to zero. No cross-repo PR.

## Behavior Preservation Guarantees

| Guarantee | Enforcement |
|-----------|-------------|
| Handler still drops `runId` before `client.listGates` | New client-seam test (FR-003b) + existing wire-level test (FR-003a) |
| Outbound URL never carries `runId=` or `run_id=` | Existing wire-level test at `:234-247` (renamed only, assertion unchanged) |
| Schema still accepts `runId` for MCP-surface parity with `cockpit_gate_status` | Existing tests at `:190-232` (`SC-002`, `SC-006`, typo-guard) — untouched |
| `runIdSource` log line absent on list (per #1067 Q3=C) | No test change; secondary sentence (b) preserved in the rewritten handler comment |

## Changeset

`.changeset/1080-runid-drop-rejustification.md` — `@generacy-ai/generacy` **patch** per Assumption 8. Rationale: non-test file mutation under `packages/generacy/src/` (comment prose in `cockpit_gate_list.ts` + `query-schemas.ts`). Behavior byte-identical; no public API surface change. Alternative `pnpm changeset --empty` (comment-only escape hatch per CLAUDE.md) is also defensible; `patch` is preferred because a corrected justification IS a shipped correctness note for downstream integrators reading the comment via unpkg / GitHub source view.

Only `@generacy-ai/generacy` bumps (verified no orchestrator, cluster-relay, workflow-engine, or cockpit code path is touched — the seam for the client-seam test is `vi.mock('../gates/query-client.js')`, which is test-only and consumes the existing module boundary).

## Post-plan next step

`/speckit:tasks` to generate the ordered task list.

# Implementation Plan: Cockpit Remote Gates — Shared Wire Contracts

**Feature**: Part of the Cockpit Remote Gates epic — foundational Zod schemas + gateId derivation helpers for the presenter-agnostic gate record used by orchestrator routes, MCP tools, doorbell, and generacy-cloud.
**Branch**: `1020-part-cockpit-remote-gates`
**Status**: Complete
**Spec**: [spec.md](./spec.md)
**Clarifications**: [clarifications.md](./clarifications.md)
**Epic doc**: [cockpit-remote-gates-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cockpit-remote-gates-plan.md) (§Wire contracts)

## Summary

Add a new `packages/cockpit/src/gates/` module that ships three Zod schemas and their fixtures:

1. **`GateRecordSchema`** — the presenter-agnostic gate-open payload emitted by the driving `/cockpit:auto` session.
2. **`GateAnswerSchema`** — the NDJSON line the cloud inbox (or a local operator) sends back with a chosen option or free-text.
3. **`GateOutcomeAckSchema`** — the driving-session's acknowledgement that the answer was applied, superseded, or failed.

Alongside the schemas, expose deterministic `deriveGateKey` / `deriveGateId` helpers plus one per-gate-type generation helper (batch id, head SHA, phase number, draft hash, etc.) so callers cannot improvise generation inputs. Ship all eight gate-type fixtures (one valid + one malformed each) for reuse by downstream orchestrator/doorbell/MCP tests and mirrored by generacy-cloud.

This issue is the single source of truth for the wire contract. No transport, no routes, no MCP tools land here — those are later P1 issues that all import from `@generacy-ai/cockpit`.

## Technical Context

**Language/Version**: TypeScript 5.4 (ESM), Node.js >=22
**Primary Dependencies**: `zod` ^3.23 (already a direct dep of `@generacy-ai/cockpit`); no new dependencies.
**Storage**: N/A — pure in-memory schemas + helpers.
**Testing**: `vitest` ^4 (existing package test setup; mirrors `packages/cockpit/src/__tests__/`).
**Target Platform**: Node.js library — consumed by orchestrator (Node runtime), CLI (`generacy` bin), MCP-tool bins, and the generacy-cloud mirror.
**Project Type**: single library package inside the pnpm workspace.
**Performance Goals**: schemas parse in-memory once per request; no hot loop, no perf target beyond "not noticeably slow".
**Constraints**:
- Deterministic hashing (`gateId = first 24 hex chars of sha256(gateKey)`) so restart / takeover idempotency is trivially provable.
- Zero I/O in the module — no `fs`, no `net`, no `child_process`. Callers own how they publish/read records.
- Root-export only (`import { GateRecordSchema } from '@generacy-ai/cockpit'`) — no new `./gates` subpath.
**Scale/Scope**: ~8 gate types × 3 schemas + ~8 generation helpers + fixtures. Small, self-contained.

## Constitution Check

No `.specify/memory/constitution.md` file exists in this repo. Constitutional guardrails fall back to repository conventions in `CLAUDE.md`:

- **Changeset gate** (CLAUDE.md §Changesets): touches `packages/cockpit/src/` (non-test) → PR must add a new `.changeset/1020-cockpit-gates.md` (`@generacy-ai/cockpit` — **minor**, new public wire contracts).
- **Public export path**: root export only, per Q2 clarification. Do NOT add a `./gates` entry to `packages/cockpit/package.json`'s `exports`.
- **No new deps**: `zod` already present. Node built-in `node:crypto` for sha256.
- **ESM + Node >=22**: matches existing `packages/cockpit` conventions.
- **No emojis, no speculative abstractions, no scaffolding for hypothetical future gate types**: the eight gate types in the spec are the entire surface.

**Result**: PASS — no violations; nothing goes in the Complexity Tracking table.

## Project Structure

### Documentation (this feature)

```text
specs/1020-part-cockpit-remote-gates/
├── spec.md                # authored by /specify (read-only here)
├── clarifications.md      # authored by /clarify (read-only here)
├── plan.md                # THIS FILE
├── research.md            # Phase 0 — technology + delimiter/hash choices
├── data-model.md          # Phase 1 — schemas + type surface
├── quickstart.md          # Phase 1 — how downstream packages consume the module
├── contracts/             # Phase 1 — JSON Schema exports for cross-repo mirror
│   ├── gate-record.schema.json
│   ├── gate-answer.schema.json
│   └── gate-outcome-ack.schema.json
├── checklists/            # (empty — no /checklist run needed for a schema-only issue)
└── tasks.md               # Phase 2 — produced by /tasks, NOT this command
```

### Source Code (repository root)

```text
packages/cockpit/
├── package.json           # unchanged: exports.{".":…} stays root-only (Q2=A)
├── src/
│   ├── index.ts           # ADD re-exports from ./gates/index.js (root-only surface)
│   ├── gates/             # NEW MODULE (this issue)
│   │   ├── index.ts       # aggregate re-exports for the root
│   │   ├── schemas.ts     # GateRecordSchema, GateAnswerSchema, GateOutcomeAckSchema
│   │   ├── types.ts       # z.infer<> type aliases + GateType union + KindEnum
│   │   ├── gate-id.ts     # deriveGateKey(), deriveGateId() — sha256 hex helpers
│   │   ├── generation.ts  # per-gate-type generation helpers (Q1=A colon-join)
│   │   └── fixtures.ts    # valid + malformed fixtures per gate type (exported)
│   └── __tests__/
│       ├── gates-schemas.test.ts     # round-trip + malformed rejection (all 8 types)
│       ├── gates-id.test.ts          # deriveGateId determinism + hex prefix length
│       └── gates-generation.test.ts  # per-helper generation inputs (colon-join)
└── vitest.config.ts       # unchanged
```

**Structure Decision**: Single new sub-module `packages/cockpit/src/gates/` inside the existing `@generacy-ai/cockpit` library package. Re-exported from the package root (`src/index.ts`) so downstream imports read `import { GateRecordSchema, deriveGateId } from '@generacy-ai/cockpit'`. Tests colocate under the existing `src/__tests__/` directory to match the sibling `classifier.test.ts` / `single-resolver.test.ts` pattern. No package.json changes, no new deps, no exports-map edit.

### Downstream (out of scope for this issue — recorded for later P1 tickets)

- `packages/orchestrator/src/routes/gates.ts` — will import `GateRecordSchema` + `deriveGateId`.
- `packages/generacy/src/cli/commands/cockpit/mcp/tools/` — new MCP tools will import `GateAnswerSchema`.
- `packages/doorbell/…` — will import for validation.
- `generacy-cloud` — mirrors the same wire contract; consumes the exported JSON Schema in `contracts/` (companion issue on the cloud side).

## Complexity Tracking

*No constitutional violations to justify — table intentionally empty.*

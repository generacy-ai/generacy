# Data Model: #1080

**No data-model changes.** This spec is documentation-and-test-only per FR-004 / SC-005.

## Entities (unchanged)

| Entity | Location | Change |
|--------|----------|--------|
| `CockpitGateListInputSchema` | `packages/generacy/src/cli/commands/cockpit/mcp/gates/query-schemas.ts:60-77` | **Docblock text only** on the `runId` field (`:66-74`). Zod shape unchanged: `z.string().min(1).optional()`. `.strict()` boundary unchanged. |
| `CockpitGateListInput` type | Same file, `:78` | Inferred from schema; unchanged. |
| `CockpitGateListData` type | Same file, `:97` | Unchanged. |
| `GateQueryClient` interface | `packages/generacy/src/cli/commands/cockpit/mcp/gates/query-client.ts:93-96` | Unchanged. Test mocks it via `vi.mock` on the module export. |
| `createGateQueryClient` factory | Same file, `:203-216` | Unchanged. Test intercepts via module mock. |
| `BuildMcpServerDeps` | `packages/generacy/src/cli/commands/cockpit/mcp/server.ts` (imported at handler `:31`) | Unchanged — no new DI hook added (Decision 1). |

## Validation Rules (unchanged)

- `CockpitGateListInputSchema` still `.strict()` — unknown keys (e.g. `run_id` typo) still rejected with `unrecognized_keys`.
- `runId` still `z.string().min(1).optional()`.
- Handler still drops `runId` before constructing `listInput` — the `const listInput = { issueRef, ...(gateType !== undefined ? { gateType } : {}) };` shape is preserved byte-for-byte.

## Relationships (unchanged)

- Handler `cockpitGateList` → `CockpitGateListInputSchema.safeParse` → `resolveGateOptions(deps)` → `createGateQueryClient(options)` → `client.listGates(listInput)` → `buildListUrl(baseUrl, input)` → wire.
- The `runId` field enters at parse time and dies at handler construction time (never propagates further).

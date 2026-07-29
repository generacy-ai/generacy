# Contract: `McpToolDriver` (Q2=C direct-import wrapper)

**Feature**: #1068 | **Related entity**: `E4` in [data-model.md](../data-model.md) | **Location**: `packages/orchestrator/src/__tests__/cockpit-gates/mcp-tool-driver.ts` (NEW)

Thin wrapper around the four MCP gate tool handlers. Exists per clarifications Q2=C — the harness drives the tools by **direct function import**, not by spawning `claude` and not by driving the MCP protocol. Centralizes the `BuildMcpServerDeps` plumbing and the workspace-cycle fallback shape (see D-2 in [research.md](../research.md)).

## Constructor

```ts
function createMcpToolDriver(options: McpToolDriverOptions): McpToolDriver;

interface McpToolDriverOptions {
  /** Light-orchestrator base URL, from `ScenarioContext.orchestratorUrl`. */
  baseUrl: string;
  /** Injected fetch — default `globalThis.fetch`. Overridable for testing. */
  fetchImpl?: typeof fetch;
}
```

## Interface

```ts
interface McpToolDriver {
  gateOpen(input: GateOpenInput):
    Promise<ToolResult<{ gateId: string; status: 'open' }>>;
  gateAck(input: GateAckInput):
    Promise<ToolResult<Record<string, unknown>>>;
  gateStatus(input: CockpitGateStatusInput):
    Promise<ToolResult<CockpitGateStatusData>>;
  gateList(input: CockpitGateListInput):
    Promise<ToolResult<CockpitGateListData>>;
}
```

Types imported from `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts` and `.../query-schemas.ts`. `ToolResult<T>` from `packages/generacy/src/cli/commands/cockpit/mcp/errors.ts`.

## Implementation

Each method delegates directly to the named handler with a minimal deps bundle:

```ts
import { cockpitGateOpen } from '@generacy-ai/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_open.js';
import { cockpitGateAck } from '@generacy-ai/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_ack.js';
import { cockpitGateStatus } from '@generacy-ai/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_status.js';
import { cockpitGateList } from '@generacy-ai/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_list.js';

export function createMcpToolDriver(opts: McpToolDriverOptions): McpToolDriver {
  const deps = { baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl ?? fetch };
  return {
    gateOpen: (input) => cockpitGateOpen(input, deps),
    gateAck: (input) => cockpitGateAck(input, deps),
    gateStatus: (input) => cockpitGateStatus(input, deps),
    gateList: (input) => cockpitGateList(input, deps),
  };
}
```

**On the import path**: `packages/generacy` depends on `packages/orchestrator` (`workspace:*`). A test file inside `packages/orchestrator/src/__tests__/` importing from a **source path** (not a package export) inside `packages/generacy` closes a build cycle at TypeScript's project-graph level. Two mitigations:

- **D-2-a (default)**: use vitest's per-package resolver that treats `packages/*/src/**` as workspace-linked. This is how the doorbell driver in `scenario-helpers.ts` already reaches into `packages/generacy/dist/bin/generacy.js` (via `spawn`, not import — but the point is the paths are resolvable). Vitest typically picks these up via the workspace `tsconfig` chain.
- **D-2-b (fallback)**: if D-2-a fails, replace direct import with subprocess execution. Each `gateStatus(input)` etc. becomes a small `spawn(nodeBin, ['-e', dynamicScript])` that imports the tool inside a fresh Node process and prints the JSON result. Same shape the doorbell already uses.

**Decision protocol**: implementer runs `pnpm --filter @generacy-ai/orchestrator test -- cockpit-gates-runid.integration.test.ts` at T005. If it errors on import resolution, switch to D-2-b (documented in-line in `mcp-tool-driver.ts`). The switch is local to this file; no scenario-body assertions change.

## Non-behaviours

- **No LLM.** No `claude` process, no Anthropic SDK, no prompt-loop simulation. The dedup invariant asserted by FR-004 is measured at the MCP boundary, per Q2=C.
- **No MCP protocol layer.** No stdio JSON-RPC framing. Direct function calls only.
- **No retry / caching / rate-limit wrapping.** The tools already have their own retry (`withRetry` + `QUERY_RETRY_SCHEDULE`) internally. The driver is a passthrough.
- **No result unwrapping.** Returns `ToolResult<T>` (`{ status: 'ok', data } | { status: 'error', class, detail }`). Scenarios explicitly check `result.status === 'ok'` and then read `result.data`. This forces every test to consider both branches.

## Test hooks

The driver is fully functional; there are no `vi.fn()` seams. To simulate a phase-C revert (harness does not pass `runId`), scenarios simply build the input without the field:

```ts
// Phase-C-simulated call — no runId in the input:
await ctx.mcp!.gateOpen({ issueRef, gateType, generation, ...restRequiredFields });

// Compare to the healthy call:
await ctx.mcp!.gateOpen({ issueRef, gateType, generation, runId, ...restRequiredFields });
```

That's the entire "flag". Nothing enters the shipped code path (per FR-012).

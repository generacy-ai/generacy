# Data Model: cockpit gate tools return inboxUrl

All changes are MCP-boundary **response** shapes in `packages/generacy`. Wire contracts
(gate-open record, orchestrator ack, query HTTP responses) are untouched.

## E-1: `GateClientOptions` (`mcp/gates/options.ts`)

```ts
export interface GateClientOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  appUrl: string;            // NEW — always resolved, never undefined
}
```

Resolution (in `resolveGateOptions(deps, env = process.env)`):

| Field | Precedence |
|-------|-----------|
| `appUrl` | `deps.appUrl` > `env['GENERACY_APP_URL']` > `'https://app.generacy.ai'` |

`BuildMcpServerDeps` (`mcp/server.ts`) gains `appUrl?: string`; the `Pick<...>` in
`resolveGateOptions`'s signature adds `'appUrl'`. `QueryClientOptions`
(`gates/query-client.ts`) is unchanged — the resolved bag remains structurally assignable.

## E-2: `buildInboxUrl` (`mcp/gates/inbox-url.ts`, NEW)

```ts
export function buildInboxUrl(appUrl: string, gateId: string): string;
// == `${origin}/dashboard/inbox?gate=${encodeURIComponent(gateId)}`
// implemented via new URL('/dashboard/inbox', appUrl) for trailing-slash safety
```

Pure, synchronous, no imports from the gate write path (observer-independence-safe).

## E-3: `CockpitGateOpenData` (`tools/cockpit_gate_open.ts`)

```ts
export interface CockpitGateOpenData {
  gateId: string;
  status: string;            // 'open' | 'retained'
  inboxUrl: string;          // NEW — required; present on BOTH 'open' and 'retained'
  [k: string]: unknown;      // ack passthrough (accepted, retained, retainQueue, …)
}
```

Invariant: `inboxUrl` is assigned **after** the `...envelope.data` spread — a passthrough
ack field can never override the locally-derived value.

## E-4: Status-tool output (`gates/query-schemas.ts` + `tools/cockpit_gate_status.ts`)

Wire type (unchanged, still parsed by `query-client.ts`):

```ts
type CockpitGateStatusData =
  | { gateId: string /* 24 */; status: 'open' | 'answered' }
  | { gateId: null; status: 'absent' };
```

New MCP-facing output type (tool enriches after decode):

```ts
export type CockpitGateStatusResult =
  | { gateId: string; status: 'open' | 'answered'; inboxUrl: string }   // required
  | { gateId: null; status: 'absent'; inboxUrl: null };                 // present-and-null
```

Rule: `inboxUrl` is non-null exactly when `gateId` is non-null. Settled (`answered`) gates
still carry a real link (inbox auto-expands History — clarified Q3/Q4).

## E-5: List-tool output (`gates/query-schemas.ts` + `tools/cockpit_gate_list.ts`)

Wire types (unchanged): `CockpitGateListEntry { gateId, gateType, generation, status }`,
`CockpitGateListData { gates, truncated? }`.

New MCP-facing output types:

```ts
export type CockpitGateListEntryResult = CockpitGateListEntry & { inboxUrl: string }; // required, every row
export type CockpitGateListResult = { gates: CockpitGateListEntryResult[]; truncated?: boolean };
```

Every row gets `inboxUrl` derived from its own `gateId`, regardless of `status`.

## Validation rules

- `inboxUrl` is always a well-formed absolute `https?` URL whose path is `/dashboard/inbox`
  and whose sole query param is `gate=<gateId>`.
- `gateId` placed in the query param is the tool-derived/wire-delivered 24-char hex id,
  passed through `encodeURIComponent` (no-op for hex, pinned anyway).
- No schema loosening: all new fields are required (or present-and-null on `absent`),
  matching the plugin's `GateOpenResult { inboxUrl: string }`.

## Relationships

```
resolveGateOptions ──appUrl──▶ buildInboxUrl(appUrl, gateId)
                                   ▲              ▲
             cockpit_gate_open ────┘ (derived id) │
             cockpit_gate_status ─────────────────┤ (wire ids)
             cockpit_gate_list ───────────────────┘
```

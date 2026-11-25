# Implementation Plan: cockpit_gate_open returns an inbox URL for /cockpit:auto to print

**Feature**: Gate tools return a locally-built `inboxUrl` deep-linking to the dashboard inbox
**Branch**: `1235-symptom-user-report-running`
**Status**: Complete

## Summary

`/cockpit:auto --gates=ui` operators answer gates in the generacy.ai dashboard inbox, but
`cockpit_gate_open` never returns the `inboxUrl` the playbook is written to print, and the
reuse/adopt paths (`cockpit_gate_status`, `cockpit_gate_list`) omit it entirely (the auto.md
"DATA GAP"). The fix builds the URL locally in the CLI's cockpit MCP server —
`${appUrl}/dashboard/inbox?gate=${encodeURIComponent(gateId)}` — from the `gateId` the tools
already have, with `appUrl` resolved as `deps.appUrl` > `GENERACY_APP_URL` env >
`https://app.generacy.ai`. No cloud round-trip, no change to the fire-and-forget orchestrator
ack contract. Agency playbook edits and the web nav link are out of scope (tracked separately).

## Technical Context

- **Language/runtime**: TypeScript (ESM), Node >= 22
- **Package touched**: `packages/generacy` only (`@generacy-ai/generacy`)
- **Area**: `src/cli/commands/cockpit/mcp/` — gate MCP tools, options resolver, schemas
- **Validation**: Zod (existing frozen-shape / wire-mirror pattern)
- **Tests**: Vitest; existing parity-test pattern with injected `fetchImpl` spies (no
  `global.fetch` monkey-patching, no env mutation — `resolveGateOptions` takes an `env` arg)
- **No new dependencies**

## Design

### D-1: `appUrl` resolution lives in `resolveGateOptions` (FR-002, clarified Q1)

`mcp/gates/options.ts` is the single `process.env` reader for this package's gate tools.
Extend it:

- `GateClientOptions` gains `appUrl: string`.
- `resolveGateOptions` resolves `deps.appUrl ?? env['GENERACY_APP_URL'] ?? 'https://app.generacy.ai'`.
- `BuildMcpServerDeps` (`mcp/server.ts`) gains optional `appUrl?: string` (new injection
  point, mirrors `orchestratorUrl`).
- `QueryClientOptions` (`gates/query-client.ts`) is unchanged — `GateClientOptions` stays a
  structural superset, so the read tools keep passing the resolved options bag straight to
  `createGateQueryClient`.

No registry/config-file reads, no network dependency → `inboxUrl` is always derivable, so it
can be a **required** field (clarified Q2/Q3).

### D-2: URL builder is a neutral shared primitive

New file `mcp/gates/inbox-url.ts` exporting
`buildInboxUrl(appUrl: string, gateId: string): string`, implemented with
`new URL('/dashboard/inbox', appUrl)` + `searchParams.set('gate', gateId)` so a trailing
slash on `GENERACY_APP_URL` cannot produce `//dashboard`. Output for a clean origin is
byte-identical to the FR-001 template (gateId is 24-char hex, so encoding is stable).

Placed as its own file (not in `client.ts` or a tool file) because the read tools are under
the observer-independence import-scan: they may not import `gates/client.js`, the write
tools, or any `retain*` module. `inbox-url.ts` imports nothing from the write path, so both
sides can share it — same rationale as `options.ts`.

### D-3: `cockpit_gate_open` returns required `inboxUrl` on `open` AND `retained` (FR-001/003)

`tools/cockpit_gate_open.ts` — the success return becomes:

```ts
return {
  status: 'ok',
  data: {
    ...envelope.data,
    gateId,
    status: envelope.data.retained ? 'retained' : 'open',
    inboxUrl: buildInboxUrl(options.appUrl, gateId),
  },
};
```

`inboxUrl` is spread LAST so a passthrough ack field can never clobber the locally-derived
value (the local derivation is authoritative — the orchestrator ack never echoes a URL).
`CockpitGateOpenData` gains `inboxUrl: string`. Retained opens include it per clarified Q2:
the inbox tolerates links to not-yet-hydrated gates (waits for SSE `gate:created`).

### D-4: Read tools enrich their wire payloads locally (FR-005/006, clarified Q3)

The orchestrator `GET /cockpit/gates` responses do NOT carry `inboxUrl`, so the **wire**
schemas in `gates/query-schemas.ts` (`CockpitGateStatusDataSchema`,
`CockpitGateListDataSchema` — parsed by `query-client.ts` `decodeResponse`) are unchanged.
The tools enrich after decode:

- `cockpit_gate_status`: gateId-bearing results (`open`/`answered`) get
  `inboxUrl: buildInboxUrl(options.appUrl, data.gateId)`. The `absent` branch has
  `gateId: null` — there is no gate to link — so it carries `inboxUrl: null`
  (present-and-null, mirroring its `gateId: null` convention). Settled gates still get a
  real link (the inbox auto-expands History for a `?gate=` naming an answered row).
- `cockpit_gate_list`: every row, regardless of state, gets
  `inboxUrl: buildInboxUrl(options.appUrl, entry.gateId)`.

New MCP-facing output types (`CockpitGateStatusResult`, `CockpitGateListResult` /
`...ListEntryResult`) are declared in `query-schemas.ts` next to the wire types; the tool
handlers' `ToolResult<T>` generics switch to them. The file stays import-disjoint from the
write-path `schemas.ts` content it already avoids.

### D-5: Parity/regression tests (FR-004)

- `parity-gate-open.test.ts`: assert `inboxUrl === 'https://app.generacy.ai/dashboard/inbox?gate=' + EXPECTED_ID`
  on both `open` and `retained` acks; **rewrite** the existing
  "passthrough response field forwarded (e.g. inboxUrl)" test — an echoed `inboxUrl` in the
  ack is now overridden by the local derivation (that is the point of the fix).
- `parity-gate-status.test.ts`: `inboxUrl` present on `open`/`answered`; `inboxUrl: null` on
  `absent`.
- `parity-gate-list.test.ts`: every returned row carries `inboxUrl` derived from its own
  `gateId`.
- `gates/__tests__/options.test.ts`: `appUrl` precedence chain (arg > `GENERACY_APP_URL` >
  default), using the existing injected-env seam.
- New `gates/__tests__/inbox-url.test.ts`: template shape, `encodeURIComponent` behaviour,
  trailing-slash `appUrl` normalisation.
- `observer-independence.test.ts`: no change expected — verify the scan still passes with
  both read tools importing `gates/inbox-url.js`.

## Project Structure

```
packages/generacy/src/cli/commands/cockpit/mcp/
├── server.ts                          # BuildMcpServerDeps += appUrl?
├── gates/
│   ├── options.ts                     # GateClientOptions += appUrl; resolution chain
│   ├── inbox-url.ts                   # NEW — buildInboxUrl(appUrl, gateId)
│   ├── query-schemas.ts               # NEW output types (wire schemas unchanged)
│   └── __tests__/
│       ├── options.test.ts            # appUrl precedence
│       └── inbox-url.test.ts          # NEW
├── tools/
│   ├── cockpit_gate_open.ts           # data += inboxUrl (required, open+retained)
│   ├── cockpit_gate_status.ts         # enrich: inboxUrl | null (absent)
│   └── cockpit_gate_list.ts           # enrich: inboxUrl per row
└── __tests__/
    ├── parity-gate-open.test.ts       # inboxUrl pins; passthrough test rewritten
    ├── parity-gate-status.test.ts     # inboxUrl pins
    └── parity-gate-list.test.ts       # inboxUrl pins
.changeset/1235-gate-inbox-url.md      # NEW — @generacy-ai/generacy patch
```

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo. Checked against standing
CLAUDE.md invariants instead:

- **Changeset gate**: non-test `packages/generacy/src/` files change → a newly-added
  changeset is required. `workflow:speckit-bugfix` → `patch` bump (FR-007). New types are
  not re-exported from the package's public `index.ts` → internal surface → `patch` is
  correct.
- **Observer independence** (#1038): preserved — shared code goes in a neutral module, read
  tools still never import the write path.
- **`GENERACY_APP_URL` semantics**: documented as CLI-side dashboard URL; cloud-deployed
  cluster `.env`s already carry it, so it is the natural staging override. `GENERACY_CLOUD_URL`
  stays dead.
- **Frozen wire contracts**: the gate-open wire record and orchestrator ack are untouched;
  only the MCP-facing response envelope grows.

## Artifacts

- [research.md](./research.md) — decisions + alternatives
- [data-model.md](./data-model.md) — response-shape deltas
- [contracts/inbox-url.md](./contracts/inbox-url.md) — URL construction + resolution contract
- [quickstart.md](./quickstart.md) — build/test/verify steps
- [stack.md](./stack.md) — tech stack summary

# Data Model: Cockpit MCP — Gate-Open / Gate-Ack

Feature: [#1022](https://github.com/generacy-ai/generacy/issues/1022)
Branch: `1022-part-cockpit-remote-gates`

This document defines the TypeScript types, Zod schemas, and validation rules
crossing the two new tool boundaries. **The wire contracts themselves (gate
record shape, ack payload shape, `gateId`/`generation` rules) are owned by the
epic** — see `contracts/cockpit_gate_open.md` for the pointer to the epic doc.
The shapes below are the local mirrors used for input validation and response
typing.

---

## Overview of entities

```text
┌──────────────────────┐        POST /cockpit/gates          ┌────────────────────┐
│ GateRecord           │  ────────────────────────────────▶  │ Orchestrator route │
│  (caller input)      │                                     │  (owned by epic P1) │
│                      │  ◀─── { gateId, status }  ────────  │                    │
└──────────────────────┘                                     └────────────────────┘

┌──────────────────────┐   POST /cockpit/gates/:id/ack       ┌────────────────────┐
│ GateAckInput         │  ────────────────────────────────▶  │ Orchestrator route │
│  (caller input)      │                                     │                    │
│  { gateId, outcome,  │  ◀─── { <opaque ack payload> } ───  │                    │
│    detail? }         │                                     │                    │
└──────────────────────┘                                     └────────────────────┘
```

---

## Core types

### `GateRecord`

The caller-supplied gate description POSTed to `/cockpit/gates`. **Local mirror
of the epic's contract** — see `contracts/cockpit_gate_open.md` for the exact
field list and semantics that the orchestrator validates.

```ts
/**
 * MIRROR of the epic's `GateRecord` wire contract. Update in lockstep with the
 * epic doc; local Zod validation is a fast-fail for obvious caller mistakes,
 * NOT a re-declaration of the contract.
 */
export interface GateRecord {
  // Exact field list is owned by the epic. Placeholder shape — the local Zod
  // schema uses `.passthrough()` to forward unknown fields to the orchestrator
  // without stripping them, so contract drift on the epic side never causes a
  // local schema-strip bug.
  [k: string]: unknown;
}
```

**Validation rule (local)**: `z.record(z.unknown()).and(z.object({}).passthrough())` — accept any object shape, forward as-is. The orchestrator returns 400 on shape mismatch, which this tool maps to `invalid-args` (R4).

**Rationale**: Re-declaring the epic's schema locally invites drift. The tool's job is to be a thin HTTP client; validation authority lives on the orchestrator.

### `GateAckInput`

```ts
export interface GateAckInput {
  /** Opaque id returned by a prior `cockpit_gate_open` call. */
  gateId: string;
  /** Operator's decision. Enum values owned by the epic; local schema uses
   *  z.string() and lets the orchestrator reject unknown values with 400. */
  outcome: string;
  /** Optional free-text elaboration (bounded by the orchestrator). */
  detail?: string;
}
```

**Validation rules (local)**:
- `gateId`: `z.string().min(1)` — non-empty; orchestrator issues opaque ids.
- `outcome`: `z.string().min(1)` — non-empty; orchestrator owns the enum.
- `detail`: `z.string().optional()` — orchestrator bounds length; over-long payloads produce 400 → `invalid-args`.

### `GateOpenResponse`

The 2xx response body from `POST /cockpit/gates`.

```ts
export interface GateOpenResponse {
  gateId: string;
  status: string;   // Enum owned by the epic (e.g., 'open', 'coalesced', ...)
  // Additional fields forwarded verbatim via .passthrough().
}
```

**Response validation (local)**: `z.object({ gateId: z.string(), status: z.string() }).passthrough()` — assert the two field names the tool contract promises callers, forward everything else opaquely.

### `GateAckResponse`

The 2xx response body from `POST /cockpit/gates/:id/ack`. Local shape is
**opaque** — the orchestrator may return any JSON; the tool passes it through
inside `ToolOkResult.data`.

```ts
export type GateAckResponse = Record<string, unknown>;
```

---

## MCP-boundary schemas

Exported from `mcp/schemas.ts` and consumed by the two tool handlers.

```ts
import { z } from 'zod';

/** cockpit_gate_open — accepts any object; forwards as-is to orchestrator. */
export const CockpitGateOpenInputSchema = z
  .record(z.unknown())
  .and(z.object({}).passthrough());
export type CockpitGateOpenInput = z.infer<typeof CockpitGateOpenInputSchema>;

/** cockpit_gate_ack — three fields, only shape checked locally. */
export const CockpitGateAckInputSchema = z
  .object({
    gateId: z.string().min(1),
    outcome: z.string().min(1),
    detail: z.string().optional(),
  })
  .strict();
export type CockpitGateAckInput = z.infer<typeof CockpitGateAckInputSchema>;
```

**Why `.strict()` on ack but `.passthrough()` on open**:
- `open` carries an arbitrary caller record whose fields the orchestrator owns — passthrough preserves fields we don't know about.
- `ack` has a fixed three-field contract at *this* boundary — strict mode catches typos (`gate_id` vs `gateId`) at the tool with a clear `invalid-args` error instead of forwarding a nonsense body.

---

## Tool-result types

Both tools return `ToolResult<T>` from `mcp/errors.ts`. The two `T` shapes:

```ts
/** cockpit_gate_open success data. Forwarded verbatim from orchestrator. */
export interface CockpitGateOpenData {
  gateId: string;
  status: string;
  [k: string]: unknown;   // Passthrough of any orchestrator additions.
}

/** cockpit_gate_ack success data. Opaque passthrough. */
export type CockpitGateAckData = Record<string, unknown>;
```

Error variant (`ToolErrorResult`) uses the existing shape from `mcp/errors.ts`
with `ErrorClass ∈ { 'transport', 'invalid-args', 'unknown-gate', 'internal' }`
per the R4 table.

---

## Options-bag schema

Added to `mcp/server.ts`'s `BuildMcpServerDeps` (plan D-1):

```ts
export interface BuildMcpServerDeps {
  runner?: CommandRunner;
  /** Orchestrator base URL. Precedence: arg > $ORCHESTRATOR_URL > http://127.0.0.1:3100. */
  orchestratorUrl?: string;
  /** Per-request HTTP timeout in ms. Default: 5000. */
  orchestratorTimeoutMs?: number;
  /** Test-only fetch override. Production leaves undefined (uses global fetch). */
  fetchImpl?: typeof fetch;
}
```

**Precedence resolution** lives in `gates/options.ts`:

```ts
export interface GateClientOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}

export function resolveGateOptions(
  deps: Pick<BuildMcpServerDeps, 'orchestratorUrl' | 'orchestratorTimeoutMs' | 'fetchImpl'>,
  env: NodeJS.ProcessEnv = process.env,
): GateClientOptions {
  return {
    baseUrl: deps.orchestratorUrl ?? env['ORCHESTRATOR_URL'] ?? 'http://127.0.0.1:3100',
    timeoutMs: deps.orchestratorTimeoutMs ?? 5000,
    fetchImpl: deps.fetchImpl ?? fetch,
  };
}
```

---

## Relationships / lifecycle

1. **Skill (`/cockpit:auto`) opens a gate**:
   - Calls `cockpit_gate_open(gateRecord)`.
   - On `status: 'ok'`: keeps `data.gateId` in the ledger for later ack.
   - On `class: 'transport'`: falls back to local `AskUserQuestion` gate.
   - On any other error class: propagates as today (no fallback — the caller sent a malformed record or the orchestrator hit an unexpected condition).

2. **Skill acks the gate**:
   - Calls `cockpit_gate_ack({ gateId, outcome, detail? })` once the operator resolves the inbox item on generacy.ai OR (fallback path) when `AskUserQuestion` returns.
   - On `class: 'transport'`: skill decides whether to retry (out of scope for this branch — belongs to the auto.md change in P4).
   - On `class: 'unknown-gate'`: gate id was never issued or already garbage-collected; skill logs and moves on.

3. **Orchestrator gate-store lifetime**: owned by the orchestrator route implementation. Not modeled here.

---

## Validation rules summary

| Field                          | Rule                                 | Error class on violation |
|--------------------------------|--------------------------------------|--------------------------|
| `gateRecord` (open)            | must be a JSON object                | `invalid-args` (Zod)     |
| `gateId` (ack)                 | non-empty string                     | `invalid-args` (Zod)     |
| `outcome` (ack)                | non-empty string                     | `invalid-args` (Zod)     |
| `detail` (ack)                 | optional string                      | `invalid-args` (Zod)     |
| Orchestrator response envelope | `{ gateId: string, status: string }` on open; opaque on ack | `internal` if envelope missing required fields on 2xx |

---

## Non-goals for the data model

- No local persistence of gate records or ack payloads.
- No cache or dedupe layer at the MCP boundary.
- No CLI-verb input parsing (Q3 → A — no CLI verb exists).
- No re-declaration of the epic's wire schemas beyond the passthrough shape check above.

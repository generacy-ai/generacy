# Research: cockpit gate tools return inboxUrl

## R1: Where the URL is built — locally in the CLI, not echoed by the cloud

**Decision**: Build `inboxUrl` in the CLI's cockpit MCP server from the `gateId` the tools
already hold.

**Rationale**: The orchestrator `POST /cockpit/gates` ack is fire-and-forget
(`{ accepted, retained, retainQueue? }`, `GateOpenResponseSchema` passthrough) and the cloud
never echoes a URL back — waiting for one would require changing the frozen ack contract or
adding a round-trip. `cockpit_gate_open` derives `gateId` itself
(`deriveGateKey`/`deriveGateId`, `gates/schemas.ts`), and the read tools receive `gateId` in
every gate-bearing wire payload, so all three tools can construct the link with zero network
dependency.

**Alternatives considered**:
- *Cloud echoes the URL in the ack* — rejected: breaks the fire-and-forget contract
  (explicitly out of scope) and leaves `retained` opens (relay down, nothing emitted) with
  no URL at all.
- *Orchestrator route appends the URL* — rejected: the orchestrator would need its own
  `appUrl` resolution and the retained path still bypasses the cloud; doing it at the MCP
  boundary covers every path uniformly.

## R2: appUrl resolution chain (clarified Q1)

**Decision**: `deps.appUrl` (new `BuildMcpServerDeps` injection point) > `GENERACY_APP_URL`
env > hardcoded `https://app.generacy.ai`, resolved in `resolveGateOptions`
(`mcp/gates/options.ts`).

**Rationale**: `resolveGateOptions` is already the ONLY `process.env` reader for gate-tool
configuration, with an injected-`env` test seam. The dashboard is served from
`app.generacy.ai` (`https://generacy.ai/...` 301-redirects there; generacy-cloud's
`PROD_APP_URL_DEFAULT` is the same value; the repo's extension package hardcodes
`https://app.generacy.ai/...` links). `GENERACY_APP_URL` is already written into
cloud-deployed cluster `.env`s, making it the natural staging override. The chain always
yields a value, which is what lets `inboxUrl` be a required field.

**Alternatives considered**:
- *Longest-prefix lookup in `~/.generacy/clusters.json`* — rejected (Q1 option B): its
  `cloudUrl` is an API/relay URL, not the dashboard, and the MCP server deliberately reads
  no config files.
- *Env-only, optional field when unset* — rejected (Q1 option C): local clusters never set
  the env and would get no link; optional field also loosens the plugin's required
  `GateOpenResult.inboxUrl: string`.

## R3: Required on retained opens and settled gates (clarified Q2/Q3)

**Decision**: `inboxUrl` is unconditionally present — on `retained` gate-opens and on every
`cockpit_gate_status`/`cockpit_gate_list` gate regardless of state.

**Rationale**: Verified cloud-side behaviour (clarified Q4): `GateInboxClient.tsx` reads
`searchParams.get('gate')`; a not-yet-hydrated `?gate=` waits for SSE `gate:created`
(covers retained opens flushing later), and a settled `?gate=` auto-expands History and
scrolls (covers answered/expired rows). One required field keeps the open/status/list
schemas and the plugin parity uniform. The sole exception is `cockpit_gate_status`'s
`absent` result: there is no gate, so `inboxUrl: null` mirrors the existing
`gateId: null` present-and-null convention rather than fabricating a bare-inbox link the
playbook would never print.

## R4: Shared builder placement vs observer independence

**Decision**: New neutral module `mcp/gates/inbox-url.ts` shared by the write tool and both
read tools.

**Rationale**: The observer-independence import-scan (`observer-independence.test.ts`,
#1038 FR-012) forbids the read tools from importing `gates/client.js`, either write tool,
or any `retain*` path — but neutral primitives (`options.ts`, `retry.ts`) are explicitly
the sanctioned sharing pattern ("extract a neutral primitive instead of cross-importing",
`query-client.ts` header). `inbox-url.ts` has zero write-path imports.

**Alternatives considered**:
- *Inline the template in all three tools* — workable (one line each) but splits the
  trailing-slash/encoding behaviour across three sites and three test files.
- *Export from `options.ts`* — equally safe; separate file keeps the options-bag resolver
  single-purpose.

## R5: URL construction — `new URL` over string template

**Decision**: `new URL('/dashboard/inbox', appUrl)` + `url.searchParams.set('gate', gateId)`.

**Rationale**: Normalises a trailing slash on `GENERACY_APP_URL` (an operator-supplied env
var) and matches the existing URL-building style in `query-client.ts`. For a clean origin
and a 24-hex `gateId`, output is byte-identical to the FR-001 template
`${appUrl}/dashboard/inbox?gate=${encodeURIComponent(gateId)}` — which is also exactly what
the web app's own `gate-browser-notifier.ts` builds, so the two stay in lockstep.

## R6: Wire schemas stay frozen; enrichment happens after decode

**Decision**: `CockpitGateStatusDataSchema` / `CockpitGateListDataSchema` (parsed against
the orchestrator's HTTP responses in `query-client.ts`) are unchanged; the tool handlers
enrich the decoded data with `inboxUrl` before returning, typed via new output types in
`query-schemas.ts`.

**Rationale**: The orchestrator route does not (and should not) return `inboxUrl` — adding
a required field to the wire schemas would make every real response fail `decodeResponse`.
The MCP-facing response is already a distinct layer (the status route collapses seven cloud
statuses to three at the same boundary).

## Key sources

- `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_open.ts:152-159` — ack→result mapping (insertion point)
- `packages/generacy/src/cli/commands/cockpit/mcp/gates/options.ts` — resolution seam
- `packages/generacy/src/cli/commands/cockpit/mcp/gates/query-schemas.ts` — wire vs output types
- `/workspaces/agency/packages/claude-plugin-cockpit/lib/gate-wire-types.ts:270-272` — plugin `GateOpenResult` requires `inboxUrl: string`
- generacy-cloud `GateInboxClient.tsx:167`, `gate-browser-notifier.ts:183-185` — `?gate=` deep-link support (clarified Q4)

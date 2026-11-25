# Contract: inboxUrl construction and resolution

## URL shape (FR-001, clarified Q4)

```
${appUrl}/dashboard/inbox?gate=${encodeURIComponent(gateId)}
```

- Path is exactly `/dashboard/inbox` — the route the production inbox serves
  (`GateInboxClient.tsx` reads `searchParams.get('gate')`).
- Query param key is exactly `gate`; value is the 24-char hex `gateId`.
- Must match byte-for-byte what generacy-cloud's own
  `gate-browser-notifier.ts` builds for the same gate.
- A trailing slash on `appUrl` must NOT produce `//dashboard` (normalise via
  `new URL('/dashboard/inbox', appUrl)`).

## appUrl resolution (FR-002, clarified Q1)

| Priority | Source | Notes |
|----------|--------|-------|
| 1 | `deps.appUrl` | New `BuildMcpServerDeps` injection point (tests, embedders) |
| 2 | `GENERACY_APP_URL` env | Already written to cloud-deployed cluster `.env`s; staging override |
| 3 | `https://app.generacy.ai` | Hardcoded production default (= generacy-cloud `PROD_APP_URL_DEFAULT`) |

Resolved only in `resolveGateOptions` (`mcp/gates/options.ts`) — the package's single
`process.env` reader for gate tools. No config-file, registry, or network reads. The chain
is total: `appUrl` is never undefined, so `inboxUrl` is never omitted for a real gate.

## Presence matrix (FR-003/005/006, clarified Q2/Q3)

| Tool | Result | `inboxUrl` |
|------|--------|-----------|
| `cockpit_gate_open` | `status: 'open'` | required string |
| `cockpit_gate_open` | `status: 'retained'` (relay down, queued) | required string — inbox tolerates pre-hydration links |
| `cockpit_gate_status` | `status: 'open' \| 'answered'` | required string |
| `cockpit_gate_status` | `status: 'absent'` (`gateId: null`) | `null` (present-and-null, mirrors `gateId`) |
| `cockpit_gate_list` | every row, any status | required string per row, from that row's `gateId` |

## Override rule

In `cockpit_gate_open`, the locally-built `inboxUrl` is authoritative: it is applied after
the ack passthrough spread, so an orchestrator/cloud field of the same name can never
replace it.

## Out of contract

- The orchestrator ack (`{ accepted, retained, retainQueue? }`) and all gate wire records
  are unchanged.
- The `GET /cockpit/gates` HTTP responses are unchanged; enrichment happens after
  `decodeResponse` in the tool handlers.

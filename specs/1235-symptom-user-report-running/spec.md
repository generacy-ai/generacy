# Feature Specification: cockpit_gate_open returns an inbox URL for /cockpit:auto to print

**Branch**: `1235-symptom-user-report-running` | **Date**: 2026-11-25 | **Status**: Draft

## Summary

When an operator runs `/cockpit:auto` with `--gates=ui`, approvals are answered in the
generacy.ai dashboard inbox. The `auto.md` playbook is written to print a clickable inbox link
each time a gate opens — but the `cockpit_gate_open` MCP tool never returns a URL for the agent
to print. The playbook therefore emits a placeholder, invents a URL, or drops the line
entirely, leaving `--gates=ui` operators with no way to find where to answer their gates.

The fix is to build the inbox URL locally in the CLI (the tool already derives `gateId`, and the
inbox accepts a `?gate=<gateId>` query param) and return it as `inboxUrl` from the gate tools, so
the playbook has a real value to print. This spec covers the **generacy CLI / orchestrator**
side. The agency playbook changes (`auto.md`) and the missing web nav link are tracked
separately (agency follow-up; generacy-ai/generacy-cloud#947).

## Root cause

- `auto.md` tells the agent to print, once per gate open,
  `gate open: <title> → answer in the generacy.ai inbox (<inboxUrl>)`, and documents that
  `cockpit_gate_open` success "alone carries `inboxUrl`".
- The plugin wire type `GateOpenResult` already declares `inboxUrl: string`
  (`claude-plugin-cockpit/lib/gate-wire-types.ts:263-272`).
- But `cockpit_gate_open.ts:152-158` returns `{ ...ack, gateId, status }` with **no `inboxUrl`**.
  The orchestrator `POST /cockpit/gates` ack (`cockpit-gates.ts:358-366`) is fire-and-forget and
  the cloud never echoes a URL back.
- The reuse / adopt paths (`cockpit_gate_status`, `cockpit_gate_list`) also omit `inboxUrl`,
  which `auto.md` marks as a "DATA GAP" — those paths print no pointer at all.

## User Stories

### US1: UI-mode operator gets a link to the inbox (Primary)

**As a** cockpit operator running `/cockpit:auto --gates=ui`,
**I want** each gate-open to surface a clickable link to the dashboard inbox,
**So that** I can go straight to where the gate is answered instead of guessing the URL.

**Acceptance Criteria**:
- [ ] When a gate opens, `cockpit_gate_open` returns an `inboxUrl` pointing at the dashboard
      inbox and deep-linking to the gate (`?gate=<gateId>`).
- [ ] The URL is derived locally (`deps.appUrl` > `GENERACY_APP_URL` > `https://app.generacy.ai`)
      — no extra round-trip to the cloud, and no dependence on the fire-and-forget ack echoing
      anything back.
- [ ] The returned `inboxUrl` matches what the plugin's `GateOpenResult` type expects (parity
      tests pass).

### US2: Pointer available on reuse and adopt paths

**As a** cockpit operator whose gate is reused or adopted from an existing open gate,
**I want** the same inbox pointer available,
**So that** the "DATA GAP" where no link is printed is closed for those paths too.

**Acceptance Criteria**:
- [ ] `cockpit_gate_status` returns `inboxUrl` for the gate it reports on.
- [ ] `cockpit_gate_list` rows each carry an `inboxUrl`.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `cockpit_gate_open` returns `inboxUrl` built as `${appUrl}/dashboard/inbox?gate=${encodeURIComponent(gateId)}`. | P1 | Uses the tool's already-derived `gateId`. |
| FR-002 | `appUrl` resolves as `deps.appUrl` (new injection point) > `GENERACY_APP_URL` env > hardcoded `https://app.generacy.ai`, via `resolveGateOptions` (`mcp/gates/options.ts`) — no registry/config-file reads, no network dependency. | P1 | Clarified Q1. `GENERACY_APP_URL` is already written into cloud-deployed cluster `.env`s; the default matches generacy-cloud's `PROD_APP_URL_DEFAULT`. |
| FR-003 | `inboxUrl` is added to the `GateOpenResponse` / `CockpitGateOpenData` shapes as a **required** field and validated; it is present on both `open` and `retained` results. | P1 | Clarified Q2 — always included; keep frozen-shape / wire validation green. |
| FR-004 | Parity tests between the CLI response shape and the plugin's `GateOpenResult` are updated to assert `inboxUrl`. | P1 | `gate-wire-types.ts:263-272`. |
| FR-005 | `cockpit_gate_status` returns `inboxUrl` for its reported gate, regardless of gate state (required field). | P2 | Clarified Q3; closes reuse-path DATA GAP. |
| FR-006 | `cockpit_gate_list` rows each include `inboxUrl`, regardless of gate state (required field). | P2 | Clarified Q3; closes adopt-path DATA GAP. |
| FR-007 | A changeset is added covering every touched `packages/*/src/` package. | P1 | CI gate; `workflow:speckit-bugfix` → `patch`. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Gate-open returns a usable inbox link | Every `cockpit_gate_open` success carries a well-formed `inboxUrl` deep-linking to the gate | Unit/parity tests assert presence and format |
| SC-002 | Reuse/adopt paths carry the pointer | `cockpit_gate_status` and `cockpit_gate_list` both expose `inboxUrl` | Tests on those tool responses |
| SC-003 | No playbook placeholder/invented URLs | `--gates=ui` operator sees a real, clickable inbox link per gate | Manual `/cockpit:auto --gates=ui` run (agency playbook change applied in follow-up) |

## Assumptions

- **Verified (Q4)**: the dashboard inbox route is `/dashboard/inbox` and supports the
  `?gate=<gateId>` deep-link today — `GateInboxClient.tsx:167` reads `searchParams.get('gate')`,
  and the web app's own notifier builds `/dashboard/inbox?gate=${encodeURIComponent(gateId)}`
  (`lib/notifications/gate-browser-notifier.ts:183-185`). The inbox tolerates links to
  not-yet-hydrated gates (waits for SSE `gate:created`) and to settled gates (auto-expands
  History and scrolls), so a required `inboxUrl` is safe on retained opens and settled rows.
- `appUrl` is always resolvable (Q1): the `deps.appUrl` > `GENERACY_APP_URL` >
  `https://app.generacy.ai` chain guarantees a value with no config-file or network reads.
- `gateId` as derived by the tool is the identifier the inbox expects in `?gate=`.

## Out of Scope

- Agency playbook edits to `auto.md` (one-time UI-mode line + per-gate pointer on reuse/adopt
  paths) and its pinning tests — tracked as an agency follow-up.
- Adding a nav link to `/dashboard/inbox` in the web app — tracked in
  generacy-ai/generacy-cloud#947.
- Any change to how gates are answered or to the fire-and-forget orchestrator ack contract.

---

*Generated by speckit*

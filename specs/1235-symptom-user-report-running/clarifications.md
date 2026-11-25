# Clarifications: cockpit_gate_open returns an inbox URL for /cockpit:auto to print

**Issue**: #1235 | **Branch**: `1235-symptom-user-report-running`

---

## Batch 1 — 2026-11-25

### Q1: appUrl resolution chain in the cockpit MCP server context

**Context**: FR-002 says `appUrl` comes from "the cluster cloud config (`cloud.appUrl`)", falling back to "an env var and then the services/api default". But the gate tools run inside the CLI's cockpit MCP server, whose only configuration source today is `resolveGateOptions` (`mcp/gates/options.ts`) reading `deps` / `process.env` — it does not load `LaunchConfig`, the project `.generacy/cluster.yaml`, or the machine registry (`~/.generacy/clusters.json`, which stores `cloudUrl` = `cloud.appUrl ?? cloudUrl`). Also, no production dashboard default exists in the codebase (`cloud-client.ts` defaults `appUrl` to `http://localhost:3000`, which would be wrong to ship in an inbox link). The concrete resolution chain and the final default determine both the implementation and whether `inboxUrl` can be guaranteed present.

**Question**: What should the `appUrl` resolution chain be inside the cockpit MCP server, and what is the final hardcoded default?

**Options**:
- A: `deps.appUrl` (new injection point) > `GENERACY_APP_URL` env > hardcoded `https://generacy.ai` — no registry/config file reads; `inboxUrl` always present
- B: Longest-prefix cwd lookup in `~/.generacy/clusters.json` (`cloudUrl`) > `GENERACY_APP_URL` env > hardcoded production default — ties the link to the actual cluster's dashboard
- C: `GENERACY_APP_URL` env only; when unset, omit `inboxUrl` from the response (field becomes optional)

**Answer**: *Pending*

---

### Q2: inboxUrl on retained (queued) gate opens

**Context**: `cockpit_gate_open` returns `status: 'retained'` when the relay is down and the gate-open frame was queued rather than emitted to the cloud (`cockpit_gate_open.ts:152-158`). In that state the gate is not yet visible in the dashboard inbox, so a printed link would 404 or show an empty inbox until the queue flushes. The playbook prints the link once per gate open, so this decides whether operators can see stale/premature links.

**Question**: Should `inboxUrl` be included when the gate-open result is `retained`, or only when it is `open`?

**Options**:
- A: Always include it — the link becomes valid once the retain queue flushes; simpler contract, matches the plugin's required `inboxUrl: string`
- B: Omit it on `retained` — never hand the operator a link that does not work yet; field becomes optional in the response shape

**Answer**: *Pending*

---

### Q3: inboxUrl scope on cockpit_gate_status and cockpit_gate_list

**Context**: FR-005/FR-006 add `inboxUrl` to the reuse/adopt paths. `cockpit_gate_list` can return gates in non-open states (answered, expired), where a deep-link to the inbox is at best a no-op. Whether every row carries the URL or only actionable (open/pending) gates affects the response schemas and the parity tests.

**Question**: Should `cockpit_gate_status` / `cockpit_gate_list` attach `inboxUrl` to every gate they report regardless of state, or only to gates still awaiting an answer?

**Options**:
- A: Every gate, unconditionally — uniform schema (required field), consumers decide what to print
- B: Only gates in an open/awaiting-answer state — optional field, absent on settled gates

**Answer**: *Pending*

---

### Q4: Does the dashboard inbox support `?gate=<gateId>` today?

**Context**: The spec's Assumptions section states the inbox "accepts a `?gate=<gateId>` query param to deep-link to a specific gate", but this is cloud-side behavior the CLI cannot verify, and the related web work (generacy-ai/generacy-cloud#947) is explicitly out of scope. If the param is not yet supported, shipping it is harmless (the operator still lands on the inbox) but SC-003's "deep-linking" claim would be aspirational until the cloud catches up.

**Question**: Is the `?gate=<gateId>` deep-link already supported by the production dashboard inbox, or should the CLI ship the param ahead of cloud support?

**Options**:
- A: Supported today — ship `?gate=<gateId>` as specced
- B: Not yet supported — ship the param anyway (forward-compatible; landing on the plain inbox is acceptable in the interim)
- C: Not supported and undesired — return the bare `/dashboard/inbox` URL without the query param until the cloud adds support

**Answer**: *Pending*

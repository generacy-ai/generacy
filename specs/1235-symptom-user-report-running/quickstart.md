# Quickstart: cockpit gate tools return inboxUrl

## Build & test

```bash
pnpm install
pnpm --filter @generacy-ai/generacy build
pnpm --filter @generacy-ai/generacy test -- \
  src/cli/commands/cockpit/mcp/gates/__tests__/options.test.ts \
  src/cli/commands/cockpit/mcp/gates/__tests__/inbox-url.test.ts \
  src/cli/commands/cockpit/mcp/__tests__/parity-gate-open.test.ts \
  src/cli/commands/cockpit/mcp/__tests__/parity-gate-status.test.ts \
  src/cli/commands/cockpit/mcp/__tests__/parity-gate-list.test.ts \
  src/cli/commands/cockpit/mcp/__tests__/observer-independence.test.ts
```

## Verify by hand (mock orchestrator not required for shape checks)

The tools are MCP-only (no CLI twins — #1022/#1038 design-invariant exception), so verify
through the parity-test harness pattern: call the tool function with an injected `fetchImpl`
spy and inspect the returned `data.inboxUrl`.

Expected for a gate with `gateId = abc…` (24 hex):

```
https://app.generacy.ai/dashboard/inbox?gate=<gateId>
```

Override checks:

```bash
# env override
GENERACY_APP_URL=https://staging.app.generacy.ai <run tests touching resolveGateOptions>
# deps override wins over env — covered by options.test.ts
```

## End-to-end (after agency follow-up lands)

1. Run `/cockpit:auto --gates=ui` against a live epic.
2. On each gate open the playbook prints
   `gate open: <title> → answer in the generacy.ai inbox (<inboxUrl>)`.
3. Click the link — the dashboard inbox opens with the gate row focused
   (not-yet-hydrated gates appear once SSE `gate:created` arrives; settled gates
   auto-expand History).

## Troubleshooting

- **Link points at `app.generacy.ai` but you're on staging** — set `GENERACY_APP_URL` in the
  cluster env (cloud-deployed clusters already have it).
- **`inboxUrl` missing from a tool response** — the field is required; a missing field means
  an old build. Rebuild `packages/generacy` (cross-package imports resolve to `dist/`).
- **CI red: "modifies packages/*/src/ but adds no changeset"** — this feature must ship
  `.changeset/1235-gate-inbox-url.md` (`@generacy-ai/generacy: patch`) as a newly-added file.

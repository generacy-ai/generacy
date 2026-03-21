# Quickstart: Show 'waiting for slot' indicator on queued workflows

## Prerequisites

- Node.js >= 20
- pnpm 9.15+
- Access to both repos:
  - `/workspaces/generacy` (VS Code extension)
  - `/workspaces/generacy-cloud` (web dashboard)

## Development Setup

### Start the development stack
```bash
/workspaces/tetrad-development/scripts/stack start
source /workspaces/tetrad-development/scripts/stack-env.sh
```

### VS Code Extension
```bash
cd /workspaces/generacy
pnpm install
# Press F5 in VS Code to launch Extension Development Host
```

### Web Dashboard
```bash
cd /workspaces/generacy-cloud
pnpm install
pnpm dev
```

## Testing the Feature

### Simulate slot-waiting state
1. Check org's `maxConcurrentAgents` (tier limit)
2. Start workflows until `activeExecutions >= maxConcurrentAgents`
3. Queue another workflow — it should show "waiting for slot" indicator
4. Complete a running workflow — queued workflow should update within 15s

### VS Code Extension verification
- Queue tree view: slot-waiting items show distinct icon and "waiting for slot" in description
- Detail panel: shows "X/Y execution slots in use" capacity info
- Tooltip: includes capacity breakdown on hover

### Web Dashboard verification
- Queue panel: slot-waiting badge (amber) on pending items at capacity
- Active workflows panel: same indicator
- Job detail view: capacity info section

## Key Files

### VS Code Extension
- `packages/generacy-extension/src/views/cloud/queue/tree-item.ts` — Tree item rendering
- `packages/generacy-extension/src/views/cloud/queue/provider.ts` — Data provider + polling
- `packages/generacy-extension/src/views/cloud/queue/detail-html.ts` — Detail webview
- `packages/generacy-extension/src/api/endpoints/orgs.ts` — Org API client

### Web Dashboard (generacy-cloud)
- `packages/web/src/lib/hooks/use-org-capacity.ts` — Capacity polling hook
- `packages/web/src/components/projects/detail/dashboard/QueuePanel.tsx` — Queue panel
- `packages/web/src/components/projects/detail/dashboard/ActiveWorkflowsPanel.tsx` — Workflow panel
- `packages/web/src/components/projects/detail/workflows/WorkflowJobCard.tsx` — Job cards

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Indicator not showing | Verify org has `activeExecutions >= maxConcurrentAgents` via API |
| Indicator not updating | Check 15s polling is active; verify SSE connection for job events |
| `maxConcurrentAgents` undefined | Ensure org object includes this field; check tier config in billing package |
| Enterprise tier always shows indicator | Enterprise uses `-1` for unlimited — ensure `isAtCapacity` returns `false` for `-1` |

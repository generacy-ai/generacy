# Quickstart: Display Execution Slot and Cluster Usage in Cloud Dashboard

## Prerequisites

- Node.js 18+
- pnpm installed
- VS Code extension development environment set up

## Setup

```bash
# Install dependencies
pnpm install

# Start development
pnpm dev
```

For backend (Firebase emulators):
```bash
/workspaces/tetrad-development/scripts/stack start
source /workspaces/tetrad-development/scripts/stack-env.sh
```

## Testing the Changes

### Manual Testing

1. Start the dev server and open the extension in VS Code
2. Open the cloud dashboard (Command Palette → "Generacy: Open Dashboard")
3. Verify the Usage Metrics section shows:
   - **Execution Slots** progress bar (renamed from "Concurrent Agents")
   - **Cluster Connections** progress bar (new)
   - **Agent Hours** progress bar (unchanged)

### Testing Threshold States

The progress bars should change color at these thresholds:
- **Normal** (green): < 75% usage
- **Warning** (yellow): 75–90% usage
- **Critical** (red): > 90% usage

### Testing Overage State

When `activeExecutions > tier limit` (e.g., during a downgrade):
- Bar shows at 100% with critical (red) color
- Text shows: "X of Y slots active — Z completing from prior plan"

### Testing Upgrade Prompts

When at 100% capacity:
- Execution slots: "All execution slots in use. Upgrade your plan for more concurrent workflows."
- Clusters: "Cluster limit reached. Upgrade to connect additional clusters."
- Both should include an upgrade button (not shown for Enterprise tier)

## Files Changed

| File | What Changed |
|------|-------------|
| `packages/generacy-extension/src/api/types.ts` | Added `activeExecutions`, `connectedClusters` to OrgUsage |
| `packages/generacy-extension/src/api/endpoints/orgs.ts` | Added `maxClusters`, renamed `concurrentAgents` → `executionSlots` in getTierLimits() |
| `packages/generacy-extension/src/views/cloud/dashboard/webview.ts` | Renamed labels, added cluster bar, overage states, upgrade prompts |

## Troubleshooting

**Progress bars show 0% for clusters**: The `connectedClusters` field hasn't been added to the backend yet (generacy-cloud#235). The frontend falls back to 0 until the backend lands.

**Execution slots show same value as before**: The `activeExecutions` field falls back to `currentConcurrentAgents` until generacy-cloud#234 lands. This is expected — they represent the same metric.

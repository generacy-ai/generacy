# Implementation Plan: Display Execution Slot and Cluster Usage in Cloud Dashboard

**Feature**: Update the cloud dashboard to display execution slot usage (renamed from concurrent agents) and cluster connection counts with progress bars, warning thresholds, overage states, and upgrade prompts.
**Branch**: `400-context-part-billing`
**Status**: Complete

## Summary

This feature updates the VS Code extension's cloud dashboard with three changes:
1. **Rename** "Concurrent Agents" → "Execution Slots" throughout the dashboard
2. **Add** a new "Cluster Connections" progress bar to the Usage Metrics section
3. **Add** context-specific upgrade prompts when at execution slot or cluster capacity

The final Usage Metrics layout will show three progress bars:
1. Execution Slots (renamed from Concurrent Agents)
2. Cluster Connections (new)
3. Agent Hours (existing, unchanged)

## Technical Context

- **Language**: TypeScript
- **Framework**: VS Code Extension API (webview panels)
- **UI**: Raw HTML/CSS generated in TypeScript functions (no React/framework)
- **Validation**: Zod schemas for API response validation
- **Data source**: `OrgDashboardData` fetched via REST API, auto-refreshed every 60s
- **Key dependency**: Backend issues generacy-cloud#234 (`activeExecutions`) and generacy-cloud#235 (`connectedClusters`) are in parallel — frontend stubs needed until they land

## Project Structure

All changes are within the extension package:

```
packages/generacy-extension/src/
├── api/
│   ├── types.ts                          # OrgUsage interface + Zod schema
│   └── endpoints/orgs.ts                 # getTierLimits(), OrgDashboardData
└── views/cloud/dashboard/
    └── webview.ts                        # getDashboardHtml(), getUsageSection(), getOverviewSection()
```

## Implementation Approach

### Phase 1: Type & Data Layer Updates

**File: `api/types.ts`**
- Add `activeExecutions` (optional, fallback to `currentConcurrentAgents`) to `OrgUsage`
- Add `connectedClusters` (optional, default 0) to `OrgUsage`
- Update `OrgUsageSchema` to accept the new optional fields

**File: `api/endpoints/orgs.ts`**
- Add `maxClusters` to `getTierLimits()` return type and switch cases:
  - Starter: 1
  - Team: 3
  - Enterprise: -1 (unlimited)
- Rename `concurrentAgents` → `executionSlots` in `getTierLimits()` return type

### Phase 2: Dashboard UI Updates

**File: `views/cloud/dashboard/webview.ts`**

**`getOverviewSection()`**:
- Rename "Concurrent Agents" label → "Execution Slots"
- Add "Clusters" stat item showing connected/max clusters

**`getUsageSection()`**:
- Rename "Concurrent Agents" progress bar → "Execution Slots"
- Add threshold classes (warning/critical) to execution slots bar (currently missing — only agent hours has them)
- Add overage state: when `activeExecutions > limit`, show "X of Y slots active — Z completing from prior plan"
- Add new "Cluster Connections" progress bar with same threshold logic
- Add overage state for clusters (same pattern)
- Add capacity-specific upgrade prompts inline:
  - At execution slot capacity: "All execution slots in use. Upgrade your plan for more concurrent workflows."
  - At cluster limit: "Cluster limit reached. Upgrade to connect additional clusters."
  - Both link to upgrade flow

**Progress bar threshold logic** (reuse existing pattern):
- < 75%: `normal` (green)
- 75–90%: `warning` (yellow)
- \> 90%: `critical` (red)

**Overage display** (new):
- When `active > limit`: show bar at 100% with `critical` class
- Show text: "X of Y slots active — Z completing from prior plan"
- Overage count = `Math.max(0, active - limit)`

### Phase 3: Rename Cleanup

- Update `Organization.maxConcurrentAgents` references in overview section to use new terminology
- Ensure the existing general upgrade CTA in `getQuickActionsSection()` remains as-is (it's a general upsell, not capacity-specific)

## Key Technical Decisions

1. **Optional fields with fallback**: `activeExecutions` and `connectedClusters` are optional on `OrgUsage` — the webview falls back to `currentConcurrentAgents` / `0` respectively. This avoids blocking on backend.
2. **Rename in getTierLimits()**: Change `concurrentAgents` → `executionSlots` in the return type. This is a breaking rename but all call sites are within the extension.
3. **Inline upgrade prompts**: Capacity-specific upgrade prompts are shown directly below the relevant progress bar (not in the sidebar CTA). The existing sidebar CTA remains for general upselling.
4. **Overage calculation is frontend-only**: `Math.max(0, active - limit)` — no backend field needed.
5. **No new CSS classes needed**: Reuse existing `.usage-item`, `.progress-bar`, `.progress-fill`, `.usage-warning` classes. Add a new `.usage-upgrade-prompt` class for capacity prompts.

## Risk & Mitigation

| Risk | Mitigation |
|------|------------|
| Backend fields not available yet | Optional fields with fallback to existing data |
| Enterprise tier has unlimited (-1) limits | Existing `formatLimit()` handles -1; skip percentage calculation for unlimited |
| Rename breaks other consumers of `getTierLimits()` | Only 2 call sites, both in dashboard webview — grep to confirm |

## Files to Modify (4 files)

| File | Changes |
|------|---------|
| `packages/generacy-extension/src/api/types.ts` | Add `activeExecutions`, `connectedClusters` to `OrgUsage` |
| `packages/generacy-extension/src/api/endpoints/orgs.ts` | Add `maxClusters`, rename `concurrentAgents` → `executionSlots` in `getTierLimits()` |
| `packages/generacy-extension/src/views/cloud/dashboard/webview.ts` | Rename labels, add cluster bar, add overage state, add upgrade prompts |
| `specs/400-context-part-billing/plan.md` | This file |

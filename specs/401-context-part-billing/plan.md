# Implementation Plan: Show 'waiting for slot' indicator on queued workflows

**Feature**: Display slot-waiting state on queued workflows when org is at execution capacity
**Branch**: `401-context-part-billing`
**Status**: Complete

## Summary

Add a visual indicator across all workflow views (VS Code extension + cloud web dashboard) that distinguishes between normally-queued workflows and those waiting because the org has no available execution slots. The frontend computes this state locally by comparing `currentConcurrentAgents >= maxConcurrentAgents` from the org API — no backend changes required.

## Technical Context

- **Language**: TypeScript
- **VS Code Extension**: Node.js, VS Code Extension API (TreeView, Webview)
- **Web Dashboard**: React, Tailwind CSS, custom hooks with SSE
- **Real-time**: SSE for job events, REST polling (15s) for org capacity
- **Package manager**: pnpm

## Key Decisions (from clarifications)

| # | Decision | Rationale |
|---|----------|-----------|
| Q1 | Frontend-computed slot state (Option B) | Org capacity is global state, not per-workflow — avoid backend changes |
| Q2 | Poll org usage every 15s (Option A) | Dashboard already polls at this interval; capacity changes are infrequent |
| Q3 | Keep `pending` status, layer visual indicator (Option B) | `waiting` status is for human-input gates, different semantics |
| Q4 | All views including cloud web dashboard (Option C) | Consistent UX across all surfaces |
| Q5 | Capacity info in tooltip/detail only (Option C) | Don't clutter list view; show "3/3 slots in use" on hover/click |

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Org Usage API                      │
│         GET /orgs/{orgId} or /orgs/{orgId}/usage     │
│    Returns: { maxConcurrentAgents, activeExecutions } │
└──────────────────────┬──────────────────────────────┘
                       │ Poll every 15s
           ┌───────────┴───────────┐
           ▼                       ▼
┌──────────────────┐    ┌──────────────────────┐
│  VS Code Extension│    │  Cloud Web Dashboard  │
│                  │    │                      │
│  OrgCapacity     │    │  useOrgCapacity()    │
│  provider/cache  │    │  hook with polling   │
│       │          │    │       │              │
│  ┌────┴─────┐    │    │  ┌────┴──────────┐   │
│  │TreeItem  │    │    │  │QueuePanel     │   │
│  │DetailHTML│    │    │  │WorkflowCards  │   │
│  └──────────┘    │    │  │ActivityFeed   │   │
└──────────────────┘    └──────────────────────┘

Logic: if (status === 'pending' && activeExecutions >= maxConcurrentAgents)
         → show "Queued — waiting for execution slot"
       else
         → show normal "Queued" / "Pending"
```

## Project Structure

### VS Code Extension (`/workspaces/generacy/packages/generacy-extension/`)

| File | Change | Description |
|------|--------|-------------|
| `src/api/endpoints/orgs.ts` | Modify | Add/verify `getOrgUsage()` method returning capacity data |
| `src/views/cloud/queue/provider.ts` | Modify | Add org capacity polling (15s), pass capacity to tree items |
| `src/views/cloud/queue/tree-item.ts` | Modify | Add slot-waiting icon, description, and tooltip with capacity info |
| `src/views/cloud/queue/detail-html.ts` | Modify | Show "X/Y execution slots in use" in detail view for slot-waiting items |
| `src/views/cloud/queue/__tests__/tree-item.test.ts` | Modify | Add tests for slot-waiting display |
| `src/views/cloud/queue/__tests__/provider.test.ts` | Modify | Add tests for capacity polling and tree item enrichment |

### Cloud Web Dashboard (`/workspaces/generacy-cloud/packages/web/src/`)

| File | Change | Description |
|------|--------|-------------|
| `lib/hooks/use-org-capacity.ts` | Create | Hook to poll org capacity at 15s interval |
| `components/projects/detail/dashboard/QueuePanel.tsx` | Modify | Add slot-waiting indicator to pending queue items |
| `components/projects/detail/dashboard/ActiveWorkflowsPanel.tsx` | Modify | Add slot-waiting badge to pending workflows |
| `components/projects/detail/workflows/WorkflowJobCard.tsx` | Modify | Add slot-waiting indicator to job cards with pending status |
| `components/projects/detail/workflows/WorkflowJobDetail.tsx` | Modify | Show capacity info ("X/Y slots in use") in detail view |

## Implementation Phases

### Phase 1: Org Capacity Data Layer
1. **Extension**: Ensure `orgs.ts` API client can fetch org capacity (`maxConcurrentAgents` + active execution count)
2. **Web**: Create `useOrgCapacity()` hook that polls `GET /orgs/{orgId}` every 15s and exposes `{ isAtCapacity, activeExecutions, maxConcurrentAgents }`

### Phase 2: VS Code Extension Views
3. **QueueTreeProvider**: Fetch org capacity alongside queue data, pass to tree items
4. **QueueTreeItem**: When item is `pending` and org at capacity:
   - Icon: `clock` with orange/amber color (distinct from normal pending yellow)
   - Description: prepend "waiting for slot"
   - Tooltip: add "Execution Slots: X/Y in use" section
5. **Detail HTML**: Add capacity info section when item is slot-waiting

### Phase 3: Cloud Web Dashboard Views
6. **QueuePanel**: Add "waiting for slot" text + distinct styling to pending items when at capacity
7. **ActiveWorkflowsPanel**: Same indicator on pending workflow entries
8. **WorkflowJobCard**: Slot-waiting badge alongside status badge
9. **WorkflowJobDetail**: Capacity breakdown in detail view

### Phase 4: Testing
10. Unit tests for capacity computation logic
11. Tree item rendering tests with slot-waiting state
12. Hook tests for polling behavior

## Visual Design

### List View (VS Code Extension)
```
Normal pending:    🕐 my-workflow   my-repo • queued 2m ago
Slot-waiting:      ⏳ my-workflow   my-repo • waiting for slot • queued 2m ago
```
- Slot-waiting uses a distinct icon (hourglass/timer vs clock)
- Muted amber/orange color vs bright yellow for normal pending

### List View (Web Dashboard)
```
Normal pending:    [Pending]  my-workflow    repo    2m ago
Slot-waiting:      [Waiting for slot]  my-workflow    repo    2m ago
```
- Slot-waiting badge uses amber/orange styling (amber-100/amber-800)
- Distinct from normal pending (yellow-100/yellow-800)

### Detail/Tooltip View (Both)
```
Status: Queued — waiting for execution slot
Execution Slots: 3/3 in use
```

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Polling adds API load | 15s interval is already used by dashboard; org endpoint is lightweight |
| Brief incorrect state between poll intervals | SSE job events trigger immediate refresh; 15s lag is acceptable |
| Race condition: capacity changes between poll and render | Purely cosmetic — worst case, indicator is briefly stale |
| `maxConcurrentAgents` not available on org object | Fall back gracefully — don't show indicator if capacity data unavailable |

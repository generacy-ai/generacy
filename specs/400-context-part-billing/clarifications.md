# Clarifications: Display Execution Slot and Cluster Usage in Cloud Dashboard

## Batch 1 — 2026-03-21

### Q1: Execution Slots vs Concurrent Agents
**Context**: The dashboard already displays "Concurrent Agents" usage with a progress bar showing `currentConcurrentAgents / maxConcurrentAgents`. The spec introduces "execution slots" as a separate concept. If these are the same thing under a new name, we'd rename the existing component. If different, we'd add new progress bars alongside the existing ones — significantly changing the implementation approach.
**Question**: Are "execution slots" the same concept as "concurrent agents" (a rename), or are they a separate metric? If separate, how do they relate to each other?

**Answer**: Same concept, renamed. "Execution slots" is the new user-facing term for "concurrent agents." They represent the same underlying metric — how many workflows can run simultaneously. Rename the existing component and data fields to use "execution slots" terminology. Don't add a separate metric.

### Q2: Data Source for activeExecutions and connectedClusters
**Context**: The spec assumes `activeExecutions` and `connectedClusters` fields already exist on the organization document (FR-008), but the current `OrgUsage` type only has `currentConcurrentAgents`, `agentHoursUsed`, and `agentHoursLimit`. The current `OrgDashboardData` API response does not include these fields. If the backend hasn't added them yet, the frontend work is blocked or needs stubs.
**Question**: Have `activeExecutions` and `connectedClusters` fields been added to the backend organization/usage API response? If not, should this issue include adding them to the API types with placeholder/mock data, or is there a separate backend issue that must land first?

**Answer**: `activeExecutions` is being added as part of the lease system (generacy-cloud#234). It will be maintained on the org document as a Firestore counter, updated transactionally on lease grant/release. `connectedClusters` is being added as part of cluster connection tracking (generacy-cloud#235). Both fields will be available on the org document. For this frontend issue, if the backend fields aren't available yet, add them to the API types with stubs that fall back to the existing `currentConcurrentAgents` value. The backend issues are in parallel — don't block on them.

### Q3: Tier Limits for Execution Slots and Clusters
**Context**: The current `getTierLimits()` function defines limits per tier for `concurrentAgents` (3/10/unlimited) and `agentHoursPerMonth` (100/500/unlimited). The spec requires showing "X of Y" for execution slots and clusters, which means we need Y (the limit) for each tier. Without defined limits, we can't implement the progress bars.
**Question**: What are the execution slot and cluster connection limits per tier (Starter/Team/Enterprise)? Or should we reuse the existing `concurrentAgents` limit as the execution slot limit?
**Options**:
- A: Reuse existing `concurrentAgents` limits (3/10/unlimited) for execution slots, and define new cluster limits
- B: Define entirely new limits for both execution slots and cluster connections (please specify values)

**Answer**: A — Reuse existing `concurrentAgents` limits for execution slots (they're the same thing, just renamed). Cluster limits per tier:
- Starter: 1 cluster
- Team: 3 clusters
- Enterprise: unlimited (-1)

Add `maxClusters` to `getTierLimits()` alongside the existing limits.

### Q4: Overage Count Determination
**Context**: The overage state (US3) shows "5 of 3 slots active — 2 completing from prior plan", requiring the frontend to know how many active executions are "completing from prior plan" vs the current plan allowance. This distinction requires either a dedicated API field (e.g., `overageExecutions` or `priorPlanExecutions`) or a calculation rule.
**Question**: How does the frontend determine the overage count? Is there an API field that distinguishes prior-plan executions from current-plan executions, or should the frontend simply calculate `active - limit` and display that as the overage number?

**Answer**: Frontend should calculate `active - limit`. No separate API field for prior-plan executions. If `activeExecutions` is 5 and the tier limit is 3, show "5 of 3 slots active — 2 completing from prior plan." The overage count is simply `Math.max(0, active - limit)`. The backend doesn't track which executions are "prior plan" — they're just leases that haven't been released yet. Keep it simple.

### Q5: Placement Relative to Existing Usage Metrics
**Context**: The dashboard's "Usage Metrics" section currently shows two progress bars: "Concurrent Agents" and "Agent Hours". Adding execution slots and cluster connections could mean 4 progress bars total, or the new bars could replace existing ones. This affects layout and may require section reorganization.
**Question**: Should the execution slot and cluster usage bars be added alongside the existing "Concurrent Agents" and "Agent Hours" bars (resulting in 4 bars), or should they replace the existing bars?
**Options**:
- A: Add alongside (4 bars in Usage Metrics section)
- B: Replace "Concurrent Agents" with "Execution Slots" and add "Clusters" (3 bars total)
- C: Replace both existing bars with the two new ones (2 bars)

**Answer**: B — Replace "Concurrent Agents" with "Execution Slots" and add "Clusters" (3 bars total). "Concurrent Agents" and "Execution Slots" are the same thing (per Q1), so it's a rename not an addition. Keep "Agent Hours" as-is. Final layout:
1. Execution Slots (renamed from Concurrent Agents)
2. Cluster Connections (new)
3. Agent Hours (existing)

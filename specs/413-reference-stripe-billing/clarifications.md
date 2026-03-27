# Clarifications: Notification Bell UI

## Batch 1 — 2026-03-27

### Q1: Implementation Repository
**Context**: The issue comment states "Moved to generacy-ai/generacy-cloud#332 — frontend lives in generacy-cloud." However, the billing plan (6.5) assigns the notification bell UI to the `generacy` repo. The current dashboard in this repo is a VS Code extension webview, not a web app.
**Question**: Should this notification bell UI be implemented in this repo (generacy, as a VS Code webview component) or in generacy-cloud (as a web app component)? If generacy-cloud, should this spec be closed in favor of generacy-cloud#332?
**Options**:
- A: Implement in this repo (generacy) as part of the VS Code extension dashboard webview
- B: Close this issue — implementation belongs in generacy-cloud#332

**Answer**: *Pending*

### Q2: Polling Interval
**Context**: FR-002 lists the polling interval as "TBD". The interval directly affects server load and notification freshness. The billing plan mentions SSE as an alternative but the spec defers real-time to a stretch goal.
**Question**: What polling interval should the MVP use for fetching notifications?
**Options**:
- A: 30 seconds
- B: 60 seconds
- C: 2 minutes
- D: Other (specify)

**Answer**: *Pending*

### Q3: Dropdown Notification Limit
**Context**: The spec says "recent notifications" but does not define how many to show. The billing plan mentions auto-cleanup after 90 days, meaning a user could accumulate many notifications. Without a cap, the dropdown could become unwieldy.
**Question**: What is the maximum number of notifications to display in the dropdown panel? Should older items be paginated or simply hidden behind the "View all" link?
**Options**:
- A: Show latest 10, rest behind "View all"
- B: Show latest 20, rest behind "View all"
- C: Show all unread (no cap)

**Answer**: *Pending*

### Q4: Additional Notification Types
**Context**: The spec lists 6 notification types, but the billing plan defines additional types including `trial_expired`, `seats_changed`, `execution_limit_reached`, `cluster_limit_reached`, and `seat_limit_reached`. Some of these have different display behaviors (banners, modals, inline prompts) per the billing plan.
**Question**: Should the UI only handle the 6 types listed in the spec, or should it be designed to render any notification type from the billing plan (using a fallback style for unknown types)?
**Options**:
- A: Only the 6 listed types — other types will be added in follow-up issues
- B: Handle all billing plan types now with appropriate styling
- C: Handle the 6 listed types with explicit styling, plus a generic fallback for unknown types

**Answer**: *Pending*

### Q5: Optimistic Update Error Handling
**Context**: SC-003 requires "immediate optimistic update" when marking notifications as read. If the API call fails after the UI has already updated, the notification state will be inconsistent.
**Question**: What should happen if the mark-as-read API call fails?
**Options**:
- A: Revert the UI (re-mark as unread) and show an error toast
- B: Keep the optimistic update and silently retry
- C: Keep the optimistic update and show a non-blocking warning

**Answer**: *Pending*

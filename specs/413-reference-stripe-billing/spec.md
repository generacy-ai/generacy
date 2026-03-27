# Feature Specification: Notification Bell UI

**Branch**: `413-reference-stripe-billing` | **Date**: 2026-03-27 | **Status**: Draft

> **Reference**: [Stripe Billing Implementation Plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/stripe-billing-implementation-plan.md)

## Summary

Add an in-app notification system UI to the dashboard header. Users will see a bell icon with an unread badge, a dropdown panel listing recent billing/subscription notifications, and the ability to mark notifications as read individually or in bulk.

## Components

### 1. Notification bell icon (in dashboard header, next to user avatar)
- Badge showing unread count (hide if 0)

### 2. Dropdown panel (on click)
- List of recent notifications (newest first)
- Each item: icon (by type), title, message, timestamp, unread indicator
- Click notification → navigate to `actionUrl` + mark as read
- "Mark all as read" link at top
- "View all" link at bottom (for future full notifications page)

### 3. Empty state
- "No notifications" message

## Data Source

- `GET /me/notifications` — fetch notifications list (poll or SSE for real-time)
- `POST /me/notifications/:id/read` — mark single notification as read
- `POST /me/notifications/read-all` — mark all notifications as read

## Notification Types and Icons/Colors

| Type | Style |
|------|-------|
| trial_ending_soon | info/blue |
| payment_failed | warning/amber |
| subscription_activated | success/green |
| plan_changed | info/blue |
| subscription_cancelled | warning/amber |
| subscription_expired | error/red |

## Dependencies

- Phase 6.3 of Stripe Billing Implementation Plan (backend notification endpoints)

## User Stories

### US1: View unread notification count

**As a** dashboard user,
**I want** to see a badge on the bell icon showing my unread notification count,
**So that** I know at a glance whether I have pending billing or subscription alerts.

**Acceptance Criteria**:
- [ ] Bell icon is visible in the dashboard header next to the user avatar
- [ ] Badge displays unread count when > 0
- [ ] Badge is hidden when unread count is 0
- [ ] Count updates when new notifications arrive or are marked as read

### US2: Browse and act on notifications

**As a** dashboard user,
**I want** to open a dropdown panel listing my recent notifications,
**So that** I can quickly review and respond to billing events.

**Acceptance Criteria**:
- [ ] Clicking the bell opens a dropdown panel
- [ ] Notifications are sorted newest first
- [ ] Each notification shows type icon, title, message, relative timestamp, and unread indicator
- [ ] Clicking a notification navigates to its `actionUrl` and marks it as read
- [ ] "Mark all as read" clears all unread indicators and resets the badge

### US3: Empty state

**As a** dashboard user with no notifications,
**I want** to see a clear empty state message,
**So that** I know the system is working and I simply have no alerts.

**Acceptance Criteria**:
- [ ] When there are no notifications, the dropdown shows "No notifications"
- [ ] The bell icon has no badge when there are no notifications

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Render bell icon with unread badge in dashboard header | P1 | Next to user avatar |
| FR-002 | Fetch notifications from `GET /me/notifications` on mount and periodically | P1 | Polling interval TBD; SSE stretch goal |
| FR-003 | Display dropdown panel with notification list on bell click | P1 | |
| FR-004 | Render each notification with type-specific icon/color, title, message, timestamp | P1 | See type table above |
| FR-005 | Navigate to `actionUrl` on notification click | P1 | |
| FR-006 | Mark individual notification as read via `POST /me/notifications/:id/read` | P1 | On click |
| FR-007 | Mark all as read via `POST /me/notifications/read-all` | P1 | |
| FR-008 | Show empty state when no notifications exist | P2 | |
| FR-009 | Close dropdown when clicking outside | P2 | Standard popover behavior |
| FR-010 | "View all" link placeholder for future full notifications page | P3 | Link target TBD |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Notification bell renders in header | 100% of dashboard views | Visual inspection / E2E test |
| SC-002 | Unread badge accuracy | Matches backend count | Compare badge vs API response |
| SC-003 | Mark-as-read updates UI | Immediate optimistic update | Badge count decrements without page reload |
| SC-004 | Notification type styling | All 6 types render correct icon/color | Manual + snapshot test |

## Assumptions

- Backend notification endpoints (`GET /me/notifications`, `POST /me/notifications/:id/read`, `POST /me/notifications/read-all`) will be available (Phase 6.3)
- Notifications follow a consistent schema: `{ id, type, title, message, timestamp, actionUrl, read }`
- Polling is acceptable for MVP; real-time (SSE/WebSocket) can be added later
- Dashboard header component already has space/slots for additional icons

## Out of Scope

- Full notifications page (only "View all" link placeholder)
- Push notifications (browser/mobile)
- Notification preferences/settings UI
- Real-time delivery via SSE or WebSocket (stretch goal)
- Backend notification endpoint implementation (covered by Phase 6.3)

---

*Generated by speckit*

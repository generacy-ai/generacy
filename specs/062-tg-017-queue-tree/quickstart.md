# Quickstart: Queue Tree View

## Installation

The Queue Tree View is part of the Generacy VS Code extension. No additional installation is required.

## Usage

### Accessing the Queue View

1. Open the Generacy sidebar in VS Code
2. Click on the "Queue" section in the cloud panel
3. Sign in if not already authenticated

### View Modes

Switch between view modes using the view toolbar or commands:

| Mode | Command | Description |
|------|---------|-------------|
| Flat | `generacy.queue.viewFlat` | All items in one list |
| By Status | `generacy.queue.viewByStatus` | Grouped by status |
| By Repository | `generacy.queue.viewByRepository` | Grouped by repo |
| By Assignee | `generacy.queue.viewByAssignee` | Grouped by user |

### Filtering

**Filter by status:**
1. Run command `generacy.queue.filterByStatus`
2. Select a status from the dropdown
3. View updates to show only matching items

**Clear filters:**
- Run command `generacy.queue.clearFilters`

### Manual Refresh

Click the refresh icon in the view toolbar or run `generacy.queue.refresh`.

## Status Icons

| Icon | Status | Meaning |
|------|--------|---------|
| 🕐 (clock) | Pending | Waiting to start |
| 🔄 (spinning) | Running | Currently executing |
| ✓ (check) | Completed | Finished successfully |
| ✗ (error) | Failed | Finished with error |
| ⊘ (slash) | Cancelled | Manually stopped |

## Context Menu Actions

Right-click on queue items to access:

- **Cancel** (pending/running items)
- **Retry** (failed items)
- **Change Priority** (pending items)
- **View Details**

## Troubleshooting

### Queue not loading

1. Check that you're signed in (status bar shows account)
2. Verify network connectivity
3. Try manual refresh

### Items not updating

1. Check if view is visible (polling pauses when hidden)
2. Verify polling interval in settings
3. Check console for API errors

### "Failed to load queue" error

1. Click the error item to retry
2. Check console (Output > Generacy) for details
3. Verify API endpoint configuration

## Configuration

Settings available in VS Code settings:

```json
{
  "generacy.queue.pollingInterval": 30000,
  "generacy.queue.pageSize": 50
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `pollingInterval` | 30000 | Refresh interval in ms |
| `pageSize` | 50 | Items per API request |

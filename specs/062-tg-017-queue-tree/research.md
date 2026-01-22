# Research: Queue Tree View

## Technology Decisions

### Tree Data Provider Pattern

**Decision**: Use VS Code's native `TreeDataProvider` interface

**Rationale**:
- Standard VS Code extension pattern with full platform support
- Built-in accessibility and keyboard navigation
- Supports lazy loading via `getChildren`
- Enables context menus via `contextValue`

**Alternatives Considered**:
- WebView: More flexible but heavier, loses native look/feel
- Custom Quick Pick: Too transient for monitoring use case

### Real-time Updates Strategy

**Decision**: Polling with configurable interval (default 30s)

**Rationale**:
- Simple implementation with predictable behavior
- Works reliably across network conditions
- Easy to adjust frequency based on user preference
- Change detection minimizes unnecessary UI updates

**Alternatives Considered**:
- WebSocket: Lower latency but adds complexity, requires server support
- Server-Sent Events: Good middle ground but limited browser/proxy support
- Long polling: Complex error handling, not significantly better than regular polling

### View Mode Architecture

**Decision**: Single provider with switchable view modes

**Rationale**:
- Simpler state management
- Faster mode switching (no tree recreation)
- Consistent filtering across modes
- Lower memory footprint

**Alternatives Considered**:
- Multiple providers: Would allow parallel views but increases complexity
- Virtual tree: Overkill for expected queue sizes (<1000 items)

## Implementation Patterns

### Status Icon System

Using VS Code's ThemeIcon with ThemeColor for consistent styling:

```typescript
const STATUS_ICONS = {
  pending: { icon: 'clock', color: 'charts.yellow' },
  running: { icon: 'sync~spin', color: 'charts.blue' },
  completed: { icon: 'check', color: 'charts.green' },
  failed: { icon: 'error', color: 'charts.red' },
  cancelled: { icon: 'circle-slash', color: 'charts.gray' },
};
```

The `sync~spin` icon includes built-in animation for running state.

### Change Detection Algorithm

Comparing queue items by key fields to avoid unnecessary tree refreshes:

```typescript
function hasQueueChanged(newItems, oldItems) {
  if (newItems.length !== oldItems.length) return true;

  for (const newItem of newItems) {
    const oldItem = oldItems.find(i => i.id === newItem.id);
    if (!oldItem) return true;
    if (oldItem.status !== newItem.status ||
        oldItem.priority !== newItem.priority ||
        oldItem.startedAt !== newItem.startedAt ||
        oldItem.completedAt !== newItem.completedAt) {
      return true;
    }
  }
  return false;
}
```

### Authentication Integration

Listening to auth state changes for automatic polling control:

```typescript
authService.onDidChange((event) => {
  if (event.newState.isAuthenticated) {
    this.startPolling();
  } else {
    this.stopPolling();
    this.clearData();
  }
});
```

## API Contract

### GET /queue

Request parameters:
- `status`: Single status or comma-separated list
- `repository`: Owner/repo format
- `assigneeId`: User ID string
- `page`: 1-indexed page number
- `pageSize`: Items per page (default 50)

Response schema validated with Zod:
```typescript
QueueListResponseSchema = z.object({
  items: z.array(QueueItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
```

## Performance Considerations

1. **Polling Pause**: Automatically pause when view is not visible
2. **Page Size**: Default 50 items balances responsiveness vs. network
3. **Change Detection**: Only fire `onDidChangeTreeData` when data changes
4. **Grouped Iteration**: Status groups sorted by priority (running > pending > failed)

## References

- [VS Code TreeView API](https://code.visualstudio.com/api/extension-guides/tree-view)
- [VS Code ThemeIcon](https://code.visualstudio.com/api/references/vscode-api#ThemeIcon)
- [VS Code Product Icon Reference](https://code.visualstudio.com/api/references/icons-in-labels)

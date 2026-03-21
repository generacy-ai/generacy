# Research: Show 'waiting for slot' indicator on queued workflows

## Technology Decisions

### 1. Frontend-Computed vs Backend-Driven State

**Decision**: Frontend-computed (Option B from clarifications)

**Rationale**: Slot-waiting is a **display concern**, not a workflow state transition. The condition is global (`org.activeExecutions >= org.maxConcurrentAgents`), meaning every pending workflow is slot-waiting simultaneously. Having the backend stamp each individual queue item would be redundant — the frontend can derive this from a single org-level check.

**Alternatives Considered**:
- Backend flag on each QueueItem (`slotBlocked: boolean`) — rejected: adds unnecessary API surface and backend complexity for what is a transient, globally-derived state
- New `slot_waiting` status — rejected: conflates display concern with workflow lifecycle state, complicates status filtering

### 2. Polling vs SSE for Capacity Updates

**Decision**: Poll org endpoint every 15 seconds

**Rationale**: Capacity changes are infrequent (only when a workflow starts or finishes). The dashboard already polls at this interval. Adding a new SSE event type (`org:capacity_changed`) would require backend changes and is overengineered.

**Natural real-time boost**: SSE `job:completed` and `job:created` events already trigger queue list refreshes, which naturally re-evaluate capacity state. The 15s poll is a fallback, not the primary update mechanism.

### 3. Visual Indicator Design

**Decision**: Distinct color + icon + label, with capacity details in tooltip/detail only

**Rationale**:
- **Color**: Amber/orange distinguishes from normal pending (yellow) and human-waiting (orange/bell). Using a slightly different shade ensures visual distinction.
- **Icon**: Hourglass or timer icon (VS Code: `$(watch)` or similar) vs clock for normal pending
- **Label**: "waiting for slot" is concise and actionable — users understand the bottleneck
- **Capacity in tooltip**: "3/3 execution slots in use" provides context without cluttering the list

### 4. Reusing vs Extending the `waiting` Status

**Decision**: Keep `pending` status, add visual layer

**Rationale**: The `waiting` status with `waitingFor` is used for human-input gates (clarification, approval). Slot-waiting is a system capacity constraint requiring no user action. Conflating these would:
- Break existing filtering (users filter by `waiting` to find items needing action)
- Confuse the mental model (slot-waiting resolves automatically, human-waiting requires action)

## Implementation Patterns

### Capacity Hook Pattern (Web Dashboard)

```typescript
function useOrgCapacity(orgId: string) {
  const [capacity, setCapacity] = useState<OrgCapacity | null>(null);

  useEffect(() => {
    const fetchCapacity = async () => {
      const org = await api.getOrg(orgId);
      setCapacity({
        activeExecutions: org.activeExecutions ?? 0,
        maxConcurrentAgents: org.maxConcurrentAgents,
        isAtCapacity: (org.activeExecutions ?? 0) >= org.maxConcurrentAgents,
      });
    };

    fetchCapacity();
    const interval = setInterval(fetchCapacity, 15_000);
    return () => clearInterval(interval);
  }, [orgId]);

  return capacity;
}
```

### Slot-Waiting Derivation

```typescript
function isSlotWaiting(item: QueueItem, capacity: OrgCapacity): boolean {
  return item.status === 'pending' && capacity.isAtCapacity;
}
```

### VS Code Extension Pattern

The provider already polls every 30s. Add org capacity fetch alongside:

```typescript
// In QueueTreeProvider.refresh()
const [queueItems, orgCapacity] = await Promise.all([
  this.api.getQueue(this.filters),
  this.api.getOrgCapacity(),
]);
this.orgCapacity = orgCapacity;
// Tree items receive capacity context via constructor
```

## Key Sources

- Clarifications document: `specs/401-context-part-billing/clarifications.md`
- VS Code Extension queue views: `packages/generacy-extension/src/views/cloud/queue/`
- Web dashboard components: `generacy-cloud/packages/web/src/components/projects/detail/`
- Org API types: `packages/generacy-extension/src/api/endpoints/orgs.ts`
- Billing tier config: `generacy-cloud/packages/billing/src/products.ts`

# Contract: MCP tool surface — new + modified

## New tool: `cockpit_scope_add`

**Purpose**: Append a task-list ref to a scope issue's body (concurrency-safe).

### Input schema

```typescript
{
  scope: EpicRefInput;   // string 'owner/repo#N' | { owner, repo, number }
  issue: IssueRefInput;  // string 'owner/repo#N' | { owner, repo, number }
}
```

Both refs are normalized via `normalizeIssueRef({ expects: 'issue' })`.

### Output shape

```typescript
{ status: 'ok', data: {
    scope: { owner, repo, number },
    ref:   { owner, repo, number },
    shape: 'phased' | 'flat',
    alreadyPresent: boolean,
    attempts: number,      // 1..5
}}
```

### Error classes

| `class`         | Cause | Detail example |
|-----------------|-------|----------------|
| `invalid-args`  | Zod parse failure | "scope: Required" |
| `contended`     | 5-attempt budget exhausted | `SCOPE_ADD_CONTENDED after 5 attempts` |
| `scope-not-found` | `getIssue(scope)` returned 404 | includes scope ref |

### MCP behavior

- No confirmation prompt (agent-driven).
- Idempotent: repeat calls with the same `{ scope, ref }` return `alreadyPresent: true` after the first mutation.
- Best-effort: transient `gh` failures on write step surface as tool errors (not swallowed).

## New tool: `cockpit_scope_remove`

Same shape as `cockpit_scope_add`; inverts the mutation.

### Output shape

```typescript
{ status: 'ok', data: {
    scope: { owner, repo, number },
    ref:   { owner, repo, number },
    alreadyAbsent: boolean,
    attempts: number,
}}
```

### Error classes

Same as `cockpit_scope_add`. `contended` still uses code `SCOPE_ADD_CONTENDED` (single code name covers both mutations per spec Q5).

## Modified tool: `cockpit_queue`

**Change**: input schema becomes a discriminated union accepting either the existing phase form or a new single-issue form.

### Input schema

```typescript
CockpitQueueInputSchema = union([
  { epic: EpicRefInput, phase: string },   // existing — unchanged
  { issue: IssueRefInput },                 // NEW
]);
```

### Output shape — phase form

Unchanged: `{ epic, phase, queued[], skipped[] }`.

### Output shape — issue form

```typescript
{ status: 'ok', data: {
    issue:         { owner, repo, number },
    outcome:       'queued' | 'skipped',
    reason?:       'closed' | 'already-labeled' | 'not-found',
    workflowLabel: string,
    assignee:      string,
    url:           string,
}}
```

### Behaviour parity

- Same `classifyRow` classifier.
- Same `resolveCockpitIdentity` for assignee resolution.
- Same `addAssignees` + `addLabel` mutation pair.
- Same auto-confirm behaviour (`yes: true`, no prompt).

## `cockpit_await_events` — no schema change

Same input/output. Beneficial effects only:
- Refs added mid-subscription via `cockpit_scope_add` now generate a first-sight event on the next poll.
- Refs in flat-list scope bodies now flow through the same event pipeline.
- Different scope refs = different event buses (isolation invariant).

## `cockpit_status` — no schema change, richer output

Output shape (`unknown` per current implementation) now includes:
- `adhocRefs[]` group (as a distinct section) in phased-body responses when any exist.
- `mode: 'flat'` render (no phase grouping) for flat-list bodies.

Existing consumers that iterate `phases[]` remain functional; they simply see an empty phase array for flat bodies and can fall back to `allRefs`.

## Registration order

In `packages/generacy/src/cli/commands/cockpit/mcp/server.ts`, new tools registered in this order after `cockpit_queue`:

```typescript
server.registerTool('cockpit_scope_add', { … }, handler);
server.registerTool('cockpit_scope_remove', { … }, handler);
```

Descriptions (single sentence each, matching in-repo convention):
- `cockpit_scope_add`: "Append a task-list ref to a scope (epic or tracking) issue's body. Concurrency-safe with bounded retry."
- `cockpit_scope_remove`: "Remove a task-list ref line from a scope issue's body. Concurrency-safe with bounded retry."

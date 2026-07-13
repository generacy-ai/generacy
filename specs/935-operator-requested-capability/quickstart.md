# Quickstart: #935 — operator scenarios

This quickstart walks through the two operator scenarios the engine now supports.

## Scenario A: Ad-hoc issue mid-epic

Setup: you have a running `cockpit watch` (or auto session) subscribed to `generacy-ai/generacy#900` (an epic).

Add a new bug you found in out-of-band testing to the monitored set:

```bash
generacy cockpit scope add generacy-ai/generacy#900 generacy-ai/generacy#987
# → scope add: generacy-ai/generacy#987 → generacy-ai/generacy#900 (shape=phased, attempts=1, alreadyPresent=false)
```

On the next poll cycle (default ≤10 s), the watch loop emits:

```json
{"type":"issue-transition","kind":"issue","repo":"generacy-ai/generacy","number":987,
 "from":null,"to":"active","initial":true,"labels":[…],"url":"…"}
```

Your auto loop dispatches on `initial: true` (same handler that processes the connect-time snapshot events per S8), then continues to receive normal state transitions for #987 without the `initial` flag.

If you added the wrong ref (typo):

```bash
generacy cockpit scope remove generacy-ai/generacy#900 generacy-ai/generacy#987
# → scope remove: generacy-ai/generacy#987 ✕ generacy-ai/generacy#900 (attempts=1, alreadyAbsent=false)
```

The ref is dropped from the monitored set silently on the next poll (no event emitted for the removal).

## Scenario B: Epic-less stabilization run

Create (or reuse) a tracking issue with a plain task list — no `### Phase N:` headings:

```markdown
Bugs filed during Sprint 42 stabilization:

- [ ] generacy-ai/generacy#1001
- [ ] generacy-ai/generacy#1002
```

Point `cockpit_await_events` at it (via MCP or CLI):

```bash
generacy cockpit watch generacy-ai/generacy#1000
# → flat body detected, monitoring 2 refs
```

Cockpit auto-detects flat-list mode. Monitor set = exactly those two refs.

Add issues discovered mid-run:

```bash
generacy cockpit scope add generacy-ai/generacy#1000 generacy-ai/generacy#1003
```

Each newly-added ref surfaces as an `initial: true` event next poll.

Two-tab isolation: a colleague running

```bash
generacy cockpit watch generacy-ai/generacy#1042  # their own tracking issue
```

sees only their own issues — the registry is keyed per `expandedRef`, so buses don't cross-deliver.

## Scenario C: Queue a single issue without an epic

The single-issue queue form drives one bare ref through `process:<workflow>` without needing phase membership:

```bash
generacy cockpit queue --issue generacy-ai/generacy#987
# → Preview:
#     - generacy-ai/generacy#987 [eligible]
#   Assignee:  <cluster-login>
#   Label:     process:speckit-feature
# Proceed? (y/n) y
# → queued 1, skipped 0
```

Same eligibility rules and mutations as the phase form:

- `closed` → skipped
- `already-labeled` (process:*) → skipped
- `not-found` → skipped
- eligible → assign to cluster identity, apply `--label` (default `process:speckit-feature`)

## MCP surface

Same behaviors are available via the MCP tools for agent-driven flows:

- `cockpit_scope_add({ scope, issue })`
- `cockpit_scope_remove({ scope, issue })`
- `cockpit_queue({ issue })` — new form; `{ epic, phase }` form still works

Both scope tools return `{ shape, alreadyPresent | alreadyAbsent, attempts }` in the success envelope. Contended writes (5-attempt budget exhausted) return `{ status: 'error', class: 'contended', detail: 'SCOPE_ADD_CONTENDED …' }`.

## Troubleshooting

### `SCOPE_ADD_CONTENDED`

Five bounded retries exhausted. Usually indicates >5 concurrent writers on the same scope issue.

**Remedy**: retry the whole call once. The `applyScopeMutation` writer is idempotent — if another writer's mutation already included your ref, the retry returns `alreadyPresent: true`. If the same issue is being hammered by 10+ writers, consider serialising via a dedicated auto tab.

### No `initial: true` event after `scope add`

- Confirm the mutation succeeded (`attempts >= 1, alreadyPresent: false` in the output).
- Confirm you're waiting at least one poll interval (default ~5-10 s in production).
- Confirm the ref you added is *actionable* — refs on issues that are already `terminal` (closed, no workflow label) don't emit events (matches `computeInitialSweep` semantics — non-actionable snapshots stay silent).

### `cockpit status` shows an empty phase list for a scope you expected to be phased

The body may lack the `### Phase N:` heading grammar. Currently flat-mode rendering is auto-selected when no `###` heading exists. Add a phase heading if this scope is meant to be phased.

### `cockpit_queue` (phase form) errors "no phase headings"

Your scope body is flat — use `cockpit queue --issue <ref>` for individual refs, or convert the body to phased structure with `### Phase 1:` headings.

## Migration notes

- **Existing consumers of `resolveEpic`**: `NO_PHASE_HEADINGS` no longer thrown at runtime. If you pattern-matched on this code, the pattern will simply never fire. `NO_REFS` still fires for empty bodies.
- **Existing consumers of `parseEpicBody`**: `ParsedEpicBody` gains an `adhocRefs: IssueRef[]` field. `allRefs` includes both phased and adhoc refs. Existing code iterating `phases[]` continues to work but will miss adhoc refs — update to consume `allRefs` if inclusive.
- **MCP `cockpit_queue` callers**: existing `{ epic, phase }` calls unchanged. New `{ issue }` form additive.

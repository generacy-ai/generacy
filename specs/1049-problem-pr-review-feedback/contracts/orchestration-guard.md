# Contract: Orchestration Guard Predicate

**Location**: `packages/orchestrator/src/worker/pr-linker.ts` — `PrLinker.linkPrToIssue` step 3.

**Function signature** (private / inlined):
```ts
function isOrchestrated(labels: Array<{ name: string }>): boolean;
```

**Prefix set**: `ORCHESTRATION_PREFIXES = ['agent:', 'workflow:', 'completed:'] as const`.

## Contract

The predicate returns `true` iff at least one label on the issue has a name whose leading substring equals one of the values in `ORCHESTRATION_PREFIXES`.

### Positive cases (must return `true`)

| Label set | Reason |
|---|---|
| `[{ name: 'agent:in-progress' }]` | Active workflow — legacy compat |
| `[{ name: 'agent:paused' }]` | Manually paused — legacy compat |
| `[{ name: 'workflow:speckit-feature' }]` | Dispatched but no phase started |
| `[{ name: 'workflow:speckit-bugfix' }]` | Dispatched bugfix |
| `[{ name: 'workflow:custom-workflow' }]` | Workflow-agnostic (FR-006) |
| `[{ name: 'completed:specify' }]` | Any completed marker |
| `[{ name: 'completed:validate' }]` | The reproducer case — post-terminal-phase |
| `[{ name: 'completed:validate' }, { name: 'workflow:speckit-feature' }]` | Post-requeue shape |
| `[{ name: 'workflow:x' }, { name: 'phase:specify' }]` | `phase:*` present but workflow evidence also present |

### Negative cases (must return `false`)

| Label set | Reason |
|---|---|
| `[]` | No evidence |
| `[{ name: 'bug' }]` | Human-authored issue, no speckit involvement |
| `[{ name: 'enhancement' }, { name: 'good first issue' }]` | Unrelated labels |
| `[{ name: 'phase:specify' }]` | `phase:*` alone — Q4=B exclusion |
| `[{ name: 'phase:implement' }, { name: 'phase:validate' }]` | Multiple `phase:*` but nothing else |
| `[{ name: 'blocked:stuck-feedback-loop' }]` | `blocked:*` is not evidence of orchestration |
| `[{ name: 'agent-based-labeling' }]` | Substring match must be prefix-only — `agent-` != `agent:` |
| `[{ name: 'workflows' }]` | No colon — must be `workflow:` |

### Boundary behaviour

- Prefix match is **exact string prefix** including the trailing colon. `String.prototype.startsWith('agent:')` — not `.includes('agent')`.
- Case-sensitive. `Agent:in-progress` does not match. (Consistent with existing GitHub label normalization — labels are stored lower-case in the engine's conventions.)
- No trimming — leading whitespace fails.
- Empty label-name is impossible (GitHub rejects empty labels at API level); the predicate does not defensively handle it.

## Invariants preserved

- **I1**: Any issue that has entered `label-monitor-service.ts:397-403` (dispatch) at least once and has not been fully unlabeled by an external actor is orchestrated by this predicate — because `workflow:<name>` was added and is never removed.
- **I2**: Any issue that has ever passed a phase is orchestrated — `completed:<phase>` is present.
- **I3**: `cockpit_advance` cannot cause the predicate to flip from `true` to `false` — advance only adds `completed:*` (`advance.ts:168`); it never removes `workflow:*` or `completed:*`.
- **I4**: A human-authored issue with no speckit labels is not orchestrated — none of the three prefixes match.
- **I5**: An issue with only `phase:*` labels is not orchestrated — Q4=B exclusion. This case is empirically unreachable in normal engine operation (per D2), but the predicate encodes the exclusion regardless.

## Non-goals

- The predicate does not check assignees. That is a separate gate one level up (in `PrFeedbackMonitorService`).
- The predicate does not check `blocked:*`. That is a separate gate applied AFTER link resolution and thread filtering.
- The predicate does not consult GitHub API — it operates on the labels already fetched by the enclosing `getIssue` call.

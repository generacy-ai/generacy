# Data Model: Dependency-Blocked Implement Pause

## 1. Sentinel payload

Emitted by the implement agent as a single stdout line:

```
SPECKIT_IMPLEMENT_BLOCKED: {"on": ["generacy-ai/generacy#1198", "#1199"]}
```

Schema (validated leniently — malformed JSON is warn+ignore per FR-011):

```ts
interface ImplementBlockedPayload {
  on: string[];   // 1+ dependency refs; see ref grammar below
}
```

Rules:
- Prefix is exact: `SPECKIT_IMPLEMENT_BLOCKED: ` (trailing space included), mirroring `SENTINEL_PREFIX` handling in `output-capture.ts`.
- Last sentinel wins if emitted multiple times (FR-010).
- The sentinel line is still captured in phase output as text.
- `on` missing, non-array, or empty after ref validation ⇒ treated as malformed: warn, no blocked branch, normal flow continues.

## 2. `ImplementPartialResult` extension

`packages/orchestrator/src/worker/types.ts:178`:

```ts
export interface ImplementPartialResult {
  partial?: boolean;
  tasks_completed?: number;
  tasks_remaining?: number;
  tasks_total?: number;
  blocked_on?: string[];   // NEW — raw refs from SPECKIT_IMPLEMENT_BLOCKED
}
```

Both sentinels may populate the same object (Q2=A). Control-flow precedence: the blocked branch in the phase loop runs before the increment re-loop check, so `blocked_on` presence wins regardless of `partial`.

## 3. Ref grammar

```
ref := owner "/" repo "#" number     (canonical)
     | "#" number                    (same-repo shorthand)
     | number                        (same-repo shorthand)
```

Parser: pure function in `worker/dependency-block.ts`:

```ts
interface DependencyRef {
  owner: string;
  repo: string;
  number: number;
}

function parseDependencyRefs(
  raw: string[],
  defaultOwner: string,
  defaultRepo: string,
): { valid: DependencyRef[]; invalid: string[] }
```

- Shorthand forms resolve against the blocked issue's own repo (spec Assumption 6).
- `number` must be a positive integer.
- Invalid entries are dropped with a warn; the block proceeds if ≥1 valid ref remains, otherwise falls through to normal flow.
- Marker comments always store the **canonical** normalized form.

## 4. Marker comments (GitHub = source of truth)

All machine-read comments follow the codebase's HTML-marker convention (newest marker wins).

### 4.1 Dependency-block comment (`<!-- generacy-dependency-block -->`)

Posted by the blocked branch, one per block cycle. Shape:

```markdown
<!-- generacy-dependency-block -->
**Implementation paused — waiting on dependencies**

This issue's implement phase is blocked until the following are closed:

```json
{"on": ["generacy-ai/generacy#1198", "generacy-ai/generacy#1199"]}
```

The engine will resume automatically when all references above are closed.
```

- The fenced JSON block is the machine contract; refs are canonical `owner/repo#N`.
- The monitor reads the **newest** block comment only.
- The count of block comments newer than the newest limit comment is the cycle counter (see §6).

### 4.2 Dependency-limit comment (`<!-- generacy-dependency-limit -->`)

Posted when the cycle cap (N=3) is reached, alongside `waiting-for:dependency-limit`:

```markdown
<!-- generacy-dependency-limit -->
**Dependency-block limit reached (3 cycles)**

Still open:
- generacy-ai/generacy#1198

Add `completed:dependency-limit` to this issue (or `cockpit advance --gate dependency-limit`) to grant another round of block cycles.
```

- Doubles as the cycle-counter reset baseline: after this comment, only newer block comments count.
- Deduped by marker: skip posting if a limit comment newer than the newest block comment exists.

### 4.3 Re-arm comment (posted by the monitor on resume)

```markdown
**Dependencies resolved — resuming implementation**

- generacy-ai/generacy#1198 — closed (completed)
- generacy-ai/generacy#1199 — ⚠ closed as **not planned** — verify this dependency was actually delivered
```

- Not-planned issue closes and unmerged PR closes carry the ⚠ flag (Q3=C).
- Informational only; no marker needed (nothing machine-reads it).

### 4.4 Ref-read escalation comment (`<!-- generacy-dependency-block-error -->`)

Posted after 3 consecutive read failures on a ref (Q5=B):

```markdown
<!-- generacy-dependency-block-error -->
**Cannot verify dependency state**

`generacy-ai/private-repo#7` has failed 3 consecutive reads (last error: HTTP 404).
The gate is still held and retries continue. If this ref is wrong or inaccessible,
advance the gate manually: `cockpit advance --gate dependencies`.
```

- Deduped per block cycle: skip if an error comment newer than the newest block comment exists.

## 5. `IssueRefState` (workflow-engine)

`packages/workflow-engine/src/types/github.ts`:

```ts
export interface IssueRefState {
  state: 'open' | 'closed';
  stateReason: 'completed' | 'not_planned' | 'reopened' | null; // issues only
  isPullRequest: boolean;
  merged: boolean | null;   // PRs only; null for issues
}
```

Produced by new `GitHubClient.getIssueRefState(owner, repo, number)`:
- Primary: `gh api repos/{o}/{r}/issues/{n}` — works for issues **and** PRs; `pull_request` field presence ⇒ `isPullRequest: true`.
- Follow-up when PR: `gh api repos/{o}/{r}/pulls/{n}` for `merged`.
- Any non-zero exit throws (the monitor's failure counter consumes the throw).

Re-arm predicate (Q3=C): every ref has `state === 'closed'`. Flag predicate: `stateReason === 'not_planned'` OR (`isPullRequest && merged === false`).

## 6. Cycle counter (derived, durable)

No stored counter. Definition:

```
cycleCount(issue) = count of generacy-dependency-block comments
                    with created_at > newest generacy-dependency-limit comment
                    (all block comments if no limit comment exists)
```

- Computed by the blocked branch from `getIssueComments` before posting a new block comment.
- Cap check: `cycleCount >= 3` (i.e., this would be the 4th pause since the last grant) ⇒ escalate to `dependency-limit` gate instead.
- Operator grant (`completed:dependency-limit` → resume) leads to the next cap breach posting a fresh limit comment, which resets the baseline — budget renews naturally.

## 7. Labels

| Label | Color | New? | Purpose |
|---|---|---|---|
| `waiting-for:dependencies` | FBCA04 | exists (`label-definitions.ts:44`) | Gate applied by blocked branch |
| `completed:dependencies` | 0E8A16 | NEW | Re-arm answer (monitor-applied or cockpit advance) |
| `waiting-for:dependency-limit` | FBCA04 | NEW | Cap escalation gate (operator-only) |
| `completed:dependency-limit` | 0E8A16 | NEW | Operator grant of another cycle budget |

Wiring:
- `GATE_MAPPING` (`phase-resolver.ts`) += `'dependencies'` and `'dependency-limit'`, both `{ phase: 'implement', resumeFrom: 'implement' }` → auto-membership in `HUMAN_GATE_SUFFIXES` (label-monitor resume detection + #1154 completed-label preservation).
- `DEFAULT_RESUME_RETAIN_SUFFIXES` (`label-manager.ts:107`) += `'dependency-limit'`.
- Cockpit `WAITING_PIPELINE_ORDER` (`precedence.ts`) += `waiting-for:dependency-limit` (beside `remediation-limit`) and `waiting-for:dependencies`.
- Cockpit gate-vocabulary derivation picks up `dependencies`/`dependency-limit` as advance-able automatically once the `completed:*` labels exist in `WORKFLOW_LABELS` — no cockpit-CLI code change.

## 8. Monitor state (`DependencyMonitorService`)

```ts
// In-memory only — acceptable per D-8 (loss delays escalation ≤ 3 poll cycles;
// comment-marker dedupe prevents spam across restarts)
private refFailures = new Map<string, number>();  // key: `${owner}/${repo}#${number}`
```

Poll cycle per gated issue:
1. `listIssuesWithLabel('waiting-for:dependencies')` per configured repo.
2. Read newest `generacy-dependency-block` comment → parse fenced JSON refs.
3. For each ref: `getIssueRefState`; success resets failure counter; throw increments it (at 3 → escalation comment, gate held).
4. All closed ⇒ re-arm: post re-arm comment (with flags) → apply `completed:dependencies` → `enqueueIfAbsent({ command: 'continue', queueReason: 'resume' })`.
5. Any open or undeterminable ⇒ hold.

No Redis keys, no disk files. GitHub comments + labels are the only persisted state (FR/Q1 durability contract).

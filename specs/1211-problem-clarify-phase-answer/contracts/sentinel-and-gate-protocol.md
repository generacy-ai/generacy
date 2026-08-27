# Contract: Blocked Sentinel + Gate Protocol

## 1. Sentinel line (agent → engine)

Single stdout line emitted by the implement agent:

```
SPECKIT_IMPLEMENT_BLOCKED: {"on": ["generacy-ai/generacy#1198", "#1199"]}
```

- Prefix is exact and includes the trailing space: `SPECKIT_IMPLEMENT_BLOCKED: ` — mirrors `SENTINEL_PREFIX` for `SPECKIT_IMPLEMENT_PARTIAL` in `output-capture.ts`.
- Payload is JSON: `{ on: string[] }` with ≥1 entry.
- Last sentinel wins if emitted multiple times (FR-010).
- Malformed JSON, missing/non-array `on`, or zero valid refs after grammar validation ⇒ warn + ignore; normal flow continues (FR-011).
- The sentinel line is still captured as ordinary phase output text.
- May coexist with `SPECKIT_IMPLEMENT_PARTIAL` in the same increment (Q2=A): partial counts are recorded, blocked drives control flow.

### Ref grammar

```
ref := owner "/" repo "#" number     (canonical)
     | "#" number                    (same-repo shorthand)
     | number                        (same-repo shorthand)
```

Shorthand resolves against the blocked issue's own repo. `number` must be a positive integer. Invalid entries dropped with a warn; ≥1 valid ref required for the block to proceed. Persisted forms (marker comments) are always canonical.

## 2. Label vocabulary

| Label | Color | Applied by | Cleared by |
|---|---|---|---|
| `waiting-for:dependencies` | FBCA04 | blocked branch (`onGateHit`) | worker `onResumeStart` |
| `completed:dependencies` | 0E8A16 | monitor on re-arm (or `cockpit advance --gate dependencies`) | defensive clear in blocked branch on next block |
| `waiting-for:dependency-limit` | FBCA04 | blocked branch at cycle cap | worker `onResumeStart` |
| `completed:dependency-limit` | 0E8A16 | operator (or `cockpit advance --gate dependency-limit`) | resume-retained (`DEFAULT_RESUME_RETAIN_SUFFIXES`), consumed by next cap-baseline reset |
| `agent:paused` | — | `onGateHit` (existing behavior) | worker `onResumeStart` |

## 3. Gate wiring

- `GATE_MAPPING` (`packages/orchestrator/src/worker/phase-resolver.ts`) gains:
  - `'dependencies': { phase: 'implement', resumeFrom: 'implement' }`
  - `'dependency-limit': { phase: 'implement', resumeFrom: 'implement' }`
- Both suffixes thereby join `HUMAN_GATE_SUFFIXES` automatically → label-monitor resume detection works, and the #1154 `onResumeStart` completed-label preservation applies.
- `DEFAULT_RESUME_RETAIN_SUFFIXES` (`label-manager.ts`) gains `'dependency-limit'` so a resume does not strip the operator's grant.
- Cockpit `WAITING_PIPELINE_ORDER` gains `waiting-for:dependency-limit` (beside `remediation-limit`) and `waiting-for:dependencies`; the cockpit gate-vocabulary derivation makes both gates advance-able once the `completed:*` labels exist in `WORKFLOW_LABELS`.

## 4. Blocked-branch sequence (phase loop)

Runs when implement completes with `implementResult.blocked_on` present, **before** the increment re-loop check and the no-progress guard:

1. Parse/validate refs (`parseDependencyRefs`); zero valid ⇒ treat as malformed, fall through to normal flow.
2. WIP commit/push via `prManager.commitPushAndEnsurePr`; honor `pushRefused` abort (#1051).
3. Cycle-cap check (count block markers newer than newest limit marker); at ≥3 → post limit comment + `onGateHit('implement', 'waiting-for:dependency-limit')` → return gate-hit.
4. Post block marker comment with canonical refs.
5. Defensively remove any lingering `completed:dependencies`.
6. `onGateHit('implement', 'waiting-for:dependencies')`.
7. `return { completed: false, gateHit: true }`.

## 5. Re-arm sequence (monitor)

Per poll cycle, per issue carrying `waiting-for:dependencies`:

1. Read newest block marker comment → parse fenced JSON refs.
2. `getIssueRefState` per ref; throw increments the per-ref failure counter (at 3: error comment, gate held); success resets it.
3. All refs `state === 'closed'` ⇒ re-arm:
   a. Post re-arm comment (⚠ flags per Q3=C predicate).
   b. Apply `completed:dependencies` while gate labels are still present.
   c. `queueManager.enqueueIfAbsent({ command: 'continue', queueReason: 'resume' })` — primary resume path; label-monitor detection is a redundant backstop.
4. Any ref open or undeterminable ⇒ hold.

## 6. `getIssueRefState` (new GitHubClient method)

```ts
getIssueRefState(owner: string, repo: string, number: number): Promise<IssueRefState>

interface IssueRefState {
  state: 'open' | 'closed';
  stateReason: 'completed' | 'not_planned' | 'reopened' | null;
  isPullRequest: boolean;
  merged: boolean | null;
}
```

- Primary: `gh api repos/{owner}/{repo}/issues/{number}` (returns issues and PRs; `pull_request` field presence ⇒ `isPullRequest: true`).
- Follow-up when PR: `gh api repos/{owner}/{repo}/pulls/{number}` for `merged`.
- Throws on any non-zero exit — callers own failure handling.

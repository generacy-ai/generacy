# Implementation Plan: Dependency-Blocked Implement Pause

**Feature**: Engine-native pause when the implement agent signals a deliberate dependency block (`SPECKIT_IMPLEMENT_BLOCKED` sentinel), with marker-comment persistence, cockpit-visible gate, poll-based re-arm on dependency close, bounded block cycles, and unreadable-ref escalation
**Branch**: `1211-problem-clarify-phase-answer`
**Status**: Complete

## Summary

Today an implement agent that correctly decides "I cannot proceed until sibling issue X closes" has no way to say so. It either stalls (the no-progress guard at `phase-loop.ts:957-987` converts the stall into `failed:implement` + `agent:error` — the observed failure across epic #1197's P1 issues) or fabricates work. This plan adds:

1. **A new sentinel** `SPECKIT_IMPLEMENT_BLOCKED: {"on": ["owner/repo#N", ...]}` parsed by `OutputCapture` exactly like `SPECKIT_IMPLEMENT_PARTIAL` (FR-001/FR-002/FR-010/FR-011).
2. **A blocked branch in the phase loop** that runs before the no-progress guard and the increment re-loop: commit/push WIP (Q2=A), post a `<!-- generacy-dependency-block -->` marker comment with the machine-parseable refs (Q1=A), apply `waiting-for:dependencies` + `agent:paused` via `LabelManager.onGateHit`, and return `{ completed: false, gateHit: true }` (FR-003/FR-004/FR-005/FR-012).
3. **A cycle cap** (Q4=B): the number of dependency-block marker comments since the newest limit comment is the cycle counter (durable, GitHub-derived — no Redis, per Q1's durability rationale). At N=3, escalate to a new `waiting-for:dependency-limit` operator gate with an explanatory comment, mirroring the `remediation-limit` precedent (FR-013).
4. **A re-arm monitor** — new `DependencyMonitorService` modeled on `ClarificationAnswerMonitorService` — polls issues carrying `waiting-for:dependencies`, reads the newest marker comment, checks each ref's closure state. Any closed state re-arms (Q3=C); not-planned closes and unmerged PR closes are flagged in the re-arm comment. Transient read errors retry quietly; 3 consecutive failures on a ref escalate visibly while the gate holds (Q5=B) (FR-007/FR-008/FR-014).
5. **Label + cockpit vocabulary**: `completed:dependencies`, `waiting-for:dependency-limit`, `completed:dependency-limit` added to `label-definitions.ts` (FR-009); `waiting-for:dependencies` and `waiting-for:dependency-limit` added to cockpit's `WAITING_PIPELINE_ORDER` (FR-006). Adding `completed:dependencies` to `WORKFLOW_LABELS` automatically makes the gate advance-able via the cockpit gate-vocabulary derivation — no cockpit-CLI code change.
6. **One new GitHub client capability**: `getIssueRefState(owner, repo, number)` on `GitHubClient` — the existing `getIssue` never fetches `state_reason`, and a ref may be a PR (merged vs closed-unmerged). Uses the REST issues endpoint (returns both issues and PRs) plus a pulls follow-up for `merged`.

## Technical Context

- **Language/runtime**: TypeScript, Node >= 20/22, ESM. Vitest for tests.
- **Packages touched**: `@generacy-ai/workflow-engine` (labels + client method — **minor**), `@generacy-ai/orchestrator` (sentinel, phase loop, monitor — **patch**), `@generacy-ai/cockpit` (`WAITING_PIPELINE_ORDER` — **patch**).
- **No new dependencies.** No new persisted state outside GitHub (marker comments are the source of truth; the monitor's per-ref failure counter is in-memory, acceptable for escalation throttling).
- **Feature-flag**: none. The path is inert unless the agent emits the sentinel (the prompt change lives in the agency repo — out of scope here), so existing runs are byte-identical by construction.
- **Line references**: develop as of 2026-08-27; verify at implement time.

## Key Decisions (full rationale in research.md)

| # | Decision |
|---|----------|
| D-1 | Sentinel parsed in `OutputCapture.parseLine` with `SENTINEL_BLOCKED_PREFIX`, last-wins, malformed-JSON warn+ignore, sentinel line still captured as text — byte-for-byte the `SPECKIT_IMPLEMENT_PARTIAL` pattern (`output-capture.ts:117-142`) |
| D-2 | `blocked_on?: string[]` joins `ImplementPartialResult` (`types.ts:178`); partial + blocked coexist in one object; blocked wins control flow because the blocked branch precedes the increment re-loop check at `phase-loop.ts:954` |
| D-3 | Blocked branch ordering: validate refs → WIP commit/push via `prManager.commitPushAndEnsurePr` (honor `pushRefused` abort, #1051) → cycle-cap check → marker comment → defensive clear of any lingering `completed:dependencies` → `onGateHit('implement', 'waiting-for:dependencies')` → return gate-hit |
| D-4 | Cycle counter = count of `<!-- generacy-dependency-block -->` comments newer than the newest `<!-- generacy-dependency-limit -->` comment. Durable across cluster restarts (Q1 rationale), zero new state stores, operator grant naturally resets the baseline |
| D-5 | Cap gate label pair: `waiting-for:dependency-limit` / `completed:dependency-limit`; `dependency-limit` joins `DEFAULT_RESUME_RETAIN_SUFFIXES` (clarifications implementation note); `GATE_MAPPING` gains both `dependencies` and `dependency-limit` → `{ phase: 'implement', resumeFrom: 'implement' }` |
| D-6 | Re-arm: monitor applies `completed:dependencies` **while the gate labels are still present**, then enqueues directly via `queueManager.enqueueIfAbsent` (`command: 'continue'`, `queueReason: 'resume'`); the label monitor's resume detection is a redundant second path (dedupe-safe); worker `onResumeStart` strips the pause labels |
| D-7 | New `GitHubClient.getIssueRefState` — REST `repos/{o}/{r}/issues/{n}` (works for issues and PRs, exposes `state_reason`), follow-up `repos/{o}/{r}/pulls/{n}` for `merged` when the ref is a PR |
| D-8 | Q5=B failure tracking: in-memory `Map<refKey, consecutiveFailures>` on the monitor; at 3, post `<!-- generacy-dependency-block-error -->` escalation comment (marker-deduped per block cycle), keep gate held, keep retrying |
| D-9 | Ref grammar: `owner/repo#N` (canonical) plus bare `#N`/`N` resolved against the blocked issue's repo (Assumption 6); parsing is a pure function with tests |

## Project Structure

```
packages/workflow-engine/src/
  actions/github/labels/label-definitions.ts        MOD  +completed:dependencies (0E8A16),
                                                         +waiting-for:dependency-limit (FBCA04),
                                                         +completed:dependency-limit (0E8A16)
  actions/github/client/interface.ts                MOD  +getIssueRefState()
  actions/github/client/gh-cli.ts                   MOD  +getIssueRefState() impl
  types/github.ts                                   MOD  +IssueRefState type

packages/orchestrator/src/
  worker/output-capture.ts                          MOD  +SENTINEL_BLOCKED_PREFIX parse branch
  worker/types.ts                                   MOD  ImplementPartialResult.blocked_on?
  worker/phase-loop.ts                              MOD  blocked branch before no-progress guard;
                                                         cycle-cap escalation; defensive completed clear
  worker/dependency-block.ts                        NEW  marker format/parse, ref grammar parser,
                                                         cycle counting, comment builders (pure + gh-backed)
  worker/phase-resolver.ts                          MOD  GATE_MAPPING +dependencies, +dependency-limit
  worker/label-manager.ts                           MOD  DEFAULT_RESUME_RETAIN_SUFFIXES +'dependency-limit'
  services/dependency-monitor-service.ts            NEW  poll → read marker → check refs → re-arm/escalate
  server.ts                                         MOD  construct + start DependencyMonitorService (full mode)

packages/cockpit/src/
  state/precedence.ts                               MOD  WAITING_PIPELINE_ORDER +waiting-for:dependency-limit
                                                         (beside remediation-limit), +waiting-for:dependencies

Tests (new):
  packages/orchestrator/src/worker/__tests__/output-capture.blocked-sentinel.test.ts
  packages/orchestrator/src/worker/__tests__/dependency-block.test.ts
  packages/orchestrator/src/worker/__tests__/phase-loop.dependency-block.test.ts
  packages/orchestrator/src/services/__tests__/dependency-monitor-service.test.ts
  packages/workflow-engine/... gh-cli.issue-ref-state.test.ts
  packages/cockpit/src/__tests__/ precedence assertion extension
```

## Constitution Check

No `.specify/memory/constitution.md` exists in this repository — check skipped (consistent with every prior spec on this repo).

## Test Plan (maps to success criteria)

| SC | Test |
|----|------|
| SC-001 | `phase-loop.dependency-block.test.ts`: implement succeeds with blocked sentinel → `onGateHit('implement','waiting-for:dependencies')` called, no `escalateAndAlert`, no `failed:implement`, returns `{ completed: false, gateHit: true }`, WIP commit precedes gate |
| SC-002 | same suite: implement with no sentinel and unchanged `tasks_remaining` → no-progress guard fires exactly as today (regression pin) |
| SC-003 | `dependency-monitor-service.test.ts`: gate + marker comment + all refs closed → `completed:dependencies` applied, `enqueueIfAbsent` called within one poll tick; partially closed → gate held |
| SC-004 | cockpit precedence test: `waiting-for:dependencies` and `waiting-for:dependency-limit` present in `WAITING_PIPELINE_ORDER`; gate-vocabulary derivation test: `dependencies` gate advance-able once `completed:dependencies` exists |
| FR-013 | phase-loop suite: third block cycle → `waiting-for:dependency-limit` + limit comment instead of silent re-pause; post-grant cycle count resets via limit-comment baseline |
| FR-014 | monitor suite: 2 consecutive ref-read failures → quiet retry; 3rd → escalation comment posted once (marker-deduped), gate held |

## Changeset

`.changeset/1211-dependency-blocked-pause.md` (written at implement time — the plan-phase commit touches only `specs/` + `CLAUDE.md`):
- `@generacy-ai/workflow-engine` **minor** — new label vocabulary (three labels) per CLAUDE.md's rule, plus new public client method `getIssueRefState`
- `@generacy-ai/orchestrator` **patch** — internal worker/monitor wiring, no new public exports
- `@generacy-ai/cockpit` **patch** — `WAITING_PIPELINE_ORDER` additions, no new exports

## Out of Scope (from spec, unchanged)

Agent prompt changes (agency repo), cross-org refs, transitive dependency chains, non-implement phases, removing the existing `waiting-for:dependencies` label definition.

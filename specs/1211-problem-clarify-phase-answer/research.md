# Research: Dependency-Blocked Implement Pause

Line references are develop as of 2026-08-27; verify at implement time.

## Decision 1 — Sentinel parsing lives in `OutputCapture.parseLine`

**Decision**: Add `SENTINEL_BLOCKED_PREFIX = 'SPECKIT_IMPLEMENT_BLOCKED: '` next to the existing `SENTINEL_PREFIX` (`output-capture.ts:117`), with an identical parse branch: prefix check, `line.slice(prefix.length)`, `JSON.parse` in try/catch, `logger.warn` on malformed JSON (FR-011), sentinel line still pushed into captured output as text, last-wins overwrite (FR-010).

**Rationale**: `SPECKIT_IMPLEMENT_PARTIAL` (`output-capture.ts:117-142`) is the exact same problem — an agent-emitted machine line carrying JSON that the engine reads post-run. Copying the pattern byte-for-byte means every property the PARTIAL sentinel already has (resilience to malformed JSON, last-wins on duplicates, no output loss) is inherited without new design. Tests can mirror the existing PARTIAL suite.

**Alternatives considered**:
- *Exit-code convention* (agent exits with a reserved code): rejected — exit codes already carry success/failure/timeout semantics; overloading them makes the CLI wrapper and every timeout path ambiguous.
- *Sidecar file* (like `review-findings-*.json`): rejected — the sidecar pattern exists for structured multi-field artifacts the engine must re-read across rounds. The blocked signal is a single-shot end-of-run message; stdout sentinel is the established channel for exactly that (`PARTIAL` precedent), and a file adds checkout-lifetime and cleanup concerns for no benefit.
- *MCP tool call*: rejected — implement agents run through the plain CLI spawn path with no engine-side MCP server; would be a whole new transport for one bit.

## Decision 2 — `blocked_on` joins `ImplementPartialResult`; blocked wins control flow

**Decision**: Add `blocked_on?: string[]` to `ImplementPartialResult` (`types.ts:178`). Both sentinels may populate the same object (Q2=A). The blocked branch in the phase loop runs **before** the increment re-loop check at `phase-loop.ts:954`, so blocked takes precedence structurally, not by flag arbitration.

**Rationale**: Q2=A mandates coexistence — an increment can legitimately complete tasks *and* hit the dependency wall. Keeping one result object preserves the `tasks_remaining` accounting the WIP-commit message and no-progress guard use. Ordering the branch before `:954` makes "blocked wins" a property of control flow that a reader can verify locally, rather than a boolean priority scheme.

**Alternatives considered**:
- *Separate `ImplementBlockedResult` field on `PhaseResult`*: rejected — two optional result fields that can disagree create an arbitration problem; the sentinel pair describes one increment, one object.
- *Mutual exclusion (Q2 option B)*: rejected by clarification — discards accurate task counts for no benefit.

## Decision 3 — Blocked-branch ordering in the phase loop

**Decision**: On `phase === 'implement' && result.success && result.implementResult?.blocked_on?.length`:
1. Parse/validate refs (D-9 grammar); if **zero** refs survive validation, fall through to normal flow (a blocked signal with no readable refs is treated as malformed — warn, ignore, FR-011 spirit).
2. WIP commit/push via `prManager.commitPushAndEnsurePr` (Q2=A); honor `pushRefused` abort per #1051 (`return { completed: false, gateHit: false }`).
3. Cycle-cap check (D-4). At cap → escalate to `waiting-for:dependency-limit` instead of re-pausing.
4. Post `<!-- generacy-dependency-block -->` marker comment with the refs (Q1=A).
5. Defensively remove any lingering `completed:dependencies` (best-effort).
6. `labelManager.onGateHit('implement', 'waiting-for:dependencies')`.
7. `return { completed: false, gateHit: true }`.

**Rationale**:
- Commit-before-pause is the existing increment contract (`phase-loop.ts:991` commits before re-entering); C (pause without commit) strands work in a recyclable checkout.
- Marker comment **before** gate labels: if the process dies between the two, an orphaned marker comment is harmless noise; the reverse order (gate without refs) strands the issue with a gate the monitor can never satisfy — the exact failure mode this feature eliminates.
- Defensive `completed:dependencies` clear closes the #1154-analog pre-satisfy hole: after a previous re-arm, `completed:dependencies` may survive (`dependencies` will be a human-gate suffix per D-5, so `onResumeStart` deliberately retains it per #1154); without the clear, the very next block's gate pair is instantly "answered" and the label monitor re-arms immediately in a tight loop.
- The no-progress guard (`phase-loop.ts:957-987`) is only reached when the blocked branch does not fire, satisfying FR-003 and keeping SC-002 (guard regression) intact by construction.

**Alternatives considered**:
- *Gate first, comment second*: rejected (stranding asymmetry above).
- *Reuse the increment path then pause*: rejected — the increment path re-enters the CLI with a fresh session; we want to stop, not re-run.

## Decision 4 — Cycle counter derived from marker comments (durable, no new store)

**Decision**: Cycle count = number of `<!-- generacy-dependency-block -->` comments on the issue that are **newer** than the newest `<!-- generacy-dependency-limit -->` comment (or all of them if no limit comment exists). At count ≥ N (N=3), the blocked branch posts a limit comment (marker-stamped, listing the open refs and how to resume) and applies `waiting-for:dependency-limit` instead of `waiting-for:dependencies`.

**Rationale**: Q4=B requires a bounded cycle count; Q1's durability rationale (dev-cluster Redis has no volume; a block can outlive a restart by days) applies equally to the counter — a Redis counter lost on `compose down` silently unbounds the loop. GitHub comments are already the persistence layer for the refs; counting markers costs one `getIssueComments` call the blocked branch already makes to check dedupe. The limit comment doubles as the reset baseline: when an operator grants more budget (advances the `dependency-limit` gate), the next block cycle counts only markers newer than that limit comment — budget resets naturally with zero extra state.

**Alternatives considered**:
- *Redis counter via `PhaseTrackerService`*: rejected — not durable (Q1 rationale) and adds a TTL-staleness class (#849 precedent).
- *In-memory counter on the worker*: rejected — workers are per-job processes; the counter must span jobs.
- *Counter embedded in the marker comment JSON (`cycle: N`)*: rejected — requires read-modify-write of the newest marker or trusting the agent-visible payload; counting comments is simpler and tamper-evident.
- *No cap (Q4 option A/C)*: rejected by clarification — burns a worker slot + CLI spend per cycle on an abandoned dependency.

## Decision 5 — Cap gate label pair + resume plumbing

**Decision**: New labels `waiting-for:dependency-limit` (FBCA04) and `completed:dependency-limit` (0E8A16) in `label-definitions.ts`, plus `completed:dependencies` (0E8A16). `GATE_MAPPING` (`phase-resolver.ts:9-25`) gains `'dependencies'` and `'dependency-limit'`, both → `{ phase: 'implement', resumeFrom: 'implement' }`. `'dependency-limit'` joins `DEFAULT_RESUME_RETAIN_SUFFIXES` (`label-manager.ts:107`, currently `['remediation-limit']`).

**Rationale**:
- GATE_MAPPING membership auto-includes both suffixes in `HUMAN_GATE_SUFFIXES` (derived from `Object.keys(GATE_MAPPING)`), which (a) makes label-monitor resume detection treat them as human gates and (b) makes `onResumeStart` preserve their `completed:*` labels per #1154's guard — required for the resume to actually resume.
- `resumeFrom: 'implement'` re-enters implement, which re-checks the dependency and either proceeds or re-emits the sentinel (Q3=C's self-correcting property).
- The retain-suffix entry is mandated by the clarifications implementation note: without it, a resume strips the cap gate's completed label and the cycle cap silently re-opens (mirrors why `remediation-limit` is in the set).
- Colors copy the established pairs (`waiting-for:remediation-limit` FBCA04 / `completed:remediation-limit` 0E8A16).

**Alternatives considered**:
- *Reuse `waiting-for:remediation-limit` for the cap*: rejected — different phase, different resume target, and cockpit operators need to distinguish "review loop capped" from "dependency loop capped".
- *Terminal `blocked:*` label at cap*: rejected — `blocked:*` is the legacy stranding pattern the epic deliberately moved away from (#1070); the cap must stay resumable.

## Decision 6 — Re-arm mechanics: completed-label first, direct enqueue, redundant label path

**Decision**: When all refs are closed, `DependencyMonitorService`:
1. Posts a re-arm comment (flagging any not-planned / unmerged-close refs per Q3=C).
2. Applies `completed:dependencies` **while** `waiting-for:dependencies` + `agent:paused` are still present.
3. Enqueues directly via `queueManager.enqueueIfAbsent({ command: 'continue', queueReason: 'resume', ... })`.
Worker-side `onResumeStart` strips the pause labels when the job starts.

**Rationale**: Applying `completed:dependencies` before touching the gate labels means the issue label state transiently matches the label monitor's resume signature (`completed:<X>` AND `waiting-for:<X>` both present, `label-monitor-service.ts:160-211`) — so even if the direct enqueue is lost (process crash between steps 2 and 3), the next label-monitor poll independently enqueues the resume. `enqueueIfAbsent` keys on `<owner>/<repo>#<issue>`, so the two paths dedupe by construction. This is strictly more robust than either path alone and costs nothing.

**Alternatives considered**:
- *Monitor strips gate labels itself, then enqueues*: rejected — creates the "no ownership label + no queued work" crash window (#1164 FR-008 lesson); worker-side `onResumeStart` already owns pause-label stripping.
- *Label-only re-arm (apply completed, let label monitor do the enqueue)*: workable but adds up to one label-poll interval of latency against SC-003 ("within one poll cycle" of the *dependency* monitor); the direct enqueue keeps SC-003 crisp and the label path remains as backstop.

## Decision 7 — New `GitHubClient.getIssueRefState`

**Decision**: Add `getIssueRefState(owner, repo, number): Promise<IssueRefState>` to `GitHubClient` (`interface.ts`) with the `GhCliGitHubClient` implementation using `gh api repos/{owner}/{repo}/issues/{number}` (returns both issues and PRs; exposes `state`, `state_reason`, and a `pull_request` marker field), plus a follow-up `gh api repos/{owner}/{repo}/pulls/{number}` for `merged` when the ref is a PR.

**Rationale**: Q3=C needs three distinctions the existing surface cannot provide: closed-as-completed vs closed-as-not-planned (issues — `getIssue` at `gh-cli.ts:123` never fetches `state_reason`) and merged vs closed-unmerged (PRs). A ref of the form `owner/repo#N` may be either an issue or a PR; the REST issues endpoint is the one endpoint that accepts both, making it the right primary probe. New public client method → workflow-engine **minor** per the changeset rules.

**Alternatives considered**:
- *Extend `getIssue` with `state_reason`*: rejected — `getIssue` has many callers with pinned expectations, and it still couldn't answer merged-vs-unmerged for PRs; a dedicated method keeps the contract single-purpose (same reasoning as `findPRForBranchAnyState` in #1051 — don't widen a defaulted method five call sites depend on).
- *`gh issue view --json closed` (as the spec's design note sketched)*: rejected — `gh issue view` fails on PR numbers in some gh versions and doesn't expose `state_reason` uniformly; `gh api` against REST is exact.
- *GraphQL single query*: workable but the codebase's GraphQL usage is confined to thread/draft mutations; REST via `gh api` matches the dominant client pattern.

## Decision 8 — Unreadable-ref escalation (Q5=B)

**Decision**: `DependencyMonitorService` keeps an in-memory `Map<refKey, consecutiveFailures>`. A successful read resets the counter. At 3 consecutive failures for a ref, post an escalation comment stamped `<!-- generacy-dependency-block-error -->` (deduped per block cycle: skip if an error marker newer than the newest block marker already exists), keep the gate held, keep retrying.

**Rationale**: Q5=B distinguishes transient from persistent without fail-open (C would contradict Q3=C's operator-signal principle) and without invisible stranding (A). In-memory is acceptable here — unlike the cycle cap, this counter only throttles *when the escalation comment posts*; losing it on restart merely delays the escalation by up to 3 poll cycles, and the comment-marker dedupe prevents spam across restarts. The dedupe baseline (newer than newest block marker) means each new block cycle can escalate once.

**Alternatives considered**:
- *Distinct label for the error state*: rejected — a second label on top of `waiting-for:dependencies` complicates the resume signature and cockpit precedence for a purely informational signal; a comment is the established escalation surface (remediation-limit precedent).
- *Persist failure counts in the marker comment*: rejected — read-modify-write churn on every poll cycle against a comment that other consumers parse.

## Decision 9 — Ref grammar

**Decision**: Canonical form `owner/repo#N`. Also accepted: bare `#N` and bare `N` (numeric string), resolved against the blocked issue's own repo (spec Assumption 6). Parsing is a pure function (`parseDependencyRefs(raw: string[], defaultOwner, defaultRepo)`) in `worker/dependency-block.ts`, returning normalized `{ owner, repo, number }[]` and dropping (with warn) anything that doesn't match. Cross-org refs are parsed but not specially handled (out of scope per spec); unreachable ones surface through the Q5=B escalation path.

**Rationale**: Agents naturally write `#42` for same-repo siblings (the epic #1197 P1 case that motivated this feature is exactly sibling issues in one repo). Normalizing at parse time means the marker comment always stores canonical refs, so the monitor's parser handles one shape. Pure function → trivially testable grammar matrix.

**Alternatives considered**:
- *Full-URL support (`https://github.com/o/r/issues/N`)*: deferred — easy to add later behind the same parser; not needed for the observed failure class, and URL-vs-ref ambiguity (issues vs pull URLs) adds grammar surface without evidence of demand.
- *Strict canonical-only*: rejected — guarantees avoidable malformed-ref drops on the dominant same-repo case.

## Decision 10 — Monitor shape: new `DependencyMonitorService` modeled on `ClarificationAnswerMonitorService`

**Decision**: New `services/dependency-monitor-service.ts` cloned structurally from `ClarificationAnswerMonitorService` (`clarification-answer-monitor-service.ts`): same ctor dependency set (logger, `GitHubClientFactory`, queueManager, `PrMonitorConfig`, repositories, tokenProvider, authHealth, webhooksConfigured), same `startPolling`/`stopPolling` AbortController loop, polls issues carrying `waiting-for:dependencies` via `listIssuesWithLabel`, reads the newest block marker, checks each ref via `getIssueRefState`. Constructed and started in `server.ts` full mode only (beside the clarification monitor at `:567-579` / `:1173-1177`).

**Rationale**: The clarification monitor is the exact shape — poll a `waiting-for:*` label, read a marker comment, decide, enqueue `continue`/`resume`. Reusing its skeleton inherits token-provider auth (#620), auth-health reporting (#762), drop-log conventions, and adaptive-polling wiring decisions already settled for that class of service.

**Alternatives considered**:
- *Fold into `LabelMonitorService`*: rejected — that service is the generic label→queue dispatcher; teaching it to fetch and evaluate external ref state bloats its poll loop and couples unrelated failure domains.
- *Webhook-driven re-arm (subscribe to dependency-issue close events)*: rejected — clusters are predominantly smee-less (#953); polling is the reliable baseline, and the spec assumes poll-based re-arm.

## Constitution check

No `.specify/memory/constitution.md` exists in this repository — check skipped (consistent with every prior spec).

## Key sources

- `packages/orchestrator/src/worker/output-capture.ts:117-142` — PARTIAL sentinel pattern (D-1 template)
- `packages/orchestrator/src/worker/phase-loop.ts:954-991` — increment re-loop + no-progress guard + WIP commit (D-2/D-3 insertion context)
- `packages/orchestrator/src/worker/phase-loop.ts:1611-1723` — remediation-limit cap precedent (D-4/D-5 template)
- `packages/orchestrator/src/worker/label-manager.ts:69-107,285-330,418-476` — HUMAN_GATE_SUFFIXES derivation, onGateHit, retain suffixes, onResumeStart
- `packages/orchestrator/src/worker/phase-resolver.ts:9-25` — GATE_MAPPING
- `packages/orchestrator/src/services/clarification-answer-monitor-service.ts` — monitor skeleton (D-10 template)
- `packages/orchestrator/src/services/label-monitor-service.ts:160-211` — resume signature (D-6 backstop path)
- `packages/cockpit/src/state/precedence.ts:18-62` — WAITING_PIPELINE_ORDER + fallback comment naming `dependencies`
- `packages/generacy/src/cli/commands/cockpit/gate-vocabulary.ts:33-52` — advance-able gate derivation from label pairs
- GitHub REST: `GET /repos/{o}/{r}/issues/{n}` (`state`, `state_reason`, `pull_request`), `GET /repos/{o}/{r}/pulls/{n}` (`merged`)

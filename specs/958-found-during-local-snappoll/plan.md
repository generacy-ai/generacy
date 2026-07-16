# Implementation Plan: Authorship-gated clarification answer scanner, quote-safe parser, and reply-only resume monitor (#958)

**Feature**: Replace the L488 content sniff with an authorship gate (`viewerDidAuthor`); require an engine-written HTML-comment marker (`<!-- generacy-clarification-answers:<batch> -->`) on cluster-self-authored answer sources; refactor cockpit's answer relay to stamp that marker through deterministic code; fix the `Q<n>:` capture so quote-reply and inline-quoted answers integrate; fail-close `hasPendingClarifications` on unknown inputs; add `ClarificationAnswerMonitorService` (mirror of `MergeConflictMonitorService`) so a plain human reply resumes the paused gate; unify the `*Pending*` literal via a single shared constant.
**Branch**: `958-found-during-local-snappoll`
**Status**: Complete

## Summary

`clarification-poster.ts` decides whether a comment is *questions* or *answers* by sniffing content (`answer.includes('**Question**:') || answer.includes('**Context**:')`, L488). Content is a proxy for authorship, and it fails in both directions: **fails open for the bot** (self-answer of the gate — snappoll#7 planned on five fabricated answers) and **fails closed for humans** (a valid `Q1: A` gets discarded because a quoted `> ### Q2:` block bleeds into Q1's capture and the sniff sees the leaked `**Question**:`). #909's marker-allowlist patch cannot hold because there is no deterministic writer for the allowlisted markers — four issues in one run produced four different agent-invented markers.

The single defect is *authorship-by-content*. This PR replaces it with authorship-by-`viewerDidAuthor` (already plumbed by #910), and adds the two properties that make that gate durable:

1. **Cluster-self-authored comments are answer sources only when they carry an engine-written marker stamped by deterministic code, never by an agent.** That is the narrow correction to #910's "bot == authoritative" conflation. Cockpit's answer-relay path is refactored in the same PR to post through a tool that formats and stamps the marker deterministically — otherwise the agent free-writes the comment, the marker is improvised per run, and we rebuild this exact bug on the answer side (the four-different-invented-markers table on #5/#6/#7/#8 is the evidence).
2. **The `Q<n>:` capture strips `> `-quoted lines and bounds at quoted blocks before parsing.** GitHub "Quote reply" then works on any answer position, not only the last. Trailing quoted noise never discards a valid leading answer.

Six adjacent fail-open surfaces close together with this one:

- **FR-004** (`TRANSITION_WITH_QUESTION_HEADINGS`) becomes fail-closed control flow, not a `logger.warn`. Blast radius is asymmetric — per-comment for humans (one bad quote-reply doesn't discard everyone else's answers in the same poll), per-poll for cluster-self (a self-authored comment carrying a valid marker AND question headings is a malfunction of unknown extent, so abort integration and leave the gate armed).
- **FR-007**: `hasPendingClarifications` fails closed on missing spec dir / unreadable file / unparseable content. Unknown must mean pause on a human gate.
- **FR-008**: `completed:clarify` moves below the gate check so it is never granted before evaluation.
- **FR-009**: `postClarifications()` runs unconditionally on the clarify phase, not only in the gate-active branch — so the safety net stops going quiet exactly when needed.
- **FR-010**: partial-parse failures are reported to the issue (comment + relay event) enumerating unparsed question indices. Silent partial advance is the anti-goal.
- **FR-011**: `ClarificationAnswerMonitorService` polls `waiting-for:clarification` + `agent:paused`; on a new human-authored comment it enqueues a resume queue item via `enqueueIfAbsent` (mirrors `MergeConflictMonitorService`), never applies `completed:clarification`. The phase loop performs integration on checkout; the gate deactivates naturally if everything answered, re-arms if questions remain.
- **FR-012**: prompt (`clarify.ts` L55), parser (`clarification-poster.ts` L303), write-back regex (L738–740), and cockpit answer-relay path all import `PENDING_ANSWER_LITERAL` — divergence becomes structurally impossible. Parser additionally treats empty / whitespace-only / any `[…]`-bracketed value as pending. Failure direction is "ask again", never "advance".

FR-013 (snappoll#7 cleanup) is out of scope per Q5 — delivered out-of-band as an ops task on a throwaway demo repo.

## Technical Context

- **Language**: TypeScript (strict), ESM, Node ≥22.
- **Packages touched**: `@generacy-ai/orchestrator`, `@generacy-ai/generacy` (cockpit CLI + MCP), `@generacy-ai/workflow-engine` (prompt-template + single constant). No new packages.
- **Runtime dependencies**: none new. GraphQL `viewerDidAuthor` is already fetched by `getIssueCommentsWithViewerAuth` (#910); this PR consumes the field, does not add fetch surface.
- **Existing constraints observed**:
  - Column-0 rule (`clarification-markers.ts`) — quoted markers must not match; extends to the new answer marker.
  - `MergeConflictMonitorService`'s `enqueueIfAbsent(itemKey)` dedupe pattern is the reference (no `phase-tracker:*:resume:*` key, in-flight collisions collapse silently — spec §Reference model).
  - `WORKFLOW_LABELS` `waiting-for:clarification` + `agent:paused` label pair is the reactive surface for FR-011.
- **Deployment envelope**: orchestrator + cockpit ship in the same PR (spec §Assumptions and Q1 answer). Cockpit's `runAdvance` today posts only a `formatManualAdvanceComment` audit line and applies `completed:clarification` — the drafted answers are posted freehand via `gh issue comment` by the agent following the skill. That is the third instance of this issue's root cause; changing it is load-bearing for FR-003.
- **Changeset**: `.changeset/958-*.md` — `minor` on `@generacy-ai/orchestrator` and `@generacy-ai/generacy` (new capability: authorship-gated integration + new monitor service + new cockpit answer-relay tool); `patch` on `@generacy-ai/workflow-engine` (prompt-template imports a re-exported constant, no public API change).

## Project Structure

Changes localize to three packages. Two new files in orchestrator (monitor service + shared constant), one new MCP tool in generacy (or a sibling verb), plus focused edits to `clarification-poster.ts`, `phase-loop.ts`, `clarify.ts`, and the cockpit clarify skill's tool call site.

```
packages/orchestrator/src/
├── worker/
│   ├── clarification-poster.ts                        [MODIFY]
│   │   - Import PENDING_ANSWER_LITERAL from the shared constant
│   │   - Import CLARIFICATION_ANSWER_MARKERS + matchClarificationAnswerMarker from clarification-markers.ts
│   │   - Add stripQuotedLines(body) helper (FR-005): drop lines whose first non-EOL char is `>`
│   │   - Rewrite parseAnswersFromComments regex bounding: stop at first `> `-quoted `Q<n>:` OR unquoted `Q<n>:` at column 0
│   │   - FR-006: preserve captured leading answer when trailing quoted block would otherwise fail the sniff — split at first `> `-line, keep the head
│   │   - Delete the L488 `.includes('**Question**:')` sniff (FR-001 removes it as an authorship signal)
│   │   - Author-classification branch: viewerDidAuthor === true → require matchClarificationAnswerMarker(body); false/undefined → parse permissively (FR-002)
│   │   - FR-004: TRANSITION_WITH_QUESTION_HEADINGS branches on viewerDidAuthor:
│   │       human → skip only the offending comment (surviving humans in the same poll integrate)
│   │       cluster-self → abort entire poll's integration, gate stays armed, structured warn
│   │   - hasPendingClarifications: missing spec dir / unreadable / unparseable → return true (FR-007). Distinguish parse failure vs. legit empty file via non-empty-content check.
│   │   - IntegrationResult gains { pendingAfter: number, parseFailures: Array<{questionNumber, reason}> } for FR-010 reporting
│   ├── clarification-markers.ts                       [MODIFY]
│   │   - Add CLARIFICATION_ANSWER_MARKERS = ['<!-- generacy-clarification-answers:'] as const
│   │   - Add matchClarificationAnswerMarker(body) + commentCarriesAnswerMarker(body)
│   │   - Column-0 rule same as question-marker family — quoted markers do not match (mirrors the existing invariant)
│   ├── pending-literal.ts                              [ADD]
│   │   - export const PENDING_ANSWER_LITERAL = '*Pending*'
│   │   - export function isPendingAnswerValue(v: string): boolean
│   │       treat empty / whitespace-only / any `[…]`-bracketed placeholder / `PENDING_ANSWER_LITERAL` as pending (Q2 answer)
│   ├── phase-loop.ts                                  [MODIFY]
│   │   - FR-008: move labelManager.onPhaseComplete(phase) from L723 to AFTER the gate-check block (below L810)
│   │       — completed:clarify is granted only if no gate activated
│   │       — remove the completedLabel-retract branch from label-manager.ts's onGateHit path once the ordering is safe
│   │   - FR-009: hoist the `postClarifications()` safety net so it runs on any clarify-phase completion, not only when gateActive
│   │       — sits alongside integrateClarificationAnswers, above the `if (!gateActive) continue` guard
│   │   - FR-010: after integrateClarificationAnswers, if IntegrationResult.parseFailures.length > 0, post a parse-failure comment enumerating question indices + emit relay event
│   └── label-manager.ts                               [MODIFY]
│       - After FR-008 lands, the completedLabel-retract branch at onGateHit (L226-229) can drop `completedLabel` from the removeLabels list — the label was never applied
│       - Comment-preservation: keep a note that FR-008 is the reason; no behavior change on gate hit
├── services/
│   ├── clarification-answer-monitor-service.ts        [ADD]  Mirror of merge-conflict-monitor-service.ts
│   │   - class ClarificationAnswerMonitorService with startPolling / stopPolling / poll / pollRepo / processClarificationEvent
│   │   - polls listIssuesWithLabel('waiting-for:clarification') with filterByAssignee + agent:paused precondition
│   │   - On each candidate issue: fetch comments (viewer-auth), detect ≥1 comment with `viewerDidAuthor === false` newer than the paused-at boundary → enqueue { command: 'continue', queueReason: 'resume' } via enqueueIfAbsent
│   │   - MUST NOT apply completed:clarification (Q4 answer)
│   │   - Author-trust gating via isTrustedCommentAuthor('answer-scanner', ...) — same helper the phase-loop scanner already uses
│   │   - AuthHealthSink + JIT / GhAuth error branches — copied verbatim from merge-conflict-monitor-service
│   └── index.ts                                       [MODIFY] export ClarificationAnswerMonitorService
└── server.ts                                          [MODIFY]
    - Instantiate ClarificationAnswerMonitorService alongside MergeConflictMonitorService
    - Pass same tokenProvider, authHealth, credential id, cluster-github-username
    - Register .startPolling() / .stopPolling() in the same lifecycle hooks

packages/workflow-engine/src/actions/builtin/speckit/operations/
└── clarify.ts                                          [MODIFY]
    - Import PENDING_ANSWER_LITERAL from @generacy-ai/orchestrator (or a lightweight shared constants module)
    - Replace the literal `[Leave empty for now]` at L55 with a template that inlines `${PENDING_ANSWER_LITERAL}`
    - Prompt text: `**Answer**: *Pending*` (the parser's canonical value — Q2 answer)

packages/generacy/src/cli/commands/cockpit/
├── clarification-answer-marker.ts                     [ADD]
│   - formatClarificationAnswerComment({ batch, answers, actor?, ts }) — deterministic stamping
│   - Header: `<!-- generacy-clarification-answers:${batch} actor=${actor} ts=${ts} -->`
│   - Body: `## Answers — batch ${batch}` + one `Q<n>: <answer>` line per entry, no free-form prose
│   - GATE / ACTOR / TS regex-validated (mirror manual-advance-marker.ts contract)
├── clarify-relay.ts                                    [ADD]  (or extend advance.ts — see contracts/cockpit-answer-relay.md)
│   - runClarifyRelay({ issue, answers, ... }): posts the stamped comment via gh.postIssueComment, then applies completed:clarification
│   - Answers input is a structured { [questionNumber: number]: string } object — no free-form body accepted
│   - Reuses resolveIssueContext, CockpitExit, resolveCockpitIdentity
└── mcp/tools/
    └── cockpit_relay_clarify_answers.ts                [ADD]  (new sibling MCP tool)
        - Zod schema: { issue: IssueRefInput, batch: number, answers: Record<number, string> }
        - Delegates to runClarifyRelay, returns ToolResult with { commentUrl, completedLabel }

.claude/skills/cockpit-clarify/                         [MODIFY]  (companion skill update)
    - Refactor to invoke cockpit_relay_clarify_answers instead of the freehand `gh issue comment` step
    - Skill file(s) that instruct the agent to relay answers rebuilt around structured tool invocation (Q1 answer)

.changeset/958-*.md                                    [ADD]  minor: orchestrator, generacy; patch: workflow-engine

specs/958-found-during-local-snappoll/
├── spec.md                                            [read-only]
├── clarifications.md                                   [read-only]
├── plan.md                                             [THIS FILE]
├── research.md                                         [ADD]
├── data-model.md                                       [ADD]
├── quickstart.md                                       [ADD]
└── contracts/
    ├── answer-marker.md                                [ADD]  Marker shape + stamping invariants
    ├── clarification-answer-monitor.md                 [ADD]  Monitor contract (mirrors merge-conflict monitor)
    ├── cockpit-answer-relay.md                         [ADD]  New tool contract + skill wiring
    └── pending-answer.md                               [ADD]  PENDING_ANSWER_LITERAL semantics + parser tolerance
```

**Files NOT changing:**

- `packages/workflow-engine/src/security/comment-trust.ts` — `isTrustedCommentAuthor` is unchanged. Authorship gate is a *separate* signal from trust. Trust gates the whole scanner (who can be an answer source at all); authorship + marker gates which subset requires the deterministic stamp.
- `packages/orchestrator/src/services/label-monitor-service.ts` — the label-monitor path stays as-is. The new monitor is a sibling for the `waiting-for:clarification` reactive surface; the label monitor still services generic label-transition resume flows.
- `packages/orchestrator/src/routes/webhooks.ts` — `issue_comment` remains unsubscribed (spec §Out of Scope). The monitor is the chosen mechanism.
- `CLARIFICATION_QUESTION_MARKERS` — unchanged. The answer-marker family is a *new* set; the question family is what stays out of the scanner. Both families share the column-0 match rule.
- `packages/orchestrator/src/worker/pr-feedback-handler.ts` — pr-feedback trust plumbing was #910's work; this PR does not touch it.

## Design invariants

1. **Authorship, not content, gates integration.** `viewerDidAuthor` is the sole authorship signal on the answer-scanner surface. The L488 sniff (`.includes('**Question**:')`) is deleted. FR-102 pre-filter for engine-authored questions markers stays as a second line of defense for a human comment that happens to quote the marker — but it never gates authorship anymore.
2. **Cluster-self answer sources require a marker written by deterministic code.** No agent may free-write the answer comment. The new cockpit tool is the sole writer of `<!-- generacy-clarification-answers:<batch> -->`. The skill invokes the tool with structured `{ [questionNumber]: string }`; the tool formats and stamps.
3. **`>`-quoted lines are transparent to the parser.** Strip them before the `Q<n>:` regex runs. A quoted `> ### Q2:` bounds the Q1 capture. A quoted marker line does not match the marker (column-0 rule already codifies this).
4. **Failure direction is always "ask again".** `hasPendingClarifications`, the `PENDING_ANSWER_LITERAL` tolerance, and the FR-004 blast radius all default to pausing over advancing when the state is uncertain.
5. **`completed:clarification` is a human force-advance override, not a resume signal.** The monitor enqueues a resume; the phase loop integrates on checkout; the gate deactivates naturally when the file has no pending questions. The label is preserved for its stated meaning: "proceed anyway, I know parsing failed."
6. **Cockpit's marker-stamping surface is versioned by the codebase, not by prompts.** Adding a new answer-marker dialect appends to `CLARIFICATION_ANSWER_MARKERS` — no changes elsewhere. Prompts never spell the literal.

## Constitution check

No `.specify/memory/constitution.md` in this repo. Cross-referenced against the codebase conventions inline in `CLAUDE.md`:

- ✅ Changeset required on any non-test change under `packages/*/src/` — planned (`.changeset/958-*.md`).
- ✅ New capability → `minor` bump on orchestrator + generacy; prompt-template edit → `patch` on workflow-engine.
- ✅ Fail-closed defaults over fail-open (design invariant #4) — matches the codebase pattern for security-adjacent gates.
- ✅ No comment placeholders / feature flags / backwards-compat shims — the `[Leave empty for now]` legacy value is subsumed by `PENDING_ANSWER_LITERAL`'s bracketed-tolerance rule (Q2 answer), no separate legacy handling.
- ✅ Single-source constants over synchronized string literals — `PENDING_ANSWER_LITERAL`, `CLARIFICATION_ANSWER_MARKERS`.

## Phasing

This is a single PR — the six adjacent surfaces (FR-004 through FR-012) are load-bearing on each other and cannot land independently without leaving a partial-fix window that reproduces the original defect (FR-008 without FR-011 would strand humans; FR-011 without FR-001 would enqueue on a bot self-answer). The two independently-shippable slivers are `PENDING_ANSWER_LITERAL` (would ship on its own) and the cockpit answer-relay tool (would ship on its own with the skill rewrite) — both bundle here because they're the two nail-downs the spec Q1 + Q2 answers required as pre-conditions.

## Next step

Run `/speckit:tasks` to break the plan into an ordered task list with dependency markers.

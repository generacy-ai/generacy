# Tasks: Clarification-answer monitor stops resuming on its own bot comments

**Input**: Design documents from `/specs/993-summary-orchestrator-s/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/monitor-predicate-contract.md, contracts/machine-markers-contract.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Marker matcher (FR-005 — independent leaf)

- [ ] T001 [P] [US1] Rewrite `matchMachineMarker` in `packages/orchestrator/src/worker/clarification-markers.ts` to add a family-prefix pass on new `MACHINE_MARKER_FAMILIES` constant containing `'<!-- generacy-stage:'` and `'<!-- speckit-stage:'` (per contracts/machine-markers-contract.md).
  - Add exported `const MACHINE_MARKER_FAMILIES: readonly string[] = ['<!-- generacy-stage:', '<!-- speckit-stage:'] as const;`
  - Remove the six enumerated `<!-- generacy-stage:*` / `<!-- speckit-stage:*` entries from `MACHINE_MARKERS` (specification / planning / implementation for each family). Keep `CLARIFICATION_QUESTION_MARKERS` spread, `generacy-cockpit:manual-advance`, `generacy-clarification-answers:`, `generacy-untrusted-answer:`, `generacy-clarification-parse-failures:`.
  - `matchMachineMarker` implementation: for each line of `body`, first check every prefix in `MACHINE_MARKER_FAMILIES` via `startsWith`; if match, return the family prefix. Otherwise fall back to the enumerated `MACHINE_MARKERS` loop (unchanged semantics). First match wins.
  - Preserve invariants: line-anchored (split on `\n`, no trim), case-sensitive ASCII, `> `-quoted markers do NOT match, empty body returns `undefined`.
  - `commentCarriesMachineMarker` continues to be `matchMachineMarker(body) !== undefined` — no signature change.
  - Do NOT change `CLARIFICATION_QUESTION_MARKERS`, `CLARIFICATION_ANSWER_MARKERS`, `matchClarificationQuestionMarker`, `commentCarriesQuestionMarker`, `matchClarificationAnswerMarker`, `commentCarriesAnswerMarker`.

## Phase 2: Monitor predicate rewrite (FR-001, FR-003, FR-004)
<!-- Phase boundary: T001 does not block T002 (different files); listed sequentially only for reviewer flow -->

- [ ] T002 [US1] Rewrite the answer-candidate loop in `packages/orchestrator/src/services/clarification-answer-monitor-service.ts` (currently `processClarificationAnswerEvent` lines ~156–260, target loop at ~204–212) per contracts/monitor-predicate-contract.md.
  - Add two file-local pure helpers at the bottom of the module (not exported):
    - `function isBotAuthoredLogin(author: string): boolean` → `author.trim().toLowerCase().endsWith('[bot]')`.
    - `function latestQuestionCommentCreatedAt(comments: Comment[]): string | undefined` → scans for the newest `created_at` (ISO-8601 lexicographic `>` compare) among comments where `matchClarificationQuestionMarker(c.body) !== undefined`; returns `undefined` if none.
  - Extract the predicate into a private method `findAnswerCandidate(comments: Comment[], trustCtx: CommentTrustContext): Comment | undefined`:
    1. `questionAnchor = latestQuestionCommentCreatedAt(comments)`; if `undefined`, return `undefined` (FR-004 short-circuit — nothing to answer).
    2. Iterate `comments` in received order. For each `c`:
       - `if (commentCarriesMachineMarker(c.body)) continue;` (FR-005 skip).
       - `if (isBotAuthoredLogin(c.author)) continue;` (FR-001 upstream bot filter — before trust helper).
       - `if (c.created_at <= questionAnchor) continue;` (FR-004 strict newness).
       - Branch (a): `if (commentCarriesAnswerMarker(c.body)) return c;` (FR-003(a) — non-bot marker).
       - Branch (b): `const decision = isTrustedCommentAuthor(c, 'answer-scanner', trustCtx);` — if `decision.trusted && decision.reason !== 'bot' && decision.reason !== 'self-authored'`, return `c` (FR-003(b) — trusted external human by association tier).
    3. Return `undefined` if no comment qualifies.
  - Wire the caller: replace the current negative predicate loop with `const candidate = this.findAnswerCandidate(comments, trustCtx);`. On `undefined`, return `false` and preserve the existing "No trusted human-authored comment found" debug log line (widen its message to also cover the FR-004 short-circuit case). On non-`undefined`, keep the existing `enqueueIfAbsent` path (queue construction at ~227–247) and the `'Clarification-answer resume enqueued'` info log unchanged.
  - Add exactly two load-bearing comments (per plan.md §Constitution Check):
    - One line above the `isBotAuthoredLogin` filter site: bot markers intentionally fail — cluster-relayed answers flow through `completed:clarification` label / LabelMonitorService.
    - One line above the `latestQuestionCommentCreatedAt` call: `created_at`-only is intentional (replay-safe; blocks `<!-- generacy-stage:specification -->` summary re-trigger vector).
  - Do NOT modify `isTrustedCommentAuthor` (`packages/workflow-engine/src/security/comment-trust.ts`) — the fix is upstream of the trust helper.
  - Do NOT touch preconditions (161–178), comment fetch (185–195), or the queue construction path (227–247).
  - Do NOT apply `completed:clarification`, modify `clarifications.md`, or write any GitHub state (invariants in contracts/monitor-predicate-contract.md §"Non-behavior").

## Phase 3: Tests

- [ ] T003 [P] [US1] Extend `packages/orchestrator/src/worker/__tests__/clarification-markers.test.ts` for SC-004 family-match coverage (per contracts/machine-markers-contract.md §"Test cases").
  - Positive family match: `<!-- speckit-stage:tasks -->\nBody\n` → `matchMachineMarker` returns `'<!-- speckit-stage:'`; `commentCarriesMachineMarker` returns `true`.
  - Positive family match on the observed bug prefix: `<!-- speckit-stage:clarification -->\n` → returns `'<!-- speckit-stage:'`.
  - Regression: `<!-- generacy-stage:specification -->\n` still returns truthy — matched by family, not by enumeration.
  - SC-004 assertion: unknown future stage suffix `<!-- generacy-stage:future-phase-that-does-not-exist-yet -->\n` matches without any code change to the enumerated list.
  - Anchor-preservation: `<!-- generacy-clarifications:5 -->\n` → `matchMachineMarker` returns `'<!-- generacy-clarifications:'` (enumerated), NOT the family prefix; `commentCarriesQuestionMarker(input) === true`.
  - Case sensitivity preserved: `<!-- Generacy-Stage:foo -->\n` → `commentCarriesMachineMarker` returns `false`.
  - `> `-quoted marker still not matched: `> <!-- generacy-stage:specification -->\n` → `false`.
  - Empty body: `matchMachineMarker('')` returns `undefined`.

- [ ] T004 [US1] Extend `packages/orchestrator/src/services/__tests__/clarification-answer-monitor-service.test.ts` for SC-001 / SC-002 / SC-003 + tie-and-short-circuit edge cases (per contracts/monitor-predicate-contract.md §"Test cases").
  - **SC-001 — bot-only comments, zero resumes across N poll cycles** (regression for the #5–#8 snappoll loop):
    - Fixture: three comments all authored by `generacy-ai[bot]` — `<!-- generacy-stage:specification -->` at `2026-07-18T09:00:00Z`, `<!-- speckit-stage:clarification -->` at `09:59:00Z`, `<!-- generacy-clarifications:5 -->` at `10:00:00Z`. No other comments.
    - Assert: `processClarificationAnswerEvent` returns `false` on every call across ≥3 iterations; `queueManager.enqueueIfAbsent` NOT called.
  - **SC-002 — bot noise + one real external human, exactly one resume**:
    - Fixture: SC-001 comments PLUS one `christrudelpw` comment (`authorAssociation: 'MEMBER'`, `created_at: 2026-07-18T10:15:00Z`, plain body without any marker).
    - Assert: returns `true`; `queueManager.enqueueIfAbsent` called exactly once with command `'continue'`.
  - **SC-003 — non-bot marker-carrying answer**:
    - Fixture: bot-authored question marker at `10:00:00Z`; comment authored by `humantester` (`authorAssociation: 'MEMBER'`) at `10:15:00Z` with body containing `<!-- generacy-clarification-answers:1 -->\nQ1: yes`.
    - Assert: returns `true`; `enqueueIfAbsent` called once.
  - **Edge — no question-marker comment on issue**:
    - Fixture: only one `christrudelpw` comment at `10:00:00Z`, no question markers anywhere.
    - Assert: returns `false`; `enqueueIfAbsent` NOT called (FR-004 short-circuit).
  - **Edge — `viewerDidAuthor === true` on non-`[bot]` author does not qualify**:
    - Fixture: bot-authored question marker at `10:00:00Z`; comment authored by `christrudelpw` (`authorAssociation: 'MEMBER'`, `viewerDidAuthor: true`) at `10:15:00Z`.
    - Assert: returns `false` (trust reason `'self-authored'` is excluded from the predicate).
  - **Edge — candidate `created_at` equals question `created_at` (tie)**:
    - Fixture: bot-authored question at `10:00:00Z`; `humantester` comment (`authorAssociation: 'MEMBER'`) also at `10:00:00Z`.
    - Assert: returns `false` (strict `>` per FR-004; ties don't qualify).
  - **Edge — bot-authored comment carrying the answer marker does NOT rescue**:
    - Fixture: bot question at `10:00:00Z`; `generacy-ai[bot]`-authored comment at `10:15:00Z` with body containing `<!-- generacy-clarification-answers:1 -->`.
    - Assert: returns `false` (FR-001 bot filter runs upstream; marker does not override).

## Phase 4: Changeset (required — CI gate per CLAUDE.md)

- [ ] T005 [US1] Add `.changeset/993-clarification-answer-bot-filter.md` as a **newly added** file:
  - Frontmatter: `'@generacy-ai/orchestrator': patch` (defect fix, `workflow:speckit-bugfix`).
  - One-line description referencing #993 and the bot-comment resume-loop fix.
  - Verify per CLAUDE.md rules: newly added under `.changeset/` (not editing existing); `patch` bump (defect fix); package list covers every touched non-test `src/` under `packages/*/src/` (only `@generacy-ai/orchestrator` — no other package modified).

## Dependencies & Execution Order

**Parallelizable**:
- T001 (`clarification-markers.ts`) and T002 (`clarification-answer-monitor-service.ts`) touch different files with no code-path dependency — either can land first; safe to develop in parallel branches.
- T003 (markers test) is independent of T004 (monitor test) — different test files.

**Sequenced** (correctness, not merge conflicts):
- T004 depends on T001 + T002 landing: SC-001's fixture relies on `<!-- speckit-stage:clarification -->` being caught by the family match (T001) AND on the `[bot]` upstream filter existing (T002). Running T004 before either fix will fail — that's the intended TDD signal, but authors should implement in the order T001 → T002 → T004 to keep diffs reviewable.
- T003 depends only on T001.
- T005 (changeset) is the last edit before commit — its diff must be present in the same PR as T001/T002 or CI's changeset-bot gate fails.

**Not applicable to this fix** (per plan.md §"Out of Scope"):
- No `isTrustedCommentAuthor` changes — the fix is upstream of the trust helper.
- No `completed:clarification` / LabelMonitorService changes — cluster-relayed answers already flow through the label path.
- No poll-gate / adaptive polling changes (independent of #987 / #953).
- No config / schema / persistent-data changes (per data-model.md §"No persistent data changes").

## Reporting

- Total tasks: 5 (T001–T005) across 4 phases.
- Phase 1 (markers matcher): 1 task, parallelizable with Phase 2.
- Phase 2 (monitor predicate): 1 task.
- Phase 3 (tests): 2 tasks (one per file, both parallelizable with each other).
- Phase 4 (changeset): 1 task; sequential (must ship in the same PR).
- Mode: Standard (fine-grained).
- Parallel opportunities: T001 ‖ T002; T003 ‖ T004.
- Next step: `/speckit:implement` to begin execution.

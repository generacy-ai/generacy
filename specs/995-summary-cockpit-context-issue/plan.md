# Implementation Plan: fix `cockpit_context` clarification-comment finder against label re-application

**Feature**: Replace `findClarificationComment`'s label-timeline heuristic with positive marker-based identification anchored on `CLARIFICATION_QUESTION_MARKERS`, with a warn-logged fallback to today's heuristic when zero marker-carrying comments exist.
**Branch**: `995-summary-cockpit-context-issue`
**Status**: Complete
**Issue**: [#995](https://github.com/generacy-ai/generacy/issues/995)
**Workflow**: `speckit-bugfix`

## Summary

`findClarificationComment` currently anchors on the *most-recent* `waiting-for:clarification` `labeled` event and picks the first comment created at-or-after it. Requeue / boot-resume / cluster-restart re-apply the label without re-posting the questions, jumping `labelTime` past every existing question comment and returning `null`. `/cockpit:auto` D.1 then degrades to a direct `gh` inspection instead of using the engine bundle.

Fix: reorder the finder to a **marker-first, timeline-fallback** strategy.

1. **Primary path** — scan all comments; return the *latest-by-`createdAt`* comment carrying a `CLARIFICATION_QUESTION_MARKERS` prefix at column 0 (via the shared `matchClarificationQuestionMarker` predicate). Stage-status comments continue to be excluded.
2. **Fallback path** — if zero marker-carrying comments exist, run today's label-timeline heuristic unchanged, and emit a single-line `warn`: `marker-less clarification comment; poster should be updated — issue=<owner/repo#N>`.
3. **Give up** — return `null` only when both paths yield nothing.

Public signature `(gh, repo, number) → Promise<IssueComment | null>` is unchanged.

Scope is confined to this one file + its unit test + a changeset. No label-protocol, poster, resume-loop, or `waiting-for:clarification` lifecycle changes. Poster-side companion (FR-004, per Q1) is tracked as a separate follow-up issue in this repo.

## Technical Context

- **Language / runtime**: TypeScript (ES2022, ESM), Node ≥22.
- **Package**: `@generacy-ai/generacy` (`packages/generacy/`).
- **Test framework**: `vitest` (`pnpm test` inside `packages/generacy`).
- **Marker registry**: `packages/orchestrator/src/worker/clarification-markers.ts`, re-exported from `@generacy-ai/orchestrator` root (`packages/orchestrator/src/index.ts:268-275`) as `matchClarificationQuestionMarker` + `CLARIFICATION_QUESTION_MARKERS`. `@generacy-ai/orchestrator` is already a direct dependency of `@generacy-ai/generacy` (`packages/generacy/package.json:46`); no new dep needed.
- **Logger**: `getLogger()` from `packages/generacy/src/cli/utils/logger.ts` (pino). Log at `warn` level with structured fields `{ owner, repo, issue }` plus the message.
- **Types**: `GhWrapper`, `IssueComment` continue to come from `@generacy-ai/cockpit`.

## Project Structure

```
packages/generacy/src/cli/commands/cockpit/
├── clarification-comment-finder.ts         # MODIFIED — marker-first strategy + fallback + warn log
└── __tests__/
    └── clarification-comment-finder.test.ts # MODIFIED — 3 new tests (US1, US2, fallback), existing tests preserved

.changeset/
└── 995-cockpit-clarification-finder-marker.md  # NEW — patch bump for @generacy-ai/generacy
```

No new files created; one file modified in place, one test file modified in place, one changeset file added.

## Design Decisions

### D1 — Import the marker predicate; don't duplicate it (FR-006 / US3)

`matchClarificationQuestionMarker` is already exported from `@generacy-ai/orchestrator`'s public surface. Import it directly:

```ts
import { matchClarificationQuestionMarker } from '@generacy-ai/orchestrator';
```

Do NOT redefine the marker inventory or the column-0 line-anchored match rule locally — that is exactly the "divergent matcher" FR-006 forbids. Adding a new dialect stays a one-line change to `clarification-markers.ts`.

### D2 — Marker-first ordering with the fallback strictly inside the same function

The public signature stays `(gh, repo, number) → Promise<IssueComment | null>`. Restructure the body as two sequential passes over one `fetchIssueComments` result:

```ts
const comments = await gh.fetchIssueComments(repo, number);

// Pass 1: marker-first (US1, FR-001, FR-002)
const markerHits = comments
  .filter((c) => matchClarificationQuestionMarker(c.body) !== undefined)
  .filter((c) => !isStageStatusComment(c.body))                          // FR-003
  .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));    // FR-002: latest first
if (markerHits.length > 0) return markerHits[0];

// Pass 2: label-timeline fallback (FR-005) — today's code path, unchanged
getLogger().warn(
  { owner, repo, issue: number },
  `marker-less clarification comment; poster should be updated — issue=${repo}#${number}`,
);
// … existing timeline walk + `>= labelTime` scan …
```

`isStageStatusComment` (existing helper, lines 29–42) is reused verbatim. Stage-status exclusion applies to both passes — the marker registry includes `<!-- generacy-stage:clarification`, so a legitimate clarification-batch stage banner passes the marker check *and* passes `isStageStatusComment` (its override list already covers it — see the existing FR-007 test on line 113).

### D3 — Fallback emits exactly one warn per finder invocation (FR-005)

The warn fires only when pass 1 returns zero and pass 2 is about to execute. It does NOT fire when pass 1 succeeds and it does NOT fire per-comment. This keeps log volume bounded to one line per re-check on legacy issues, which is what the "measure how many issues still hit it" objective in Q2 needs.

The log message includes the issue coordinate (`repo` is already `owner/repo` in the call site) so operators can grep for stragglers.

Signature-wise, the finder gets no new args — the logger is a module-level singleton via `getLogger()`, matching the pattern in every other cockpit file (e.g., `clarify-relay.ts:19`, `resume.ts`).

### D4 — Do NOT collapse to marker-only (rejected: Q2 option A)

Clarification Q2 answer C explicitly rules out pure marker-only. Pre-marker legacy issues would start returning `null` and regress today's baseline. The fallback is literally today's code path — no new complexity — with one added log line. This is a bugfix, not a refactor, so preserving today's behavior on the fallback branch is the correct default.

### D5 — Do NOT add a heading-based matcher (rejected: Q1 options B/C)

Clarification Q1 answer A explicitly rejects finder-side `## ❓ Clarification questions — Batch N` recognition. The poster-side fix that makes every batch comment marker-tagged lives in a separate follow-up issue and is out of scope for this PR. Legacy marker-less batches fall through to `/cockpit:auto`'s existing `gh` degradation until they are re-posted or the poster fix lands.

### D6 — No changes to `context.ts` or the MCP tool surface (FR-008)

`context.ts:228` calls the finder unchanged and consumes `IssueComment | null` — no downstream schema change. The MCP `cockpit_context` tool contract is untouched.

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo. `CLAUDE.md`'s hard rules that apply here:

- **Changeset gate** (CLAUDE.md L14–L59): This diff touches `packages/generacy/src/`, so a **new** `.changeset/*.md` file with a `patch` bump for `@generacy-ai/generacy` is required (per `workflow:speckit-bugfix` convention, FR-007). File name: `995-cockpit-clarification-finder-marker.md`. Author must add it as part of the implement phase — the changeset is not test-only-exempt because `clarification-comment-finder.ts` is production source.
- **Small-scope discipline** (system prompt): no refactor beyond what the fix requires. Public signature unchanged; no new abstractions; no comments beyond the one-line warn header and any load-bearing "why" (e.g., a short comment above the marker-first pass noting it exists to survive re-labeling, since the *reason* is non-obvious from the code alone).

No conflicts.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Fallback log becomes noisy across all clusters. | Emit once per finder invocation (D3), not per comment. Track via log-scrape; remove fallback in a follow-up once poster-side fix lands and universal-marker coverage is confirmed. |
| Multi-batch tie-break wrong when two markers share `createdAt` down to the millisecond. | GitHub `createdAt` timestamps are unique per comment in practice (they carry seconds; identical seconds break the tie by whichever `sort` sees first — either is a valid "latest batch"). If future traffic breaks this, add a URL/id tiebreak. Out of scope now. |
| `isStageStatusComment` accidentally rejects a legitimate marker-carrying comment. | The existing override list already covers `generacy-stage:clarification` and `generacy-stage:clarification-batch-`; existing FR-007 test on line 113 guards this. New tests explicitly cover a marker-carrying comment that would otherwise trip a reject prefix (mirroring the existing FR-003 mixed-body case, line 163). |
| Import of `matchClarificationQuestionMarker` triggers a dep-cycle between `@generacy-ai/orchestrator` and `@generacy-ai/generacy`. | Not a new dep — `packages/generacy/package.json:46` already lists `@generacy-ai/orchestrator: workspace:*`, and other cockpit files (`resume.ts`, `gate-vocabulary.ts`, `clarification-answer-marker.ts`) already import from that package. No new edge introduced. |

## Test Plan

All under `packages/generacy/src/cli/commands/cockpit/__tests__/clarification-comment-finder.test.ts`.

### New tests (add)

1. **US1 primary path** — `returns marker-carrying comment even when label re-applied after the comment (regression for #995)`:
   fixture with `waiting-for:clarification` labeled at `T2` and one marker-carrying comment created at `T1 < T2`. Assert `c?.url` is the marker comment, not `null`.
2. **FR-002 latest batch** — `returns the latest-by-createdAt marker comment when multiple exist`:
   two comments each carrying `<!-- generacy-clarifications:` at column 0, `createdAt` T1 < T2. Assert `c?.url` is T2's comment.
3. **FR-005 fallback** — `falls back to label-timeline heuristic when no marker-carrying comment exists, and emits a warn log`:
   fixture with no marker-carrying comments but a comment created at-or-after the label event. Assert the timeline heuristic still returns that comment AND a warn log line was emitted. Use a `pino` transport stub or spy on `getLogger()` via `vi.spyOn` on the module-level logger returned by `getLogger()` (see how `resume.test.ts` handles it — falls back to a `vi.fn`-based logger injection if the current logger export isn't already spy-friendly, in which case bump `findClarificationComment` to accept an optional deps arg with a defaulted logger — kept as a fallback plan; preferred is a global-logger spy that mirrors the file's other cockpit tests).
4. **FR-005 fallback → null** — `returns null when no marker AND no post-label comment exists`:
   fixture identical to the existing "returns null when no qualifying comment exists" case (line 43) but explicitly assert the warn log fires exactly once.

### Existing tests (preserve, adjust wording if needed)

- Line 23 — first-comment-after-label case: fixture has no marker, so pass 1 misses and pass 2 (fallback) selects the same comment. Adjust expectation to accept a warn log fires; assertion on `c?.url` stays the same.
- Line 43 — no-qualifying-comment case: pass 1 misses, pass 2 misses; returns `null`. Warn fires once. Adjust if strict "no logs" was previously asserted (it isn't in the current test).
- Line 59 — no `waiting-for:clarification` label case: pass 1 misses (no marker), pass 2 returns `null` immediately because `latestLabelTs == null`. Warn fires once. Same adjustment consideration.
- Line 69 — most-recent-label case: no marker, fallback picks post-most-recent-label comment. Same as line 23 adjustment.
- Line 92 — stage-status planning-table case: no marker; fallback picks a comment that is rejected by `isStageStatusComment` → `null`.
- Line 113 — clarification-batch-1 comment: **carries a `generacy-stage:clarification-batch-` marker** which IS in `CLARIFICATION_QUESTION_MARKERS`. Pass 1 wins. No log. Test passes with primary path.
- Line 135 — planning-status + batch-1: batch-1 marker wins in pass 1 (planning-status has no marker and would be rejected anyway). No log. Passes.
- Line 163 — mixed-body override case: comment carries `generacy-stage:clarification-batch-2` — pass 1 wins. No log. Passes.
- Line 185 — speckit-stage:implementation stage-status: no marker; fallback runs; `isStageStatusComment` rejects the only candidate → `null`. Log fires once.
- Line 206 — quoted marker at `> `: the `>` prefix disqualifies the column-0 rule for BOTH the marker predicate (via `matchClarificationQuestionMarker`) AND the stage-status guard (via `isStageStatusComment`'s implicit `line.startsWith` on unquoted lines). Pass 1 misses; pass 2 returns the comment. Log fires once.

### Command

```bash
cd packages/generacy && pnpm test clarification-comment-finder
```

Green run required. SC-005 verified by hand: `git revert` the finder change; assert `US1 primary path` test fails.

## Rollout / Verification

- No feature flag, no config knob. Direct code change.
- **Manual verification** (SC-003): after merge, run `/cockpit:auto` against an issue whose `waiting-for:clarification` label has been re-applied post-question-comment (or fabricate one by re-applying the label via `gh issue edit`). Assert D.1 succeeds off the engine bundle without the `gh issue view` fallback path firing. Snappoll #8 scenario is the natural reproduction; the spec references it directly.
- **Log-scrape** (FR-005 measurement): after 1 snappoll cycle, count `marker-less clarification comment; poster should be updated` lines. Feeds into the poster-side follow-up issue's readiness gate for deleting the fallback.

## Out of Scope (mirrors spec)

- Poster-side companion PR (FR-004; tracked separately, landed independently).
- Answer-scanner / answer-monitor changes.
- Boot-resume / resume-loop / `waiting-for:clarification` lifecycle changes.
- Cross-repo / multi-issue clarification correlation.
- Any refactor of the finder's public signature.

## Next Step

`/speckit:tasks` — generate the ordered task list from this plan.

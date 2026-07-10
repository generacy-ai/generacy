# Implementation Plan: Marker-based exclusion in clarification answer-scanner + explainer copy fix (#909)

**Feature**: Introduce a dedicated marker-set module + `commentCarriesQuestionMarker` predicate. Wire it as the first branch of `isQuestionComment` (deleting the three inline `.includes()` calls) so the answer-scanner never treats an engine-authored questions comment as a candidate answer — trust-independently, before the trust check ever runs — and repair the "or confirm" explainer copy to name only the re-post remediation that actually exists.
**Branch**: `909-found-during-cockpit-v1`
**Status**: Complete

## Summary

The snappoll#4 fixture proved the answer-scanner will parse the engine's own `## ❓ Clarification Questions — Batch 1` comment (`<!-- generacy-stage:clarification-batch-1 -->` marker + `### Q<n>:` headings) as candidate answers, because `parseAnswersFromComments` never asked `isQuestionComment` and the FR-002 content sniff only catches the *formal* dialect with `**Question**:`/`**Context**:` markup. Today this is invisibly safe (the trust check rejects the batch — but posts a misleading explainer naming a `confirm` verb the codebase does not implement); the moment finding #52 lands (cluster identity trusted on the answer-scanner surface), the same mis-parse becomes *trusted* and the gate silently self-answers with question text.

This PR:

1. **Extracts a dedicated marker module** `packages/orchestrator/src/worker/clarification-markers.ts` exporting `CLARIFICATION_QUESTION_MARKERS` (four prefix strings — see FR-101 / clarify Q1→B) and `commentCarriesQuestionMarker(body)` (column-0 match per clarify Q3→B).
2. **Wires the predicate at the `parseAnswersFromComments` integration seam** (`integrateClarificationAnswers`, `clarification-poster.ts:643`) as an explicit pre-filter *before* the trust check runs — so FR-103's trust-independence is a property of the flow, not a coincidence.
3. **Delegates `isQuestionComment` marker branch to the new predicate** (clarify Q2→B / FR-109), deleting the three inline `.includes()` at `clarification-poster.ts:212–216`. Content-shape branches (`### Q<n>:` split + `**Question**:`/`**Context**:`/`**Options**:` + `## Clarification Questions` heading) stay untouched (FR-106).
4. **Adds one debug log line on marker exclusion** with the exact FR-107 shape (`event: 'clarification-answer-scanner-marker-excluded'`, `commentId`, `author`, `markerPrefix`, `issueNumber` — body never logged).
5. **Repairs the untrusted-answer explainer copy** at `clarification-poster.ts:542` — drops "or confirm the answers", names only the trusted-member re-post path (FR-104 / SC-005 / SC-006).
6. **Adds regression coverage at the integration seam, not just the predicate** (FR-110): the snappoll#4 fixture + author-association variants (OWNER/MEMBER/cluster-self) + the US4 quoted-marker path all exercise `integrateClarificationAnswers` or `parseAnswersFromComments`, not `commentCarriesQuestionMarker` in isolation. This is load-bearing — this finding exists precisely because `isQuestionComment` existed but was never called on the scan path.

FR-105's ordering constraint (ship before generacy-ai/generacy#910) is a merge-order discipline, not an in-code assertion — the code cannot enforce it, but the test-fixture author-association variants in SC-002 exercise the exact configuration #910 will land the cluster into.

## Technical Context

- **Language**: TypeScript (strict), ESM, Node ≥22
- **Packages touched**: `@generacy-ai/orchestrator` only. No cross-package lift (FR-108 explicitly parks that until a second package needs the predicate; #910 is orchestrator-side).
- **Runtime dependencies**: none new. Predicate is pure string operations.
- **No new npm deps, no new packages, no new logger surfaces** (FR-107 reuses the existing `Logger` interface at `packages/orchestrator/src/worker/types.ts`).
- **Marker semantics**: prefix substring, case-sensitive ASCII, matched at **column 0 of any line** (clarify Q1→B + Q3→B). `> ` block-quoted markers do not exclude (US4). `\n`-split; the four prefixes are stored as-is, no regex per marker.
- **Interaction with #842 comment-trust**: unchanged. Marker exclusion runs as a pre-filter over `answerComments`; comments dropped by the marker filter never reach the trust check, so they cannot produce a rejection explainer (this is exactly the harm — a "rejected answers" notice pointing at the engine's own questions).
- **Interaction with #910 (finding #52)**: this change lands first. When #910 later makes the cluster's own identity trusted on the answer-scanner surface, FR-103's trust-independence guarantee (proved by SC-002) is what prevents silent self-answer.

## Project Structure

Changes localize to `packages/orchestrator/src/worker/`. One new file, one modified file, one test file extended.

```
packages/orchestrator/src/worker/
├── clarification-markers.ts                            [ADD]  CLARIFICATION_QUESTION_MARKERS + commentCarriesQuestionMarker
├── clarification-poster.ts                             [MODIFY]
│                                                       - Import { commentCarriesQuestionMarker } from './clarification-markers.js'
│                                                       - isQuestionComment: replace lines 212–216 with a single call to the predicate (FR-109)
│                                                       - integrateClarificationAnswers: pre-filter `answerComments` on the predicate BEFORE the trust check (FR-102/FR-103), with the FR-107 debug log per excluded comment
│                                                       - postUntrustedAnswerExplainers: replace explainer body at line 541–542 — drop "or confirm the answers", name re-post only (FR-104)
└── __tests__/
    ├── clarification-markers.test.ts                    [ADD]  Predicate unit tests (all four dialects, column-0, quoted-marker, empty/no-marker)
    └── clarification-poster.test.ts                     [MODIFY]
                                                          - New describe: `parseAnswersFromComments — marker exclusion (SC-001..SC-004, SC-008)`
                                                          - New describe: `integrateClarificationAnswers — marker exclusion + trust independence`
                                                          - New describe: `untrusted-answer explainer copy (SC-005, SC-006)`
                                                          - New describe: `SC-007 — no hardcoded markers outside clarification-markers.ts`
                                                          - Extend existing `isQuestionComment` describe with delegation assertion

specs/909-found-during-cockpit-v1/
├── spec.md                                              [read-only]
├── clarifications.md                                    [read-only]
├── plan.md                                              [THIS FILE]
├── research.md                                          [ADD]
├── data-model.md                                        [ADD]
├── quickstart.md                                        [ADD]
└── contracts/
    ├── clarification-markers.md                         [ADD]  Predicate contract + marker set + column-0 rule
    └── answer-scanner-flow.md                           [ADD]  Order of ops in integrateClarificationAnswers post-fix
```

**Files NOT changing:**

- `packages/orchestrator/src/worker/types.ts` — `STAGE_MARKERS` (specification/planning/implementation) is a **posting-marker constant** for a different marker family (not clarifications). Explicitly out of scope per Q2→B and the spec's Out-of-Scope §.
- `packages/orchestrator/src/worker/clarification-poster.ts` `MARKER_PREFIX` (line 163) / `clarificationMarker()` — the **posting-marker** for the orchestrator's own dedup surface. Untouched — it's part of the marker set the exclusion covers, not something to replace. `MARKER_PREFIX` continues to exist as-is; `isQuestionComment` no longer references it directly (it flows through the predicate).
- `packages/orchestrator/src/worker/clarification-poster.ts` `parseAnswersFromComments` FR-002 content sniff (lines 478–489) — preserved verbatim as FR-106 belt-and-suspenders for unmarked question-shaped text.
- `postClarifications`'s own dedup logic (lines 755–765) — unchanged; it checks for `MARKER_PREFIX` / `cliMarkerPrefix` to skip re-posting, a different concern from answer-scanning.
- `@generacy-ai/workflow-engine` — no changes. `isTrustedCommentAuthor` still runs downstream of the marker filter; its behavior is untouched.
- `packages/generacy/src/cli/commands/cockpit/` — no changes. #910 will consume the FR-108 exports directly when it lands; this PR just makes them importable.

## Code changes in detail

### `packages/orchestrator/src/worker/clarification-markers.ts` (new)

```ts
/**
 * Central marker set for engine-authored clarification-question comments.
 *
 * The answer-scanner in `clarification-poster.ts` uses `commentCarriesQuestionMarker`
 * to skip these comments before parsing candidate `Q<n>:` answers.
 * `isQuestionComment` delegates to the same predicate for its marker branch.
 *
 * Adding a new engine dialect: append its stable HTML-comment prefix to
 * `CLARIFICATION_QUESTION_MARKERS`. No other file changes. This is FR-108's
 * "future marker additions land in one place" contract.
 *
 * Match rule (clarify Q1 → B, Q3 → B):
 *  - Prefix substring (case-sensitive, ASCII).
 *  - Line-anchored: only fires when the marker starts at column 0 of some line.
 *  - `> `-quoted markers therefore do NOT match — humans quoting the questions
 *    while answering (US4) still have their `Q<n>: <answer>` lines integrated.
 */
export const CLARIFICATION_QUESTION_MARKERS: readonly string[] = [
  '<!-- generacy-stage:clarification',       // e.g. `-->`, `-batch-1 -->`, future variants
  '<!-- generacy-clarifications:',           // orchestrator posting-marker family (issue-scoped)
  '<!-- generacy-clarification:',            // CLI-posting-marker family (batch-scoped)
  '<!-- generacy-cockpit:clarifications-batch:',
] as const;

/** Result of `commentCarriesQuestionMarker` used for FR-107 log emission. */
export interface MarkerMatch {
  readonly matched: true;
  readonly markerPrefix: string;
}

/**
 * True iff `body` contains one of the FR-101 markers at column 0 of some line.
 * Returns the specific `markerPrefix` that matched via `matchClarificationQuestionMarker`
 * so callers can emit the FR-107 log line without a second scan.
 */
export function commentCarriesQuestionMarker(body: string): boolean {
  return matchClarificationQuestionMarker(body) !== undefined;
}

export function matchClarificationQuestionMarker(body: string): string | undefined {
  // Split on `\n`; each element is a line (last may be empty).
  // A line "carries" a marker when it starts with (is prefixed by) any FR-101 prefix.
  // Column-0 is enforced by `startsWith` — leading whitespace or `> ` disqualifies the line.
  for (const line of body.split('\n')) {
    for (const prefix of CLARIFICATION_QUESTION_MARKERS) {
      if (line.startsWith(prefix)) return prefix;
    }
  }
  return undefined;
}
```

Rationale for splitting `commentCarriesQuestionMarker` (boolean) from `matchClarificationQuestionMarker` (prefix): the caller in `integrateClarificationAnswers` needs the prefix for the FR-107 log line, while `isQuestionComment` only needs the boolean. Both helpers use the same single-pass split; there is no correctness or perf duplication.

### `packages/orchestrator/src/worker/clarification-poster.ts` — modifications

#### Import (top of file)

```ts
import {
  commentCarriesQuestionMarker,
  matchClarificationQuestionMarker,
} from './clarification-markers.js';
```

#### `isQuestionComment` (line 210) — FR-109 delegation

Replace lines 211–216 (the three `body.includes(...)` marker checks) with:

```ts
export function isQuestionComment(body: string): boolean {
  // FR-101 / FR-108 / FR-109 — engine-authored questions markers.
  // Delegated to the single-source predicate; adding a new dialect only touches
  // `clarification-markers.ts`.
  if (commentCarriesQuestionMarker(body)) return true;
  // Content-shape branches (FR-106 — belt-and-suspenders for unmarked bodies).
  if (/##\s+(?!Answers\b).*Clarification Questions/.test(body)) return true;
  for (const section of splitByQuestionHeading(body)) {
    if (
      section.includes('**Question**:') ||
      section.includes('**Context**:') ||
      section.includes('**Options**:')
    ) {
      return true;
    }
  }
  return false;
}
```

Note: the pre-existing `MARKER_PREFIX = '<!-- generacy-clarifications:'` constant (line 163) is still used by `clarificationMarker()` (posting) and by `postClarifications()`'s own-marker dedup — those call sites are unrelated to `isQuestionComment` and stay. `CLARIFICATION_QUESTION_MARKERS[1]` in the new file happens to equal `MARKER_PREFIX` (both are `'<!-- generacy-clarifications:'`); this is intentional and stable — the exclusion set is a superset of the posting-marker set.

#### `integrateClarificationAnswers` (line 568) — pre-filter + log

At line 643 today:

```ts
const answerComments = trustedComments.filter((c) => !isQuestionComment(c.body));
```

Change to a two-stage filter that runs **before** the trust check (FR-102 / FR-103):

```ts
// FR-102: filter engine-authored questions BEFORE the trust check.
// The trust filter must never receive an engine questions comment as input —
// under #910 the cluster's own identity is trusted, and the trust check would
// wave those through to the parser.
const scanCandidates: TrustComment[] = [];
for (const c of comments) {
  const markerPrefix = matchClarificationQuestionMarker(c.body);
  if (markerPrefix !== undefined) {
    // FR-107 — steady-state exclusion; debug level (Q5 → B).
    logger.debug(
      {
        event: 'clarification-answer-scanner-marker-excluded',
        commentId: c.id,
        author: c.author,
        markerPrefix,
        issueNumber,
      },
      'Excluded from answer-scanner via question marker',
    );
    continue;
  }
  scanCandidates.push(c);
}

// 3a. Author-trust gating (#842) — now runs on the marker-filtered set.
// ... existing trust loop, but iterating `scanCandidates` instead of `comments`.
```

The subsequent `answerComments = trustedComments.filter(...isQuestionComment...)` line collapses to `answerComments = trustedComments` — the content-shape sniff inside `parseAnswersFromComments` (FR-106) still catches unmarked question-shaped bodies. Leaving a redundant `!isQuestionComment(c.body)` filter here would double-fire the delegation, wasted work but not wrong; the cleaner path is to trust the pre-filter and drop the redundant call.

**Ordering** — critical for FR-103:

```
comments (raw)
   │
   ▼
FR-102 marker pre-filter ────▶ excluded + debug-logged (FR-107)
   │
   ▼
scanCandidates
   │
   ▼
isTrustedCommentAuthor (#842)
   │           │
   ▼           ▼
 trusted    untrusted → postUntrustedAnswerExplainers (repaired copy)
   │
   ▼
parseAnswersFromComments (FR-106 content sniff still runs inside)
```

Marker exclusion happens BEFORE trust so:
- Trust-independence (FR-103): the marker filter doesn't care what `authorAssociation` says.
- No `postUntrustedAnswerExplainers` call fires on a comment the engine authored — the "rejected answers" harm from the observed snappoll#4 flow is structurally impossible.
- The FR-107 debug log's `author` field will (correctly) be the bot on healthy cycles, and would be the same bot even after #910 makes it trusted.

#### `postUntrustedAnswerExplainers` (line 517) — copy fix (FR-104, SC-005, SC-006)

At line 541–542:

```ts
const body = `${marker}
> Answers from @${c.author} were not applied (association tier: \`${tier}\`). A trusted member (OWNER/MEMBER/COLLABORATOR) must post or confirm the answers.`;
```

Replace with:

```ts
const body = `${marker}
> Answers from @${c.author} were not applied (association tier: \`${tier}\`). A trusted member (OWNER/MEMBER/COLLABORATOR) must re-post the answers themselves in the \`Q1: <answer>\` format for the batch to integrate.`;
```

The `re-post` phrasing (a) names the exact remedy that works, (b) names the exact format (`Q1: <answer>`) matching the "How to answer" block in `formatComment` (line 349), (c) has zero substring overlap with "confirm" or any confirm-verb variant (`confirm`, `confirms`, `confirmed`, `confirmation`). SC-005's grep guard passes by construction.

Note: the `${marker}` prefix (the `<!-- generacy-untrusted-answer:<id> -->` idempotence marker) is unrelated to FR-101 and stays.

### Test file changes

#### `packages/orchestrator/src/worker/__tests__/clarification-markers.test.ts` (new)

Predicate-only unit tests, ~80–120 lines:

- All four dialects at column 0 → `true`
- `-batch-1` variant → `true` (prefix-substring rule, clarify Q1→B)
- Unrelated marker (e.g., `<!-- generacy-untrusted-answer:5 -->`) → `false`
- `> <!-- generacy-stage:clarification -->` (quoted) → `false` (column-0, clarify Q3→B)
- `  <!-- generacy-stage:clarification -->` (leading whitespace) → `false` (column-0)
- Marker on any line, not just first → `true`
- Empty body → `false`
- `matchClarificationQuestionMarker` returns the exact prefix that matched (verified per dialect)

#### `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts` (extend)

Four new `describe` blocks — the important one is the integration-seam block per FR-110:

1. **`parseAnswersFromComments — marker exclusion (SC-001..SC-004, SC-008)`**
   - Snappoll#4 fixture (`<!-- generacy-stage:clarification-batch-1 -->` + `### Q<n>: <topic>` + prose bodies, no bold markers): `parseAnswersFromComments(fixture)` returns `[]` (SC-001).
   - Same fixture with author association forced to `OWNER` / `MEMBER` / cluster-self bot login → still `[]` (SC-002 trust independence, but note this test operates on `parseAnswersFromComments` which is post-trust; the true trust independence test lives in the next block).
   - `Q1: A\nQ2: B` with no marker → 2 answers (SC-003).
   - Human quoted-marker fixture (`> <!-- generacy-stage:clarification -->\n> ### Q1: Topic\n\nQ1: A\nQ2: B`) → 2 answers (SC-004 / US4).
   - Debug log spy: exactly one line per excluded comment, shape asserted (SC-008).

2. **`integrateClarificationAnswers — marker exclusion + trust independence (FR-102, FR-103, FR-110)`** *(the load-bearing one)*
   - Mock `github.getIssueComments` to return the snappoll#4 fixture; `checkoutPath` has a real `clarifications.md` with 2 pending Q's; `isTrustedCommentAuthor` mock is asserted to receive `scanCandidates` (the marker-filtered set), not the raw `comments` array.
   - Assert `integrated: 0, reason: 'no-answers'` (or equivalent no-integration outcome).
   - Assert `github.addIssueComment` was NOT called with any body containing "not applied" / "association tier" — i.e., no explainer posted for engine-authored questions.
   - Repeat with `isTrustedCommentAuthor` mocked to `{ trusted: true, reason: 'owner' }` for the bot author → still `integrated: 0`, still no answers written to the file, still no explainer. This is the FR-103 assertion — trust doesn't matter, marker does.

3. **`untrusted-answer explainer copy (SC-005, SC-006, FR-104)`**
   - Trigger the explainer path with a genuinely-untrusted human posting `Q1: A`.
   - Assert `addIssueComment` was called with a body that: (a) contains `must re-post` (or the exact wording chosen — string-literal snapshot), (b) contains no substring `confirm`/`Confirm`/`confirms`/`confirmed`/`confirmation`, (c) names `OWNER/MEMBER/COLLABORATOR` (regression on unchanged half of the sentence).

4. **`SC-007 — no hardcoded markers outside clarification-markers.ts (lint-style)`**
   - Read `packages/orchestrator/src/worker/*.ts` (excluding `clarification-markers.ts` and the `__tests__/` directory) at test time via `readdirSync`/`readFileSync`.
   - For each FR-101 marker prefix, assert no occurrence in any file. Skip the file being audited itself. This is a source-level grep run inside the test suite (it works because vitest tests run under the same file system).

5. **Delegation assertion inside existing `isQuestionComment` describe**
   - `vi.mock('../clarification-markers.js', ...)` with a spy on `commentCarriesQuestionMarker`; assert `isQuestionComment('<!-- generacy-clarifications:42 -->')` calls the spy. Guards against future refactors re-inlining the check.

## Constitution check

No project-level constitution file (`.specify/memory/constitution.md`) exists. Implicit cross-checks:

- **Zod-only external validation** — n/a; predicate consumes strings, no boundary crossing.
- **No secret in logs** — FR-107 explicitly forbids body in the log (SC-008 asserts). `commentId`, `author`, `markerPrefix`, `issueNumber` are all non-secret metadata already emitted elsewhere by this file.
- **Fail-loud on internal boundary errors** — n/a; the predicate cannot fail (pure string ops). The marker filter has no error path.
- **No new npm dependencies** — confirmed; only `node:` intrinsics + existing intra-package imports.
- **Types-only imports** — `import type` for logger where possible; the predicate module has zero type-only imports (pure runtime).
- **File-size discipline** — new module is ~30 lines including comments; `clarification-poster.ts` net delta is roughly `-5 + 15` LOC (delete 3 `.includes()`, add 1 predicate call; add ~15 LOC for the pre-filter loop + log).

## Rollout notes

- **No config, no migration, no schema change.** All changes are in-process TypeScript.
- **Backward compatibility of the predicate**: the marker set is a superset of every dialect currently observed emitting; no existing engine-authored comment stops being excluded, and the column-0 rule (clarify Q3→B) is strictly more permissive for humans (US4 quoted-marker path now integrates instead of being silently dropped — this is a strict improvement over any prior sniff that would have caught quoted markers).
- **Debug log volume**: exclusion fires once per engine questions comment per poll cycle. At the default clarify poll cadence (see `LabelMonitorService`), a healthy cluster with one open clarify gate emits ~1 debug line per poll interval. Info level would be wrong (clarify Q5→B); debug is invisible under standard prod log filters.
- **Coordinate with #910 / generacy-ai/generacy#910**: this PR lands first per FR-105. The two together (marker exclusion + bot-trust) are safe; either alone is either broken (bot-trust alone → silent self-answer) or misleading (marker exclusion alone → the bot-authored questions never make it to the trust check, so the misleading "rejected answers" explainer stops firing on those comments — which is exactly the harm being fixed on this side).
- **Cross-repo constitution**: none. `MARKER_PREFIX` in `clarification-poster.ts` (line 163) remains as the posting-marker for `postClarifications`; explicit non-goal is unifying it with `CLARIFICATION_QUESTION_MARKERS` (both are stable, both live in-package, and the posting-vs-exclusion families are semantically distinct).

## Suggested next step

`/speckit:tasks` to generate the task list from this plan.

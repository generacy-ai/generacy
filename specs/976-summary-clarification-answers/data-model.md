# Data Model: Same-account clarification answers (#976)

Scope: no persisted data, no wire schema, no MCP tool schema, no cross-process message shape changes. Everything here is in-process TypeScript.

## New exports (in `packages/orchestrator/src/worker/clarification-markers.ts`)

### `MACHINE_MARKERS`

```ts
/**
 * #976 — canonical set of engine-authored comment marker prefixes that the
 * clarification answer scanner MUST NOT treat as candidate answer sources.
 *
 * Superset of `CLARIFICATION_QUESTION_MARKERS`. Every cluster-emitted machine
 * comment family carries a prefix from this list; anything else (including
 * plain-text same-account `Q<n>:` replies from a developer running the
 * cluster under their own GitHub credentials) flows through the trust helper
 * per the normal FR-006 permissive path.
 *
 * Match rule (identical to `CLARIFICATION_QUESTION_MARKERS`):
 *  - Prefix substring, case-sensitive ASCII.
 *  - Line-anchored: only fires when the prefix starts at column 0 of some line.
 *  - `> `-quoted markers do NOT match — humans quoting a machine comment
 *    while answering still have their plain-text `Q<n>:` lines integrated.
 */
export const MACHINE_MARKERS: readonly string[] = [
  ...CLARIFICATION_QUESTION_MARKERS,        // question-family (existing)
  '<!-- generacy-stage:specification',
  '<!-- generacy-stage:planning',
  '<!-- generacy-stage:implementation',
  '<!-- speckit-stage:specification',
  '<!-- speckit-stage:planning',
  '<!-- speckit-stage:implementation',
  '<!-- generacy-cockpit:manual-advance',
  '<!-- generacy-clarification-answers:',
  '<!-- generacy-untrusted-answer:',
  '<!-- generacy-clarification-parse-failures:',
] as const;
```

**Superset invariant**: `MACHINE_MARKERS` starts with the spread `...CLARIFICATION_QUESTION_MARKERS` so future additions to the question family propagate automatically. A structural test in `clarification-machine-markers.test.ts` asserts every question-family prefix appears in `MACHINE_MARKERS`.

**Duplication note**: `<!-- generacy-clarification-answers:` also appears in the existing `CLARIFICATION_ANSWER_MARKERS` constant (retained for test compatibility per research §Decision 6). This is intentional and lockstep; both must be updated together if the answer-marker prefix is ever renamed. The `MACHINE_MARKERS` entry is authoritative for scanner behavior; `CLARIFICATION_ANSWER_MARKERS` is retained only for its export surface until the marker-relay tool is deleted (follow-up).

### `commentCarriesMachineMarker(body: string): boolean`

```ts
export function commentCarriesMachineMarker(body: string): boolean {
  return matchMachineMarker(body) !== undefined;
}
```

### `matchMachineMarker(body: string): string | undefined`

```ts
export function matchMachineMarker(body: string): string | undefined {
  for (const line of body.split('\n')) {
    for (const prefix of MACHINE_MARKERS) {
      if (line.startsWith(prefix)) return prefix;
    }
  }
  return undefined;
}
```

Returns the specific matched prefix (identity from `MACHINE_MARKERS`) for structured logging at the two call sites. `undefined` when nothing matches. Copied byte-for-byte from `matchClarificationQuestionMarker` with only the constant name changed.

## Unchanged exports

### `CLARIFICATION_QUESTION_MARKERS`, `commentCarriesQuestionMarker`, `matchClarificationQuestionMarker`

Retained. Consumed by `clarification-poster.ts::isQuestionComment` for the "is this a question post at all" test (a narrower question that MACHINE_MARKERS' broader "is this any machine comment" would over-match). Also consumed by `packages/generacy/src/cli/commands/cockpit/clarification-comment-finder.ts` semantics-wise (via its own inline list, not a direct import — see Risk R-2 in `plan.md`).

### `CLARIFICATION_ANSWER_MARKERS`, `commentCarriesAnswerMarker`, `matchClarificationAnswerMarker`

Retained at the export level with no runtime callers post-fix. Test imports at `clarification-poster-trust.test.ts:279-289` and `clarification-self-answer.test.ts` (via `clarificationMarker(7)`) keep the symbols alive. Deletion tracked as a follow-up alongside the marker-relay tool.

## Modified in-process state

### `packages/orchestrator/src/services/clarification-answer-monitor-service.ts`

Import at L42:

```ts
// Before:
import { commentCarriesAnswerMarker } from '../worker/clarification-markers.js';

// After:
import { commentCarriesMachineMarker } from '../worker/clarification-markers.js';
```

Loop body at L198-209:

```ts
// Before:
for (const c of comments) {
  if (c.viewerDidAuthor === true) continue;
  if (commentCarriesAnswerMarker(c.body)) continue;
  const decision = isTrustedCommentAuthor(c, 'answer-scanner', trustCtx);
  if (decision.trusted) { hasHumanTrustedComment = true; break; }
}

// After:
for (const c of comments) {
  if (commentCarriesMachineMarker(c.body)) continue;
  const decision = isTrustedCommentAuthor(c, 'answer-scanner', trustCtx);
  if (decision.trusted) { hasHumanTrustedComment = true; break; }
}
```

Nothing else in the file changes. `ClarificationAnswerEvent`, `ClarificationAnswerMonitorOptions`, class shape, adaptive-polling logic, and the entire polling loop are untouched.

### `packages/orchestrator/src/worker/clarification-poster.ts`

Import at L11-23 (the `clarification-markers` import group):

```ts
// Before:
import {
  commentCarriesQuestionMarker,
  matchClarificationQuestionMarker,
  commentCarriesAnswerMarker,
} from './clarification-markers.js';

// After:
import {
  commentCarriesQuestionMarker,       // still used by isQuestionComment
  matchMachineMarker,                  // new — pre-filter
} from './clarification-markers.js';
```

Delete `matchClarificationQuestionMarker` and `commentCarriesAnswerMarker` from the import — grep confirms no other reference in this file after the disjunction deletion below.

Pre-filter at L853-870:

```ts
// Before:
for (const c of comments) {
  const markerPrefix = matchClarificationQuestionMarker(c.body);
  if (markerPrefix !== undefined) {
    logger.debug({
      event: 'clarification-answer-scanner-marker-excluded',
      commentId: c.id,
      author: c.author,
      markerPrefix,
      issueNumber,
    }, 'Excluded from answer-scanner via question marker');
    continue;
  }
  scanCandidates.push(c);
}

// After:
for (const c of comments) {
  const markerPrefix = matchMachineMarker(c.body);
  if (markerPrefix !== undefined) {
    logger.debug({
      event: 'clarification-answer-scanner-marker-excluded',
      commentId: c.id,
      author: c.author,
      markerPrefix,
      issueNumber,
    }, 'Excluded from answer-scanner via machine marker');
    continue;
  }
  scanCandidates.push(c);
}
```

Answer-comment assembly at L916-936:

```ts
// Before:
const answerComments: TrustComment[] = [];
for (const c of trustedComments) {
  if (c.viewerDidAuthor === true) {
    if (commentCarriesAnswerMarker(c.body)) {
      answerComments.push(c);
    } else {
      logger.debug({
        event: 'clarification-answer-scanner-self-unmarked',
        commentId: c.id,
        author: c.author,
        issueNumber,
      }, 'Skipped cluster-self comment lacking engine-written answer marker (FR-003)');
    }
  } else {
    answerComments.push(c);
  }
}

// After:
const answerComments: TrustComment[] = trustedComments;
```

The FR-004 fail-close (L951-988) is UNCHANGED. Its discriminator (`parsed.sourceViewerDidAuthor === true`) lives inside the parsed answer object and gates only the abort-vs-skip decision for a comment that spuriously matched `### Q<n>:` heading shape — it is not an authorship gate on candidacy.

## No changes required

- `packages/workflow-engine/src/comment-trust.ts` — trust semantics unchanged. `self-authored → trusted` (L122) is the load-bearing behavior this fix relies on.
- `packages/workflow-engine/src/index.ts` — no new re-exports.
- `packages/orchestrator/src/worker/phase-loop.ts` — `renderClarificationParseFailuresComment` (L1168) unchanged; it already covers FR-007 for both same-account and different-account parse failures.
- `packages/orchestrator/src/worker/clarification-markers.ts::isQuestionComment` (if present) or any other callers of the question-only surface — unchanged.

## Validation rules

- `MACHINE_MARKERS` — no runtime validation; the constant is `readonly` and construction-time correct. A vitest structural test asserts:
  - every entry is a non-empty string starting with `'<!-- generacy-'` or `'<!-- speckit-'`;
  - `CLARIFICATION_QUESTION_MARKERS.every(m => MACHINE_MARKERS.includes(m))`;
  - no entry is a prefix of another entry (guards against a future addition that would over-match); ordering is documented but not asserted.

- Match rule invariants (asserted structurally):
  - `matchMachineMarker('> <!-- generacy-stage:planning ... -->')` returns `undefined` (column-0 rule).
  - `matchMachineMarker('   <!-- generacy-stage:planning ... -->')` returns `undefined` (leading whitespace disqualifies).
  - `matchMachineMarker('Some prose about generacy-clarifications: is not a marker')` returns `undefined` (no `<!--` prefix).
  - `matchMachineMarker('<!-- generacy-stage:planning batch=1 -->')` returns `'<!-- generacy-stage:planning'` (identity match).

## Relationships

```
clarification-markers.ts
  ├── CLARIFICATION_QUESTION_MARKERS  (unchanged)
  ├── CLARIFICATION_ANSWER_MARKERS    (unchanged; lockstep with MACHINE_MARKERS entry)
  └── MACHINE_MARKERS                 (NEW — superset via spread)

clarification-answer-monitor-service.ts (monitor)
  └── imports commentCarriesMachineMarker → pre-filters comments before isTrustedCommentAuthor

clarification-poster.ts (phase-loop scanner)
  ├── imports matchMachineMarker → pre-filters comments before trust check
  └── imports commentCarriesQuestionMarker → still used by isQuestionComment (unaffected surface)

comment-trust.ts (unchanged)
  └── self-authored → trusted (this is what makes the fix work)
```

## Serialization

Nothing in this feature is persisted. `MACHINE_MARKERS` is a compile-time constant. No cluster restart or migration concerns.

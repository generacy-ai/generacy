# Quickstart: #909 marker-based exclusion

## What this change does

Prevents the clarification answer-scanner from ever treating an engine-authored **questions** comment (e.g. a batch marker + `### Q<n>:` headings, no answer bodies) as a source of candidate **answers**. Also repairs the untrusted-answer explainer copy to name only the trusted-member re-post remediation that actually exists — no more "or confirm the answers" (there is no confirm mechanism in the codebase).

## Files touched

- **Added**: `packages/orchestrator/src/worker/clarification-markers.ts`
- **Added**: `packages/orchestrator/src/worker/__tests__/clarification-markers.test.ts`
- **Modified**: `packages/orchestrator/src/worker/clarification-poster.ts` (small, surgical)
- **Modified**: `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts` (new describes for SC-001..SC-008)

## Install / build

Standard monorepo dance:

```bash
pnpm install
pnpm --filter @generacy-ai/orchestrator build
```

Nothing new to configure; no env vars, no schema, no migration.

## Running the tests

```bash
# Predicate-only unit tests
pnpm --filter @generacy-ai/orchestrator test clarification-markers.test.ts

# Full clarification-poster suite (existing + new integration-seam tests)
pnpm --filter @generacy-ai/orchestrator test clarification-poster.test.ts

# Both
pnpm --filter @generacy-ai/orchestrator test 'clarification-*.test.ts'
```

The FR-110-required assertions live in `clarification-poster.test.ts` under:

- `describe('parseAnswersFromComments — marker exclusion (SC-001..SC-004, SC-008)')`
- `describe('integrateClarificationAnswers — marker exclusion + trust independence (FR-102, FR-103, FR-110)')`
- `describe('untrusted-answer explainer copy (SC-005, SC-006, FR-104)')`
- `describe('SC-007 — no hardcoded markers outside clarification-markers.ts')`

## Reproducing the observed failure (pre-fix regression fixture)

Snappoll#4 comment 4938943909 is the canonical fixture. In the test:

```ts
const SNAPPOLL_4_QUESTIONS_COMMENT: TrustComment = {
  id: 4938943909,
  author: 'generacy-ai[bot]',
  authorAssociation: 'NONE',
  body: `<!-- generacy-stage:clarification-batch-1 -->
## ❓ Clarification Questions — Batch 1

### Q1: Marker match semantics
<question prose here — no **Question**: / **Context**: markup>

### Q2: Relationship with existing isQuestionComment marker checks
<question prose here>

### Q3: Quoted-marker edge case
<question prose here>

### Q4: Constant location and export shape
<question prose here>`,
};
```

Assertion:

- `parseAnswersFromComments([SNAPPOLL_4_QUESTIONS_COMMENT], [1,2,3,4], logger)` returns `new Map()` (SC-001).
- Same with `authorAssociation: 'OWNER'` → still empty (SC-002; parses at integration-seam post-marker-filter).
- `logger.debug` was called exactly once with the FR-107 shape (SC-008).

## Interacting with the change at runtime

There is no runtime CLI or UI surface. The predicate is an internal helper. The observable behavior change from outside:

1. **Clarify gate on a fresh App-auth cluster with `<!-- generacy-stage:clarification-batch-N -->` questions comments**: the gate no longer surfaces a misleading "rejected answers" explainer against the bot's own questions. It also does not silently self-answer (protection lasts through the arrival of generacy-ai/generacy#910).
2. **Untrusted human posts `Q1: A`**: still gets the explainer, but the body now says `must re-post the answers themselves in the \`Q1: <answer>\` format for the batch to integrate` — no `confirm` verb.
3. **Trusted human quotes the questions comment and adds `Q1: A / Q2: B` below**: answers integrate normally (US4 — was the silent-drop failure mode under any "match marker anywhere" implementation).

## Debug logging

To watch marker exclusion in a running cluster (assumes pino JSON logs):

```bash
docker compose logs -f orchestrator | grep clarification-answer-scanner-marker-excluded
```

Each excluded comment emits one JSON line per poll cycle. On a healthy epic with one active clarify gate this is ~1 line per interval — expected steady state, not signal.

## Ordering with #910 (FR-105)

**Land this PR first.** #910 makes the cluster's own identity trusted on the answer-scanner surface. Without the marker exclusion, that unlocks silent self-answer: the trust check waves the questions comment through, the parser eats the topic text as answers, no human in the loop. This PR is the marker exclusion; it must be merged and released before #910's App-identity change lands in the same cluster image.

The regression coverage in this PR (SC-002 — trust-independence assertion at the integration seam) exercises the exact configuration #910 will land the cluster into.

## Troubleshooting

| Symptom | Likely cause | Remedy |
|---|---|---|
| Test `SC-007` fails naming `isQuestionComment` | Inline `.includes()` calls at lines 212–216 not deleted after FR-109 delegation | Delete the three inline calls; keep only the `commentCarriesQuestionMarker` call and the content-shape branches. |
| Test `SC-001` fails on the `-batch-1` variant | Marker match uses exact-string containment instead of prefix-substring | Change to `startsWith` per line against `CLARIFICATION_QUESTION_MARKERS` (clarify Q1→B). |
| Test `SC-004` fails on quoted-marker human reply | Marker predicate matches substring anywhere, not column-0 only | Enforce column-0: `line.startsWith(prefix)` after `body.split('\n')` (clarify Q3→B). |
| Test `SC-005` fails on the string `confirms` | Explainer body still has a `confirm`-family word | Grep the entire `postUntrustedAnswerExplainers` body for `/confirm/i` before shipping. |
| Debug log line missing / wrong shape | Log emission site is inside the trust-check branch instead of the pre-filter | Move the `logger.debug` inside the pre-filter loop, use the prefix returned by `matchClarificationQuestionMarker`. |
| Cluster still surfaces "rejected answers" explainer on the bot's own questions | Pre-filter runs after the trust check | Move the marker filter to run against the raw `comments` array before `isTrustedCommentAuthor` — see `contracts/answer-scanner-flow.md` §"Order of operations". |

## Non-goals recap

Not doing (spec Out of Scope §):

- Adding a `confirm` affordance (would require UI/protocol surface).
- Lifting the marker set to `@generacy-ai/workflow-engine` (defer until a second package needs it).
- Refactoring `MARKER_PREFIX` posting-marker (separate family, stays put).
- Anything from generacy-ai/generacy#910 (finding #52) — that PR is downstream and lands after this one.

## Suggested next step

`/speckit:tasks` to generate the task list.

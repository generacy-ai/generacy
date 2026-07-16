# Contract: `findClarificationComment` content guard

**Owner file**: `packages/generacy/src/cli/commands/cockpit/clarification-comment-finder.ts`
**Test file**: `packages/generacy/src/cli/commands/cockpit/__tests__/clarification-comment-finder.test.ts`
**Spec references**: FR-001 through FR-008, SC-001 through SC-003.

## Function signature (unchanged)

```ts
export async function findClarificationComment(
  gh: GhWrapper,
  repo: string,
  number: number,
): Promise<IssueComment | null>;
```

## Behavioural contract

### Selection algorithm (spec §Summary + FR-005)

1. Walk `gh.fetchIssueTimeline(repo, number)`; take the max `created_at` across events where `event === 'labeled'` and `label.name === 'waiting-for:clarification'`. Call this `labelTs`.
2. If no such event exists, return `null`.
3. If `Date.parse(labelTs)` is `NaN`, return `null`.
4. Fetch `gh.fetchIssueComments(repo, number)`; sort ascending by `Date.parse(createdAt)`.
5. For each comment `c` in sorted order:
   - Skip if `Date.parse(c.createdAt) < labelTs` (unchanged existing behaviour).
   - **NEW**: skip if `isStageStatusComment(c.body) === true` (FR-001, FR-002, FR-003 — see guard rule below).
   - Otherwise return `c`.
6. If the loop exhausts, return `null` (FR-004).

### Guard rule: `isStageStatusComment(body: string): boolean`

Body is a "stage-status comment" and MUST be skipped iff:

- At least one line of `body.split('\n')` startsWith one of the six FR-002 reject prefixes:
  - `<!-- generacy-stage:planning`
  - `<!-- generacy-stage:specification`
  - `<!-- generacy-stage:implementation`
  - `<!-- speckit-stage:planning`
  - `<!-- speckit-stage:specification`
  - `<!-- speckit-stage:implementation`
- AND no line of `body.split('\n')` startsWith either of the two FR-003 override prefixes:
  - `<!-- generacy-stage:clarification`
  - `<!-- generacy-stage:clarification-batch-`

Match rule invariants:
- **Column-0 line-anchored.** `line.startsWith(prefix)` where lines come from `body.split('\n')`. Leading whitespace on a line (including `> ` quote markers) disqualifies the match in both directions.
- **Case-sensitive ASCII.** No case-folding, no Unicode normalization. Mirrors `commentCarriesQuestionMarker` exactly.
- **Order-independent within a body.** The override may appear before or after the reject marker; the guard's override-first pass handles both orderings.
- **Author-agnostic.** `IssueComment.author` is not consulted. `gh.getCurrentUser()` is not called (Q2/A).

## Truth table

| Body carries at column 0 (any line) | Return |
|-|-|
| No reject marker, no override marker | Comment is returned (unchanged from today). |
| Reject marker only | Comment is **skipped** (new behaviour — FR-001). Loop continues. |
| Override marker only | Comment is returned (FR-003 does not fire; no reject to override). |
| Reject marker AND override marker | Comment is returned (FR-003 override wins — Q1/B). |
| Quoted (`> `-prefix) reject marker only | Comment is returned (column-0 rule; quoted markers never match). |
| Reject marker AND `> `-quoted override | Comment is **skipped** (override must be at column 0 to fire; quoted override does not count). |

## Regression test contract

### FR-006 (SC-001 pin)

- **Setup:** timeline has one `waiting-for:clarification` label at `T`. Comments has one entry with `createdAt = T + 1min`, `body = '<!-- generacy-stage:planning -->\n\n<status table>'`.
- **Assertion:** `findClarificationComment` returns `null`.
- **Regression proof:** MUST be RED against the current (pre-guard) finder. MUST be GREEN after the finder change.

### FR-007

- **Setup:** timeline has one `waiting-for:clarification` label at `T`. Comments has one entry with `createdAt = T + 1min`, `body = '<!-- generacy-stage:clarification-batch-1 -->\n\n## Clarifications\n\n### Q1: …'`.
- **Assertion:** `findClarificationComment` returns that comment (by `url`).
- **Guards against:** a naïve `startsWith('<!-- generacy-stage:')` regression.

### FR-008

- **Setup:** timeline has one `waiting-for:clarification` label at `T`. Comments has two entries at `T + 1min` and `T + 2min`; first is a `<!-- generacy-stage:planning -->` table, second is a `<!-- generacy-stage:clarification-batch-1 -->` batch.
- **Assertion:** `findClarificationComment` returns the second comment (later `createdAt`, but earliest survivor).
- **Documents:** "skip and keep scanning" (FR-005).

### FR-003 mixed-body

- **Setup:** timeline has one `waiting-for:clarification` label at `T`. Comments has one entry at `T + 1min` with a body carrying BOTH `<!-- generacy-stage:planning -->` on line 1 AND `<!-- generacy-stage:clarification-batch-2 -->` on line 3.
- **Assertion:** `findClarificationComment` returns that comment.
- **Locks in:** Q1/B override-wins decision.

### FR-002 speckit-legacy parity

- **Setup:** timeline has one `waiting-for:clarification` label at `T`. Comments has one entry at `T + 1min` with `body = '<!-- speckit-stage:implementation -->\n\n<status table>'`.
- **Assertion:** `findClarificationComment` returns `null`.
- **Confirms:** the legacy `speckit-stage:*` prefixes are honoured.

### D7 quoted-marker safety

- **Setup:** timeline has one `waiting-for:clarification` label at `T`. Comments has one entry at `T + 1min` with `body = '> <!-- generacy-stage:planning -->\n\nQ1: my answer'` (leading `> ` quote).
- **Assertion:** `findClarificationComment` returns that comment.
- **Confirms:** the column-0 rule holds inline in the guard — a quoted marker does not trigger the reject.

## Non-goals (spec §Out of Scope)

- The guard does NOT validate that the returned comment carries any *positive* signal (no `Q<n>:` structure check, no clarification-question-marker requirement). A comment carrying neither a stage-status reject marker nor any clarification marker is returned as-is (matches today's behaviour for human-authored comments).
- The guard does NOT modify the label-timing branch (timeline walk, latest-label selection, `createdAt >= labelTs` gate).
- The guard does NOT touch `clarification-poster.ts`, `clarification-markers.ts`, or `STAGE_MARKERS` in `packages/orchestrator/src/worker/types.ts`.

## SC-003 verification

Diffed files in the PR (excluding test-only edits) MUST be exactly:

- `packages/generacy/src/cli/commands/cockpit/clarification-comment-finder.ts` (production code)
- `.changeset/962-*.md` (mandatory changeset)

Diffed files including test-only edits add:

- `packages/generacy/src/cli/commands/cockpit/__tests__/clarification-comment-finder.test.ts`

`git diff --stat origin/develop...HEAD` MUST show exactly these three files (plus the spec artefacts under `specs/962-follow-up-from-960/`, which are meta-documentation and land in speckit-owned commits).

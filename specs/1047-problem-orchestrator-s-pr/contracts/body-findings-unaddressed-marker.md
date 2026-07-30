# Contract: `<!-- generacy-cockpit:body-findings-unaddressed -->` marker comment

**Feature**: #1047
**Producer**: `packages/orchestrator/src/worker/pr-feedback-handler.ts` (Disposition C branch)
**Consumers**:
- Same file on the next cycle (ack-parser for gate suppression, FR-008)
- Human operator (triage: which findings to fix by hand or re-review)

## Comment body format

Producer MUST post exactly one top-level PR comment with this shape:

```markdown
<!-- generacy-cockpit:body-findings-unaddressed -->

⚠️ **Body findings not yet addressed by the fixer**

The fixer completed this cycle without touching any file named by the
following review-body findings. To unblock:

- Address the findings manually, OR
- Remove the `blocked:body-finding-unaddressed` label to acknowledge —
  a subsequent NEW review from the same author will re-gate its findings.

### Unaddressed findings

- `<reviewer>` review #<reviewId> finding <findingIndex> (files: `<file1>`, `<file2>`)
- `<reviewer>` review #<reviewId> finding <findingIndex> (files: `<file1>`)
- ... one line per UnaddressedFinding ...

_This is an automated notice from the PR-feedback body-consumption path (#1047)._
```

Rules:

- The marker `<!-- generacy-cockpit:body-findings-unaddressed -->` MUST be the first line of the body.
- The enumeration under `### Unaddressed findings` MUST be a markdown list, one entry per finding.
- Each entry MUST match the parser regex ``/^- `([^`]+)` review #(\d+) finding (\d+)/m``.
- Files in the trailing suffix are human decoration and NOT parsed on resume — the ack-parser only needs identity `(reviewer, reviewId, findingIndex)`.
- Entries ordering: by review submission time ascending, then by findingIndex ascending. (Deterministic for readability; the parser is order-insensitive.)

## Idempotency (producer)

Before posting, producer MUST:

1. Call `github.listPrCommentBodies(owner, repo, prNumber)` — reuse the same call already made for the ack-parser input at cycle start.
2. If any existing comment body contains the marker AND the enumeration set is identical to what we're about to post, skip posting (no-op, log at debug).
3. Otherwise, post a new comment. Do NOT edit or delete older marker comments. The ack-parser explicitly takes the newest by array order.

**Multi-cycle marker accumulation is expected.** Each Disposition C posts its own marker comment; over N cycles, N such comments can exist. The ack-parser reads the newest.

## Failure modes (producer)

| Failure | Behavior |
|---------|----------|
| `listPrCommentBodies` throws | log warn, skip idempotency check, still attempt post (best-effort; a duplicate post is a lesser evil than a missing one) |
| `postPrComment` throws | log warn, DO NOT throw — the disposition label was already applied; the operator will still see the pause, just without the per-finding enumeration on this cycle |
| `addLabels` throws | log warn, still attempt the comment post — the comment carries the same triage info the label conveys |

## Ack-parser contract

Consumer (`pr-feedback-ack-parser.ts`) MUST:

1. Filter `commentBodies` to entries containing `<!-- generacy-cockpit:body-findings-unaddressed -->`.
2. Take the LAST matching entry by array index (input is in chronological order per `listPrCommentBodies` convention).
3. Extract the enumeration section — the block after `### Unaddressed findings` up to the next `###` heading or end-of-body.
4. For each line matching the regex above, produce `AcknowledgmentEntry { reviewer: capture1, reviewId: parseInt(capture2), findingIndex: parseInt(capture3) }`.
5. Convert to `AcknowledgedFindings` set with keys `${reviewer}:${reviewId}:${findingIndex}`.
6. Return the set.

Fail-open cases:

| Case | Result |
|------|--------|
| No matching comment body | empty set |
| Matching body, no `### Unaddressed findings` heading | empty set |
| Matching body, heading present, zero list items | empty set |
| Matching body with a malformed list item | skip that item, parse the rest |
| Parse error mid-way | return whatever was parsed successfully; do NOT throw |

## Example

Producer posts (cycle 1):
```markdown
<!-- generacy-cockpit:body-findings-unaddressed -->

⚠️ **Body findings not yet addressed by the fixer**
...
### Unaddressed findings

- `cockpit-bot` review #123 finding 1 (files: `foo.md`)
- `cockpit-bot` review #123 finding 2 (files: `bar.md`, `baz.md`)

_This is an automated notice..._
```

Cycle 2 ack-parser input:
```typescript
commentBodies = [
  '<!-- generacy-cockpit:body-findings-unaddressed -->\n\n... - `cockpit-bot` review #123 finding 1 (files: `foo.md`)\n- `cockpit-bot` review #123 finding 2 (files: `bar.md`, `baz.md`)\n_...',
  // other unrelated comments
]
```

Cycle 2 ack-parser output:
```typescript
AcknowledgedFindings = Set([
  'cockpit-bot:123:1',
  'cockpit-bot:123:2',
])
```

Cycle 2 gate: both findings are in the ack set → dropped from gating → this review no longer contributes constraints → cycle can advance to Disposition A (if the fixer produced any commit at all; a commit-less cycle still lands on the existing Disposition B path for "no diff", which is unchanged).

## Interaction with new reviews

A NEW review from the same author (higher `reviewId`) posts fresh findings. Ack-set membership is exact-key match — the new review's findings have a different `reviewId`, so they gate as normal. Ack-set from the older marker comment does NOT bleed forward.

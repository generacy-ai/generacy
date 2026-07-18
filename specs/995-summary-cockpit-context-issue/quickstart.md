# Quickstart: fix `cockpit_context` clarification-comment finder against label re-application

## Prerequisites

- Working checkout of `generacy-ai/generacy` on branch `995-summary-cockpit-context-issue`.
- `pnpm install` completed at the repo root.
- Node ≥22 (per `packages/generacy/package.json` `engines`/CI).

## Files touched

```
packages/generacy/src/cli/commands/cockpit/clarification-comment-finder.ts       (MODIFIED)
packages/generacy/src/cli/commands/cockpit/__tests__/clarification-comment-finder.test.ts (MODIFIED)
.changeset/995-cockpit-clarification-finder-marker.md                             (NEW)
```

Nothing else. See `plan.md` for the exact scope guard.

## Implementation walkthrough

### Step 1 — Add the import

In `clarification-comment-finder.ts`:

```ts
import { matchClarificationQuestionMarker } from '@generacy-ai/orchestrator';
import { getLogger } from '../../utils/logger.js';
```

### Step 2 — Rewrite the body of `findClarificationComment`

Replace lines 55-79 with a two-pass structure:

```ts
export async function findClarificationComment(
  gh: GhWrapper,
  repo: string,
  number: number,
): Promise<IssueComment | null> {
  const comments = await gh.fetchIssueComments(repo, number);

  // Pass 1: marker-first — survives label re-application (#995).
  const markerHits = comments
    .filter((c) => matchClarificationQuestionMarker(c.body) !== undefined)
    .filter((c) => !isStageStatusComment(c.body))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  if (markerHits.length > 0) return markerHits[0];

  // Pass 2: legacy label-timeline fallback (removed once poster fix universalises markers).
  getLogger().warn(
    { owner: repo.split('/')[0], repo: repo.split('/')[1] ?? repo, issue: number },
    `marker-less clarification comment; poster should be updated — issue=${repo}#${number}`,
  );

  const timeline = (await gh.fetchIssueTimeline(repo, number)) as TimelineLabelEvent[];
  let latestLabelTs: string | null = null;
  for (const event of timeline) {
    if (event.event !== 'labeled') continue;
    if (event.label?.name !== WAITING_CLARIFICATION) continue;
    if (event.created_at == null) continue;
    if (latestLabelTs == null || event.created_at > latestLabelTs) {
      latestLabelTs = event.created_at;
    }
  }
  if (latestLabelTs == null) return null;
  const labelTime = Date.parse(latestLabelTs);
  if (Number.isNaN(labelTime)) return null;

  const sorted = [...comments].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const c of sorted) {
    const ct = Date.parse(c.createdAt);
    if (Number.isNaN(ct) || ct < labelTime) continue;
    if (isStageStatusComment(c.body)) continue;
    return c;
  }
  return null;
}
```

### Step 3 — Add new unit tests

In `clarification-comment-finder.test.ts`, append 3 new tests (see plan.md §Test Plan):

```ts
it('US1: returns marker-carrying comment when label re-applied after question comment (regression for #995)', async () => {
  const gh = stub({
    fetchIssueTimeline: vi.fn(async () => [
      { event: 'labeled', label: { name: 'waiting-for:clarification' }, created_at: '2026-07-18T04:31:08Z' },
    ]),
    fetchIssueComments: vi.fn(async () => [
      { body: '<!-- generacy-clarifications:42 -->\n## Clarification Questions\n### Q1: …', author: 'bot', createdAt: '2026-07-18T03:02:00Z', url: 'question' },
    ]),
  });
  const c = await findClarificationComment(gh, 'o/r', 42);
  expect(c?.url).toBe('question');
});

it('FR-002: returns latest-by-createdAt marker comment when multiple exist', async () => {
  const gh = stub({
    fetchIssueTimeline: vi.fn(async () => []),
    fetchIssueComments: vi.fn(async () => [
      { body: '<!-- generacy-clarifications:1 -->\n## Batch 1', author: 'bot', createdAt: '2026-07-18T01:00:00Z', url: 'batch-1' },
      { body: '<!-- generacy-clarifications:2 -->\n## Batch 2', author: 'bot', createdAt: '2026-07-18T02:00:00Z', url: 'batch-2' },
    ]),
  });
  const c = await findClarificationComment(gh, 'o/r', 42);
  expect(c?.url).toBe('batch-2');
});

it('FR-005: falls back to label-timeline heuristic when no marker present, emits warn', async () => {
  // Use vi.spyOn on getLogger to assert exactly one warn call.
  // Fixture identical to line-23 test: no marker in the comment body,
  // fallback returns the same comment as today.
  // …
});
```

Adjust the existing tests to reflect that most of them exercise the fallback path now (see plan.md test-plan section for the per-test walkthrough).

### Step 4 — Write the changeset

Create `.changeset/995-cockpit-clarification-finder-marker.md`:

```markdown
---
'@generacy-ai/generacy': patch
---

fix: cockpit_context now finds clarification comments after `waiting-for:clarification` label re-application

`findClarificationComment` used to anchor on the most-recent `labeled` timeline event, which failed whenever requeue / boot-resume / cluster-restart re-applied the label without re-posting questions. It now positively identifies clarification-question comments via the shared `CLARIFICATION_QUESTION_MARKERS` registry (marker-first), falling back to the label-timeline heuristic with a deprecation warn when no marker-carrying comment exists. Resolves #995.
```

### Step 5 — Verify

```bash
cd packages/generacy
pnpm test clarification-comment-finder
```

All existing tests + 3 new tests should pass. Then:

```bash
pnpm --filter @generacy-ai/generacy lint
pnpm --filter @generacy-ai/generacy build
```

### Step 6 — Confirm SC-005 (regression fails without fix)

```bash
git stash        # (or checkout the pre-fix commit)
cd packages/generacy && pnpm test clarification-comment-finder
# → US1 test should fail
git stash pop    # restore fix
```

## Troubleshooting

**Q: The warn log spams every finder call.**
Check that the log line is emitted at the fallback branch entry, not inside the loop. It should fire at most once per invocation.

**Q: Existing FR-003 mixed-body test (line 163) fails.**
That fixture carries `<!-- generacy-stage:clarification-batch-2` at column 0 — it IS in `CLARIFICATION_QUESTION_MARKERS` (via the `<!-- generacy-stage:clarification` entry). Pass 1 wins for it. Assertion on `c?.url` unchanged; verify no warn log fires for this test.

**Q: `matchClarificationQuestionMarker` import fails.**
Confirm `@generacy-ai/orchestrator` is on `packages/generacy/package.json` (it is — line 46). Confirm the re-export exists (`packages/orchestrator/src/index.ts:268-275`). Rebuild the orchestrator package if needed: `pnpm --filter @generacy-ai/orchestrator build`.

**Q: How do I test the warn log without adding a `deps` arg to the finder?**
`vi.spyOn` on the pino logger returned by `getLogger()`. If that logger is not spy-friendly in the test environment (frozen instance), fall back to importing `getLogger` and `vi.mocked(...).mockReturnValue({ warn: vi.fn(), ... } as any)`. See how `resume.test.ts` handles similar cases.

## Follow-up work (out of scope for this PR)

- Poster-side companion issue: emit `<!-- generacy-clarifications:N -->` at column 0 on EVERY batch comment (per FR-004 / Q1 answer). File a fresh tracking issue on `generacy-ai/generacy` and link it in the PR description.
- After the poster fix has been live long enough for the warn log to reach ~zero, delete the fallback branch and simplify the finder to marker-only. Track as another follow-up.

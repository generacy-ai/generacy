# Quickstart: Scope cockpit poll events to the epic's resolved ref set

## Setup

```bash
pnpm install
# Cross-package imports resolve to built dist/ — rebuild cockpit before
# typechecking/testing packages/generacy:
pnpm --filter @generacy-ai/cockpit build
```

## Run the affected tests

```bash
# Wrapper (new batchLookupIssuesOrPrs):
pnpm --filter @generacy-ai/cockpit test -- src/gh/__tests__

# Poll path + scope filter + budget:
pnpm --filter @generacy-ai/generacy test -- src/cli/commands/cockpit/__tests__/watch.poll-loop.test.ts
pnpm --filter @generacy-ai/generacy test -- src/cli/commands/cockpit/__tests__/cockpit-graphql-budget.integration.test.ts

# Full cockpit command suite:
pnpm --filter @generacy-ai/generacy test -- src/cli/commands/cockpit
```

## Verify against a real repo

Reproduction of the original defect (before the fix):

```bash
gh search issues repo:Painworth/doc-intel 120 --json number
# → 6 results; only #120 is the ref, 5 match on body text
```

After the fix, the poll path issues exact lookups instead:

```bash
gh api graphql -F owner=Painworth -F repo=doc-intel -f query='
query($owner:String!,$repo:String!){ repository(owner:$owner,name:$repo){
  r0: issueOrPullRequest(number:120){ __typename ... on Issue { number state } } } }'
# → exactly #120, never free-text matches; PR numbers return PullRequest nodes
```

Live check with a cockpit epic:

```bash
generacy cockpit watch <owner/repo#epic> --interval 30
# NDJSON stream must only ever contain repo#number pairs present in the epic body;
# PR refs listed in the epic body now produce pr lifecycle / pr-checks events.
```

## Behavior changes to expect

- `issue-transition` events for issues merely *mentioning* an in-scope number: gone.
- PR refs in the epic body now emit `pr-merged` / `pr-closed` / `pr-checks` events from the
  poll path (previously smee-only).
- `cockpit status` no longer lists foreign issues that free-text-matched the query.
- Per-repo poll cost: one aliased GraphQL call replaces paginated REST search. Gated
  per-PR fetches appear for in-scope PRs (bounded by `derivePrChecksNeeded`).

## Troubleshooting

- **"no exported member 'batchLookupIssuesOrPrs'"** in `packages/generacy` typecheck:
  stale `dist/` — rebuild `@generacy-ai/cockpit` first.
- **Poll warns `api graphql (batchLookupIssuesOrPrs)` failures**: check `gh auth status`
  and rate limits; NOT_FOUND for stale epic-body refs is tolerated silently, everything
  else surfaces as a per-cycle warn and retries next cycle.
- **CI changeset gate red**: the PR must *add* `.changeset/1229-cockpit-poll-scope.md`
  listing `@generacy-ai/cockpit` (minor) and `@generacy-ai/generacy` (patch).

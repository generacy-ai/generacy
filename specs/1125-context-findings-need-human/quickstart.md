# Quickstart: PR review posting + draft/ready lifecycle (#1125)

## What this ships

Turns the review executor's findings artifact into GitHub side effects on the PR:
one COMMENT-event review per round (inline where diffable, marker + round in the body),
draft↔ready lifecycle around the review⇄remediate loop, and thread resolution on
re-review passes. **Production-inert** until #1124 lands the real review executor +
artifact writer — the posting path only runs when a findings artifact is available via
the `readFindingsArtifact` seam (default off).

## Build & test

```bash
pnpm install
pnpm --filter @generacy-ai/workflow-engine build
pnpm --filter @generacy-ai/orchestrator build

# new/affected unit + integration tests
pnpm --filter @generacy-ai/workflow-engine test gh-cli.create-review
pnpm --filter @generacy-ai/workflow-engine test gh-cli.convert-to-draft
pnpm --filter @generacy-ai/workflow-engine test gh-cli.list-pr-files
pnpm --filter @generacy-ai/orchestrator test review-poster
pnpm --filter @generacy-ai/orchestrator test pr-manager.draft
pnpm --filter @generacy-ai/orchestrator test phase-loop.review-side-effects
```

## New capabilities

**GitHub client (`@generacy-ai/workflow-engine`)**

```ts
await github.createReview(owner, repo, prNumber, {
  event: 'COMMENT',
  body: '<!-- generacy-engine-review round=1 -->\n## Round 1\n...',
  comments: [{ path: 'src/x.ts', line: 42, side: 'RIGHT', body: '<!-- generacy-finding:F-abc -->\n...' }],
});

await github.convertPullRequestToDraft(owner, repo, prNumber); // GraphQL, idempotent
const files = await github.listPullRequestFiles(owner, repo, prNumber); // { filename, patch? }[]
```

**Orchestrator (`ReviewPoster` + `PrManager`)**

```ts
const poster = new ReviewPoster({ github, owner, repo, prNumber, logger });
await poster.postRound(artifact, round);          // one COMMENT review, deduped by marker+round
if (round >= 2) await poster.resolveResolvedThreads(artifact);

await prManager.markReadyForReview(linkedPRs);              // on verdict: clean (sets engine flag)
await prManager.convertToDraftIfEngineMarkedReady(linkedPRs); // on remediate entry (flag-gated)
```

## Wiring the artifact source (test / #1124)

The phase loop reads the artifact through an injectable seam (default `undefined` → inert):

```ts
phaseLoop.executeLoop(context, config, {
  ...deps,
  readFindingsArtifact: async (ctx, round) => loadSidecarArtifact(ctx, round), // #1124 provides this
});
```

Tests inject a fake reader returning a `FindingsArtifact` fixture.

## Behaviour summary

| Signal | Effect |
|---|---|
| Any review round | Exactly one `COMMENT` review; inline where diffable, else body; body has marker + round |
| `verdict: clean` (round N) | `markReadyForReview` at review-phase end, before validate → CI runs parallel to validate |
| Enter `remediate` after engine marked ready | `convertPullRequestToDraft` (else no-op) |
| Verification pass (round ≥ 2) | Threads for `resolved` findings resolved by marker match |
| Re-entered same round | Dedupe skip (no second review) |

## Troubleshooting

- **No review posted in production**: expected until #1124 wires `readFindingsArtifact` — the seam defaults `undefined`.
- **422 on review submission**: an inline comment anchored outside the diff. The diffability pre-check (`listPullRequestFiles` + hunk parse) should route it to the body; verify `computeDiffableLines` covers the file's hunks.
- **Draft conversion did nothing**: the engine only converts PRs it marked ready itself (`markedReadyByEngine`); human-marked-ready PRs are left alone (FR-006). A worker restart mid-loop resets the flag → conversion is skipped (safe, best-effort).
- **Thread not resolved on re-review**: confirm the per-finding `<!-- generacy-finding:<marker> -->` marker in the inline comment matches the artifact finding's `marker`, and that the artifact set `resolved: true`.

## Changeset

`.changeset/1125-pr-review-posting.md` — `@generacy-ai/workflow-engine` **minor** (new client methods), `@generacy-ai/orchestrator` **patch** (internal wiring).

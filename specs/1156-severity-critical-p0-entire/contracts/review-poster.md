# Contract: `ReviewPoster` live PR-number getter (FR-004)

`packages/orchestrator/src/worker/review-poster.ts`. Public method surface (`postRound`, `resolveResolvedThreads`) is **unchanged** (SC-003). Only the constructor dependency changes.

## Before

```ts
type ReviewPosterDeps = {
  github: GitHubClient;
  owner: string;
  repo: string;
  prNumber: number;          // captured once at construction
  logger: Logger;
};
```

Constructed at `claude-cli-worker.ts` with `prNumber: prManager.getPrNumber() ?? 0` — **before** the PR exists, so it captures `0` and early rounds post to PR #0.

## After

```ts
type ReviewPosterDeps = {
  github: GitHubClient;
  owner: string;
  repo: string;
  getPrNumber: () => number | undefined;   // resolved live per call
  logger: Logger;
};
```

Constructed with `getPrNumber: () => prManager.getPrNumber()`.

## Resolve-or-skip per public method

At the top of **both** `postRound` and `resolveResolvedThreads`:

```ts
const prNumber = this.getPrNumber();
if (prNumber === undefined) {
  this.logger.debug({ owner: this.owner, repo: this.repo }, 'ReviewPoster: no PR yet, skipping');
  return;
}
```

Every internal `this.prNumber` reference (3× in `postRound`, 1× in `resolveResolvedThreads`) becomes the locally-resolved `prNumber`.

## Behavior contract

- `getPrNumber()` returns `undefined` → method is a no-op (no `createReview`, no `getPRReviewThreads`, no `resolveReviewThread`). **Never posts to PR #0** (SC-003).
- `getPrNumber()` returns a real number → post/resolve targets exactly that number.
- A PR created mid-loop is targeted correctly on the next call because resolution is live, not captured.
- Best-effort contract (FR-008) unchanged: the existing try/catch in both methods still swallows and logs failures.

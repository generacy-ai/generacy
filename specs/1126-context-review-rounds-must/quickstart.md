# Quickstart: delta-scoped verification passes (#1126)

This feature adds convergence logic to the engine-native `review` phase so that
re-reviews verify only what changed since the last review plus the still-open
findings. It ships as pure functions in
`packages/orchestrator/src/worker/review/`, wired through the existing `review`
stub branch in `phase-loop.ts`.

## Build & test

```bash
pnpm install
pnpm --filter @generacy-ai/orchestrator build
pnpm --filter @generacy-ai/orchestrator test review        # the new review/ unit tests
pnpm --filter @generacy-ai/orchestrator test phase-loop     # phase-loop wiring
```

## How the loop converges

1. **First review (round 1)** — no findings artifact yet ⇒ full-diff review;
   records the reviewed head SHA into the artifact. No behavior change beyond
   recording the SHA.
2. **Remediate** — control backtracks via the `remediateTrigger` seam
   (`phase-loop.ts:1154-1166`).
3. **Re-review (round n+1)** — the engine:
   - computes the delta `lastReviewedSha..HEAD` (`computeReviewDelta`);
   - composes the prompt with the round number + verbatim open findings;
   - marks delta-located addressed findings `resolved`, leaves the rest `open`;
   - **drops** any new advisory finding (below `blockingSeverity`);
   - advances `lastReviewedSha` to the new head;
   - emits `clean` iff no blocking finding remains `open`.
4. **Merge-conflict re-arm** — if the pause-context sidecar carries resolution
   base/head SHAs (#1131), the delta is scoped to just the resolution diff; same
   verification charter, round still increments.

## Key rules (from clarifications)

- `resolved` is **terminal** — a re-broken location becomes a *new* finding, never
  a re-open (Q1).
- An open finding outside the current delta stays `open` — resolution is
  evidence-based (Q2).
- New sub-blocking findings after round 1 are dropped by the engine, not just the
  prompt (Q3).
- Merge-conflict re-review is the same verification pass, only the delta source
  differs (Q4).
- An unresolvable SHA (post-rebase) widens the delta to the full diff but stays a
  verification pass — never resets to round-1 semantics (Q5).

## What this feature does NOT do

- Implement the review executor / findings-artifact schema (#1124).
- Post PR reviews or resolve inline threads (#1125).
- Produce the merge-conflict resolution SHAs (#1131) — it only reads them.
- Gate the number of remediation cycles (#1128).

## Troubleshooting

- **Re-review reviews the whole diff every round** — the artifact `lastReviewedSha`
  is not being advanced or persisted; check the `review-findings:` PhaseTracker key
  and that `advanceArtifact` runs after each pass.
- **Nitpicks still appear after round 1** — confirm `filterNewFindings` runs with
  `round >= 2` and the correct `blockingSeverity` from
  `ResolvedWorkflowConfig.review`.
- **Merge-conflict re-review reviews unrelated files** — the pause-context sidecar
  is missing resolution SHAs (#1131 not yet populating them); the FR-009 full-diff
  fallback is expected until #1131 lands.

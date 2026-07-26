# Quickstart: PR-feedback body-consumption

**Feature**: #1047
**Audience**: reviewers posting review-body findings, operators triaging the new Disposition C, and developers touching the fixer path.

## For reviewers: how to post a body finding that will be picked up

**Simple case** — just leave a review with `--request-changes` or `--comment` and a body:

```bash
gh pr review <PR> --comment --body "This change made docs/plan.md stale — please update it to match the new API."
```

The body reaches the fixer prompt. Note that under the single-credential model, `--request-changes` becomes state `COMMENTED` on the wire; both `CHANGES_REQUESTED` and `COMMENTED` submissions are consumed (see [`clarifications.md` Q2](./clarifications.md)).

**Gated case** — add the marker to make the finding block cycle completion until addressed:

```bash
gh pr review <PR> --comment --body "$(cat <<'EOF'
The API contract changed but the doc didn't.

<!-- generacy-cockpit:unanchored-findings -->

### Finding 1

**Finding:** Stale contract description

**Failure scenario:** Reader following auto.md gets an outdated command sequence.

**Files:** packages/claude-plugin-cockpit/commands/auto.md
EOF
)"
```

If the fixer cycle produces commits but none of them touch `packages/claude-plugin-cockpit/commands/auto.md`, the cycle enters **Disposition C**, applies `blocked:body-finding-unaddressed`, and posts a marker-keyed enumeration comment.

## For operators: what to do when Disposition C fires

When the `blocked:body-finding-unaddressed` label appears on an issue:

1. **Read the marker comment** on the PR (search for `<!-- generacy-cockpit:body-findings-unaddressed -->` — GitHub renders the HTML comment as blank so the visible content starts with the ⚠️ heading).

2. **Decide** for each listed finding:
   - **The fixer got it wrong** — fix by hand, commit and push. The next cycle sees your commit; the file was named in the finding; the gate passes.
   - **The finding is invalid or already handled elsewhere** — remove the `blocked:body-finding-unaddressed` label. The findings named in the marker comment are treated as acknowledged and do NOT re-gate on the next cycle. They still reach the fixer's prompt for context.

3. **Re-review** by the same author (a new `gh pr review` submission — this produces a higher `reviewId`) resurfaces its findings as gating. Ack-set membership keys on `(reviewer, reviewId, findingIndex)` — the new review is a new identity, so a stale acknowledgment does not silently apply to fresh feedback.

## For developers: the moving parts

- **Fetch** — `pr-feedback-handler.ts` calls `github.listReviews(owner, repo, prNumber)` at cycle start, alongside the existing `getPRReviewThreads`. Filters to `state ∈ {CHANGES_REQUESTED, COMMENTED}` and non-empty body.
- **Prompt** — each body becomes a `Comment`-shaped prompt item with `path: undefined, line: undefined`. `buildFeedbackPrompt` renders it as `'general comment'` — no renderer change needed (see [`plan.md` Load-bearing existing hooks](./plan.md)).
- **Parse** — `pr-feedback-body-parser.ts` extracts `### Finding <n>` blocks and their `**Files:**` lines from the `<!-- generacy-cockpit:unanchored-findings -->` marker section. Missing marker or missing `**Files:**` → the finding parses but doesn't gate (FR-005 fail-open).
- **Ack set** — `pr-feedback-ack-parser.ts` reads the newest `<!-- generacy-cockpit:body-findings-unaddressed -->` marker comment via `listPrCommentBodies`. Findings named there are excluded from gating.
- **Gate** — `pr-feedback-body-gate.ts` groups reviews by author, keeps only the newest per author, evaluates each finding's `**Files:**` list against the cycle's `git diff --name-only <base>..HEAD` set. AND across findings; single unsatisfied finding blocks the cycle.
- **Disposition C** — when the gate fails: `addLabels(['blocked:body-finding-unaddressed'])` + `postPrComment(markerBody)` (idempotent). Skips the reply/resolve loop; exits through the existing shared `finally` that clears `agent:in-progress` (#926 pattern).

## Available `gh` inspection commands

```bash
# List all reviews on a PR (raw REST)
gh api /repos/<owner>/<repo>/pulls/<n>/reviews

# List top-level PR comments (used for marker-comment idempotency + ack-parser input)
gh api /repos/<owner>/<repo>/issues/<n>/comments

# See the label state (skip gate is bare `blocked:*` prefix — new label needs no allow-list)
gh issue view <n> --json labels
```

## Troubleshooting

**"I posted a body finding but the fixer didn't touch the file it named"**
1. Check the review state — `APPROVED` and `DISMISSED` reviews are excluded from the fetch. `--comment` (which lands as `COMMENTED`) and `--request-changes` (which also lands as `COMMENTED` under the single-credential model) both work.
2. Check the `**Files:**` line — no line, no gate. Post the marker with the `**Files:**` line if you want the cycle to block until the file is touched.
3. Check the acknowledgment set — if the file was previously flagged and you removed `blocked:body-finding-unaddressed`, the finding is acknowledged. Post a NEW review (higher `reviewId`) to re-gate.

**"The label appeared and I removed it, but the fixer stalls without re-running"**
This is expected. Per [`clarifications.md` Q6](./clarifications.md) rationale, the monitor's Case C at `pr-feedback-monitor-service.ts:264-285` precedes the `blocked:*` check. Nothing re-enters until a new review posts new threads. Post a new review (even a no-op comment) to re-trigger.

**"The `<!-- generacy-cockpit:unanchored-findings -->` marker was in my body but the finding didn't gate"**
Check that:
- The `**Files:**` line is exactly `**Files:** ` (two asterisks, exact case, one space after the colon).
- The file paths are workspace-relative (no leading `/`, no `~`, no `../`).
- The paths match what appears in `git diff --name-only <base>..HEAD` after the fixer's commits — GitHub file paths are case-sensitive.

**"I want the fixer to include body context but never gate"**
Post a review with a body but no marker. The body reaches the prompt (FR-002); no gate fires (FR-005 fail-open).

## Testing locally

```bash
# From repo root
pnpm --filter @generacy-ai/orchestrator test -- pr-feedback-body-parser
pnpm --filter @generacy-ai/orchestrator test -- pr-feedback-body-gate
pnpm --filter @generacy-ai/orchestrator test -- pr-feedback-ack-parser
pnpm --filter @generacy-ai/orchestrator test -- pr-feedback-handler-body-flow
```

## Sources

- Spec: [spec.md](./spec.md)
- Clarifications: [clarifications.md](./clarifications.md)
- Plan: [plan.md](./plan.md)
- Data model: [data-model.md](./data-model.md)
- Contracts: [contracts/](./contracts/)

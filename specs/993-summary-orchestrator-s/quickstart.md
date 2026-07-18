# Quickstart: Verifying the clarification-answer bot-filter fix

**Feature**: `993-summary-orchestrator-s`
**Date**: 2026-07-18

This quickstart covers verifying that #993's fix landed correctly on a cluster where issues reach `waiting-for:clarification` under an App-installation identity (the target of the bug).

## Prerequisites

- A running Generacy cluster where the orchestrator is authenticated as a GitHub App (not a PAT). Verify:
  ```bash
  docker compose exec orchestrator gh api user 2>&1 | head -5
  ```
  Expect: `HTTP 403: Resource not accessible by integration` (the App installation token can't call `/user`). A PAT-authenticated cluster returns a 200 body with a `login` — the bug doesn't occur on those clusters, so this fix is a no-op there.
- At least one speckit issue that has reached `waiting-for:clarification` + `agent:paused` without any human answer comment posted. If you don't have one, create it: assign an issue with `process:speckit-feature`, wait for the phase loop to reach clarify, and let it park.

## Golden path (SC-001, US1)

After the orchestrator boots with the #993 change:

1. Tail the orchestrator log for the clarification-answer monitor and confirm the poll cycles complete without emitting `'clarification-answer-resume-enqueued'`:
   ```bash
   docker compose logs -f orchestrator | grep -E 'clarification-answer'
   ```
   Expect: `'No trusted human-authored comment found — nothing to resume on'` at each poll cycle for any parked issue whose only comments are bot-authored. Absence of `'Clarification-answer resume enqueued'` for the same issue over N cycles (N ≥ 3, ≥ 15 minutes at default cadence) means the loop is closed.

2. Grep the past 30 minutes of logs for the bug's fingerprint on a parked issue:
   ```bash
   docker compose logs --since 30m orchestrator | \
     grep -E 'clarification-answer-resume-enqueued.*(#5|#6|#7|#8)' | wc -l
   ```
   Expect: `0`.

3. Confirm the issue label state is preserved (nothing modified):
   ```bash
   gh issue view <n> --repo <owner>/<repo> --json labels --jq '.labels[].name'
   ```
   Expect: still `waiting-for:clarification`, `agent:paused`, and any other prior labels — no `failed:clarify`, no `agent:error` — regardless of how long the issue has been parked.

## Real-answer happy path (SC-002, US1 acceptance)

Post a real human comment on the parked issue from an account that is a MEMBER/COLLABORATOR/OWNER of the repo (NOT the cluster's App identity):

```bash
gh issue comment <n> --repo <owner>/<repo> --body 'Q1: yes, use option A.'
```

Within one poll cycle (default ≤ 5 minutes for smee-less clusters), expect:

1. Log line:
   ```
   Clarification-answer resume enqueued  { owner, repo, issueNumber: <n>, source: 'poll' }
   ```
2. The resume queue item is picked up by a worker.
3. The clarify phase re-runs and either integrates the answer (labels transition to `completed:clarification` and phase advances) or the phase loop continues its normal error handling.

## Marker-carrying answer from non-bot (SC-003)

If cockpit posts a `<!-- generacy-clarification-answers: -->` marker comment authored by the human (not the cluster's App), the same resume path fires. Simulate by hand:

```bash
gh issue comment <n> --repo <owner>/<repo> --body $'<!-- generacy-clarification-answers:1 -->\nQ1: yes'
```

Note: this is a manually-posted marker for testing; production markers are posted by cockpit's relay path, which authenticates as `generacy-ai[bot]` and therefore does NOT trigger this monitor (that path uses `completed:clarification` + LabelMonitorService).

Expect: one resume enqueue on the next poll cycle, same log lines as the SC-002 case.

## Verifying FR-005 (marker family match, SC-004)

If you're testing a future speckit stage (e.g. `<!-- speckit-stage:tasks -->`), post the fixture comment on a parked issue:

```bash
gh issue comment <n> --repo <owner>/<repo> --body $'<!-- speckit-stage:tasks -->\nFrame check.'
```

Expect: the monitor does NOT resume on this comment (it's a stage marker, skipped by the family match). Log line at each poll: `'No trusted human-authored comment found — nothing to resume on'`.

Unit-level SC-004 verification:

```bash
cd packages/orchestrator
pnpm vitest run src/worker/__tests__/clarification-markers.test.ts
```

Expect: the added test case for a hypothetical future stage passes without any change to `MACHINE_MARKERS`.

## GraphQL rate-limit sanity check

On an idle cluster with N parked `waiting-for:clarification` issues, sample the App-installation-token rate-limit consumption over 10 minutes:

```bash
docker compose logs orchestrator | \
  grep -oE '"x-ratelimit-remaining":"[0-9]+"' | \
  head -20
```

Pre-fix: each poll cycle triggered one full clarify agent-run per parked issue (heavy). Post-fix: the poll cycles complete without enqueuing any resume; the API cost is one comment-list call per issue per poll cycle (light).

## Log verification cheatsheet

| Assertion | grep string | Expected |
|---|---|---|
| SC-001 | `'clarification-answer-resume-enqueued'` on bot-only issue | 0 |
| SC-001 | `'No trusted human-authored comment found'` per poll | 1 per poll per parked issue |
| SC-002 | `'Clarification-answer resume enqueued'` after human comment | 1 within one cycle |
| Regression | `'failed:clarify'` labels on parked issues | 0 (no new applications) |
| Regression | `'agent:error'` labels on parked issues | 0 (no new applications) |

## Rolling back

The fix is a two-file behavior change with no schema, no config, no persistent state. To roll back manually, revert:

- `packages/orchestrator/src/services/clarification-answer-monitor-service.ts`
- `packages/orchestrator/src/worker/clarification-markers.ts`
- `.changeset/993-clarification-answer-bot-filter.md`

No data migration is required. The pre-fix behavior returns immediately (the resume loop).

## Troubleshooting

- **Monitor still resumes on bot-only comments after the fix**: check `packages/orchestrator/src/services/clarification-answer-monitor-service.ts` for the `isBotAuthoredLogin` filter. The check must run BEFORE `isTrustedCommentAuthor`. If the order is reversed, the trust helper's `MEMBER` verdict on App-installation comments still slips through.
- **Real human answers no longer resume**: verify the fetched comment carries a non-`[bot]`-suffixed `author` value and a valid `authorAssociation` tier. On GraphQL fetches (`getIssueCommentsWithViewerAuth`), `author` is bare (no `[bot]` suffix) for real users. If the login is `<user>[bot]`, the fetch path is wrong. Verify the query at `gh-cli.ts:318-392` is being used.
- **Family match catches a legitimate human comment**: only if a human posts a `<!-- generacy-stage:X -->` or `<!-- speckit-stage:X -->` comment verbatim. Extremely unlikely (these prefixes are engine-authored). If it happens, treat as workflow manipulation — the correct response is to reject the comment as machine noise.
- **`created_at` tie between question and answer** (rare, second-precision): the FR-004 predicate uses `>` (strict). Two comments posted in the same second — both from GitHub's server clock — are considered simultaneous and the answer does not qualify. Remedy: post a new answer (the operator's remedy for any missed answer, per Q4).
- **`isTrustedCommentAuthor` returns `reason: 'bot'` for a non-`[bot]`-suffixed author**: this means the author's login matches the resolved cluster `botLogin` (usually `christrudelpw` on this cluster). That's the same-account case; the monitor deliberately does not resume on it. The phase loop handles same-account answers via the `completed:clarification` label / LabelMonitorService path.

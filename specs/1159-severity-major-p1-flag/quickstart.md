# Quickstart: External-feedback re-entry budget bounding + charter fencing + head-ref checkout

**Feature**: `1159-severity-major-p1-flag`
**Status**: Complete

This feature has no user-facing CLI or API surface. It is three internal fixes on
the flag-ON review/remediate `address-pr-feedback` route inside
`@generacy-ai/orchestrator`. This page describes how to build, exercise, and
troubleshoot the behavior.

## Build & test

```bash
pnpm install
pnpm --filter @generacy-ai/orchestrator test
```

Targeted suites:

```bash
# FR-003 monitor failed:* skip (SC-002)
pnpm --filter @generacy-ai/orchestrator test pr-feedback-monitor-service

# FR-001 re-entry budget + FR-006/FR-007 head-ref/dup-PR (SC-001, SC-004)
pnpm --filter @generacy-ai/orchestrator test claude-cli-worker

# FR-004 seed detail fencing (SC-003)
pnpm --filter @generacy-ai/orchestrator test seed-aware-review-executor

# FR-005 validate-evidence detail fencing (SC-003)
pnpm --filter @generacy-ai/orchestrator test phase-loop
```

## Feature flag

The whole flow is behind the review/remediate flag:

- Config: `reviewPhaseEnabled`
- Env: `WORKER_REVIEW_PHASE_ENABLED`

With the flag **OFF**, a cluster behaves byte-identically to today (FR-008 /
SC-005). The `failed:*` monitor skip only affects issues that already carry a
`failed:*` label, so it is inert on clusters that never reach a `failed:*`
escalation.

## What changed (operator-visible behavior)

1. **Bounded remediation budget** — A PR that receives external review feedback
   but does not converge no longer restarts its remediation budget on every
   monitor poll. Once `remediationCount` reaches `maxRemediations`, the PR parks at
   `waiting-for:remediation-limit` + `agent:paused` and stays there until an
   operator resumes it.
2. **`failed:*` no longer re-enqueues** — A `failed:review` or
   `failed:validate-repeated` escalation suppresses re-enqueue. Clear it by
   **removing the `failed:*` label** (the existing resume convention).
3. **Fenced untrusted detail** — Review comment bodies and raw validate output
   embedded in the remediate charter are wrapped in the `<untrusted-data …>` fence,
   so a crafted comment or tool output cannot inject instructions.
4. **Commits land on the PR's own branch** — Under slug drift (#1043), remediation
   commits go to the PR's `head.ref` instead of a divergent issue-derived branch,
   and no duplicate PR is opened.

## Resuming a parked PR

| Parked state | How to resume |
|---|---|
| `waiting-for:remediation-limit` + `agent:paused` | Operator resume of the gate (rearms/resets the budget). |
| `failed:*` | Remove the `failed:*` label. |
| `>1` linked open PR (branch ambiguity) | Resolve to a single open PR (close/merge the extras), then the next poll proceeds. |

## Troubleshooting

- **"A PR keeps re-running seed→review→remediate every poll"** — Confirm the issue
  carries a `failed:*` or `waiting-for:remediation-limit` label. If it carries a
  `failed:*` label and still re-enqueues, the `failed:*` skip is not deployed
  (check the monitor version). If it carries neither, the loop is a genuinely-new
  review changing the unresolved-thread set — expected (Q2→B reset occasion).
- **"remediationCount looks like it reset to 0"** — This is correct on exactly two
  occasions (Q2→B): operator resume of the `remediation-limit` gate, or a new
  distinct review after prior threads were resolved. On any other re-entry the
  count must be monotonic; if it resets elsewhere, the artifact was cleared
  spuriously — check that the monitor `failed:*` skip is reached.
- **"Remediation commits landed on the wrong branch / a duplicate PR appeared"** —
  Confirm the re-entry took the `address-pr-feedback` head-ref path. Zero linked
  open PRs falls back to the fresh-request `createFeature` path (budget 0);
  `>1` linked open PRs parks. Exactly one should `switchBranch` to `head.ref`.
- **"An engine-authored finding looks double-wrapped"** — Only the seed and
  validate-evidence ingestion sites wrap; the charter and the real review executor
  do not. If engine-authored detail is fenced, a central-charter wrap crept in
  (Q5→A forbids it).

## Changeset

One changeset ships with the implementation:
`.changeset/1159-*.md` — `@generacy-ai/orchestrator` **patch**
(`workflow:speckit-bugfix`). No `workflow-engine` changeset (its `src/` is not
modified — `wrapUntrustedData` is a reused import). No new label vocabulary.

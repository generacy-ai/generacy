# Quickstart: Verify the Clarify Gate-Skip Fix

**Issue**: [generacy-ai/generacy#818](https://github.com/generacy-ai/generacy/issues/818)
**Branch**: `818-observed-generacy-ai-agency`

## What this fix changes

`packages/orchestrator/src/worker/clarification-poster.ts` — two rule tightenings and two structured warn log lines. No package installs, no config changes, no cross-service coordination required.

## Local development setup

Prerequisites: repo already checked out, `pnpm` available, Node >=22.

```bash
pnpm install
```

That's it — no emulator, no docker, no cloud coupling. The fix is a pure-function change plus co-located vitest tests.

## Run the tests

The regression tests live in `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`.

```bash
# From repo root:
pnpm --filter @generacy-ai/orchestrator test -- clarification-poster
```

Expected: all existing tests continue to pass, plus new tests covering:

- FR-001: variant question-comment shapes (marker-absent + markup co-occurrence) → `isQuestionComment` returns `true`.
- FR-002: captured answer containing `**Question**:` / `**Context**:` → skipped, `SKIPPED_SUSPICIOUS_ANSWER` warn.
- FR-004: pending→answered transition from a source with `### Q<n>:` heading → warn `TRANSITION_WITH_QUESTION_HEADINGS` with the real comment id.
- FR-005: `as per Q1: yes` mid-prose → no answer captured (regex line-anchor).

## Manual smoke test (optional)

If you want to reproduce the original bug locally, follow this playbook.

### Step 1 — set up a spec directory in fixture state

Create a temp workspace with a fake spec:

```bash
mkdir -p /tmp/gen818-repro/specs/999-repro-clarify-race
cat > /tmp/gen818-repro/specs/999-repro-clarify-race/clarifications.md <<'EOF'
# Clarifications

### Q1: Auth strategy
**Question**: What auth flow?
**Answer**: *Pending*

### Q2: Storage backend
**Question**: SQL or KV?
**Answer**: *Pending*
EOF
```

### Step 2 — pre-fix reproduction (control)

With `main` checked out (or before applying the fix on this branch), call the parser directly with a bot-shaped comment that has NO marker:

```typescript
// scripts/repro-818.ts (or a scratch REPL)
import { integrateClarificationAnswers } from '@generacy-ai/orchestrator/worker/clarification-poster';

const fakeGithub = {
  getIssueComments: async () => [
    {
      id: 42,
      body: [
        '## Clarification Questions',       // no marker, matches heading branch today
        '### Q1: Auth strategy',            // topic text
        '**Question**: What auth flow?',
        '',
        '### Q2: Storage backend',
        '**Question**: SQL or KV?',
        '',
        'Q1: your answer here',             // example "how to answer" line
        'Q2: your answer here',
      ].join('\n'),
      created_at: new Date().toISOString(),
    },
  ],
};

const result = await integrateClarificationAnswers(
  {
    github: fakeGithub as any,
    item: { owner: 'x', repo: 'y', issueNumber: 999 } as any,
    checkoutPath: '/tmp/gen818-repro',
  } as any,
  console as any,
);

console.log('integrated:', result.integrated);
```

Pre-fix output: `integrated: 2` — both Q1 and Q2 marked as answered by the bot's own topic strings. Gate would skip.

### Step 3 — post-fix verification

With this branch's changes applied:

- `isQuestionComment(body)` returns `true` (FR-001: `### Q1:` section contains `**Question**:`).
- The comment is filtered out at `integrateClarificationAnswers:420`, so `parseAnswersFromComments` never sees it.
- Result: `integrated: 0`.
- `hasPendingClarifications()` returns `true`.
- `waiting-for:clarification` gate stays active.

Post-fix output: `integrated: 0` — no false integration. Gate correctly holds.

### Step 4 — verify the warn signals

Add a `### Q1:` heading to a comment but omit the markup and give it a real answer:

```typescript
comments: [
  { id: 100, body: '### Q1: my answer follows\nQ1: A — I prefer OAuth', created_at: '...' },
]
```

- FR-001: no markup, so `isQuestionComment` returns `false`.
- FR-002: captured answer is `A — I prefer OAuth`, no markup, not skipped.
- FR-005: `Q1:` starts at line 2 (after newline), matches anchored regex.
- Integration happens.
- FR-004: source comment has `### Q<n>:` heading → warn fires with `code: TRANSITION_WITH_QUESTION_HEADINGS, commentId: 100`.

## Rollback

If a regression is discovered post-deploy, revert commit(s) touching `packages/orchestrator/src/worker/clarification-poster.ts`. The prior behaviour of the `isQuestionComment` marker/heading checks is preserved on the code paths — the new rule is additive.

## Troubleshooting

**Q: The gate still skips on my local run.**
- Verify `waiting-for:clarification` is in the workflow config's gates array (`packages/orchestrator/src/worker/config.ts`, look for `gates:` under `speckit-feature`).
- Verify `clarifications.md` actually has `**Answer**: *Pending*` for at least one question — the fix does not create pending questions, only prevents them from being mis-answered.

**Q: I see `TRANSITION_WITH_QUESTION_HEADINGS` warns in production.**
- Not a bug — this is the residual-race detector working. It means a comment slipped past FR-001 and FR-002. Grab the `commentId` from the log payload, view it on GitHub, and open a follow-up spec for the newly-observed vector.

**Q: I see `SKIPPED_SUSPICIOUS_ANSWER` warns on legitimate human answers.**
- Should be very rare. If it happens, the human's answer text literally contains `**Question**:` or `**Context**:` (e.g., quoting the bot). Check the `excerpt` field on the log line; if it's a legitimate quote-back-then-answer format, open a follow-up to refine the FR-002 rule.

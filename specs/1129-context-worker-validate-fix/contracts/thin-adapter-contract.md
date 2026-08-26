# Contract: `ValidateFixHandler` reduced to a thin remediate adapter

`packages/orchestrator/src/worker/validate-fix-handler.ts`. Serves as the interim
`remediate` behavior for validate-origin remediations while `remediate` is still
`runStubPhase` (Clarification Q2→B, FR-005). Retire fully only when the real
`remediate` executor lands (later epic issue).

## Signature (unchanged)

```ts
handle(
  item: QueueItem,
  checkoutPath: string,
  target: { prNumber: number; baseBranch: string },
  evidence: { stdout: string; stderr: string; exitCode: number | null },
  github: GitHubClient,
  workflowName: string,
): Promise<void>;
```

## MUST preserve (FR-010)

- Build the fix prompt from the validate `evidence`.
- Enumerate sibling-owned files: open PRs against the same `baseBranch`, collect
  their changed files, instruct the fixer NOT to recreate them.
- Commit the fix.
- Revert-on-overlap guard: if the resulting commit touches a sibling-owned file,
  revert the commit and escalate (do not push a sibling-overlapping change).

## MUST remove as live gates (FR-005)

- The one-attempt-per-distinct-evidence-hash cap — superseded by the shared
  `maxRemediations` counter enforced at the `on-remediation-limit` gate. The
  handler no longer short-circuits on a repeated evidence hash.
- The `resumeReason === 'base-advance'` coupling — the caller (phase loop) now
  invokes the adapter from the remediate seam regardless of resume reason (FR-004).
- Ownership of terminal escalation labels (`failed:validate`): the phase loop owns
  escalation now (fingerprint backstop → `failed:validate-repeated`; exhaustion →
  `waiting-for:remediation-limit`). The adapter MUST NOT apply `failed:*` labels.

## Behavior on adapter failure

- If `handle()` throws, the phase loop logs and continues; the subsequent
  delta-scoped `review` re-run + `validate` re-run (or a repeated identical
  failure → fingerprint backstop) provide the terminal safety net. The adapter is
  best-effort interim behavior, not a hard dependency of the routing.

## Out of scope

- Cloud-side relay/UX for the retired `cluster.validate-fix` channel.
- Full retirement of the handler (deferred until the real `remediate` executor).

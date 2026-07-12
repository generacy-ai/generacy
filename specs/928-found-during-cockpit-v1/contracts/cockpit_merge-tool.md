# Contract: `cockpit_merge` MCP tool

## Input schema (Zod)

```ts
// packages/generacy/src/cli/commands/cockpit/mcp/schemas.ts
export const CockpitMergeInputSchema = z
  .object({
    issue: IssueRefInputSchema,               // renamed from `pr`
    pr: z.number().int().positive().optional(),  // NEW — escape hatch
  })
  .strict();
```

Where `IssueRefInputSchema` = `IssueRefObjectSchema | IssueRefStringSchema` (defined at `schemas.ts:32`).

## JSON-Schema equivalent (for MCP `registerTool` inputSchema)

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["issue"],
  "properties": {
    "issue": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["owner", "repo", "number"],
          "properties": {
            "owner":  { "type": "string", "minLength": 1, "pattern": "^[^/\\s]+$" },
            "repo":   { "type": "string", "minLength": 1, "pattern": "^[^/\\s#]+$" },
            "number": { "type": "integer", "exclusiveMinimum": 0 }
          }
        },
        { "type": "string", "minLength": 1 }
      ]
    },
    "pr": { "type": "integer", "exclusiveMinimum": 0 }
  }
}
```

## Output — success (`status: "ok"`)

```json
{
  "status": "ok",
  "data": {
    "pr": {
      "owner":  "generacy-ai",
      "repo":   "generacy",
      "number": 15,
      "url":    "https://github.com/generacy-ai/generacy/pull/15"
    },
    "action":       "merged",
    "checksState":  "success",
    "mergeCommitSha": "abc123…"
  }
}
```

The `data.pr` field describes the PR that was merged (the *resolved* PR, not the *input* issue).
`mergeCommitSha` is present iff `action === "merged"` and the merge API returned a sha.

## Output — error (`status: "error"`)

### `class: "invalid-args"`

Emitted when:
- Zod schema rejects the payload (unknown key, missing required, wrong type).
- Old `pr: <IssueRefInput>` shape (post-rename). Detail carries the redirection copy: `the 'pr' field was renamed to 'issue'; pass the issue ref, not the PR number`.
- Bare-string `issue` (e.g. `"928"`, `"#928"`) that does not match a qualified form (`<owner>/<repo>#<n>` or a GitHub URL). Detail names accepted forms.

```json
{
  "status": "error",
  "class":  "invalid-args",
  "detail": "the 'pr' field was renamed to 'issue'; pass the issue ref, not the PR number"
}
```

### `class: "wrong-kind"`

Emitted when the resolved number classifies as a **pull request**, not an issue. Two paths reach this state:

1. Object / URL input whose live classification is a PR — caught inside `normalizeIssueRef({ expects: 'issue' })` before `runMerge` is called.
2. Object input whose bare number matches a PR node — caught inside `runMerge` via the new `resolveIssueToPRRef` arm `{ kind: 'pr-number' }`, then translated by `toMcpResult`.

Both emit shape-identical results:

```json
{
  "status": "error",
  "class":  "wrong-kind",
  "detail": "#15 is a pull request; pass the issue number, e.g. #2",
  "hint":   "cockpit_merge accepts an issue ref (mirroring `cockpit merge <issue>`); to skip issue→PR resolution, use the optional `pr` parameter."
}
```

### `class: "gate-refusal"`

Emitted when `runMerge` returns exit-2 with any of these `reason` values:
- `unresolved` — no PR linked to the issue via closing-refs, branch-name, or PR-body tiers.
- `ambiguous-resolution` — multiple open PRs link to the issue.
- `pr-is-draft` — only-draft PRs link to the issue.
- `checks-failing` — required checks are red on the linked PR.

Also emitted at exit-3 (any reason).

```json
{
  "status": "error",
  "class":  "gate-refusal",
  "detail": "no PR linked to issue #2 via closing-refs, branch-name, or PR-body"
}
```

### `class: "transport"`

Emitted at exit-1: `gh` transport failure, network error, or other communication fault.

```json
{
  "status": "error",
  "class":  "transport",
  "detail": "gh issue view: exit code 1"
}
```

### `class: "internal"`

Emitted when CLI stdout is non-JSON, or an uncaught exception traverses `wrapToolBoundary`.

## `pr` escape-hatch semantics

When `input.pr` is present:
- Handler calls `runMergeWithExplicitPr({ gh, issue: normalized.value.ref.number, repo: normalized.value.ref.nwo, prNumber: input.pr, logger })`.
- Same safety preconditions apply: linkage verification (PR #`pr` must declare the resolved issue as a closing issue), state (open, not draft, not closed-without-merge), `completed:validate`, every required check green.
- Never a resolution bypass of safety.

Linkage-refusal example:

```json
{
  "status": "error",
  "class":  "gate-refusal",
  "detail": "--pr 15 refused: PR #15 does not declare generacy-ai/generacy#2 as a closing issue. Add generacy-ai/generacy#2 via the PR's Development sidebar link, then re-run."
}
```

## Parity guarantee (SC-004)

For every input `I`, calling
- `cockpit_merge(I)` on MCP → `MCPResult`
- `cockpit merge <I.issue> [--pr <I.pr>] --json` on CLI → `{ stdout, exitCode }`

the invariant `toMcpResult(stdout, exitCode)` deep-equals `MCPResult` holds — for all success and error branches.

`toMcpResult` lives at `packages/generacy/src/cli/commands/cockpit/mcp/errors.ts` and *is* the transport contract.

## Idempotency

- Merge is idempotent at the GitHub side (re-merging a merged PR is a no-op via `gh pr merge`). If the PR is already merged, `runMerge`'s exit-0 path returns and the tool result is `status: "ok"`, `action: "merged"`.
- The escape-hatch `pr` parameter does not affect idempotency.

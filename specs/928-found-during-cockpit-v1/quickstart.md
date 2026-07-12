# Quickstart: cockpit_merge issue-ref contract fix (#928)

## What changed

`cockpit_merge` MCP tool now accepts an **issue ref** (matching its CLI verb `cockpit merge <issue>`), with an optional `pr` parameter as the escape hatch (mirroring CLI `--pr <number>`). Old behavior — passing a PR ref — now returns a typed `wrong-kind` error with self-teaching copy.

## Verify locally

Assumes you have `pnpm install`-ed and the packages build cleanly.

```bash
# Type-check + build
pnpm --filter @generacy-ai/cockpit build
pnpm --filter @generacy-ai/generacy build

# Run this spec's tests
pnpm --filter @generacy-ai/generacy test packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-merge.test.ts
pnpm --filter @generacy-ai/generacy test packages/generacy/src/cli/commands/cockpit/mcp/__tests__/envelope-mapping.test.ts
pnpm --filter @generacy-ai/generacy test packages/generacy/src/cli/commands/cockpit/mcp/__tests__/tool-schema-audit.test.ts
pnpm --filter @generacy-ai/cockpit test packages/cockpit/src/gh/__tests__/wrapper.tier1-shape-drift.test.ts
```

## Usage — MCP transport

### Happy path

```json
{
  "tool": "cockpit_merge",
  "input": {
    "issue": { "owner": "generacy-ai", "repo": "generacy", "number": 928 }
  }
}
```

Response:

```json
{
  "status": "ok",
  "data": {
    "pr": { "owner": "generacy-ai", "repo": "generacy", "number": 950, "url": "https://github.com/generacy-ai/generacy/pull/950" },
    "action": "merged",
    "checksState": "success",
    "mergeCommitSha": "abc123…"
  }
}
```

### Escape hatch (`pr` parameter, mirrors CLI `--pr <number>`)

Use when the resolver can't find the PR (deleted PR body, ambiguous branch names, etc.) and you know which PR to merge. All safety preconditions still apply.

```json
{
  "tool": "cockpit_merge",
  "input": {
    "issue": { "owner": "generacy-ai", "repo": "generacy", "number": 928 },
    "pr": 950
  }
}
```

If PR #950 does not declare issue #928 as a closing issue → `class: "gate-refusal"` with guidance to add the closing-issue linkage via the PR's Development sidebar.

### Wrong-kind (passed a PR where an issue was expected)

```json
{
  "tool": "cockpit_merge",
  "input": {
    "issue": { "owner": "generacy-ai", "repo": "generacy", "number": 950 }
  }
}
```

`#950` is a pull request. Response:

```json
{
  "status": "error",
  "class": "wrong-kind",
  "detail": "#950 is a pull request; pass the issue number, e.g. #928",
  "hint": "cockpit_merge accepts an issue ref (mirroring `cockpit merge <issue>`); to skip issue→PR resolution, use the optional `pr` parameter."
}
```

### Bare string on MCP

```json
{
  "tool": "cockpit_merge",
  "input": { "issue": "928" }
}
```

Response:

```json
{
  "status": "error",
  "class": "invalid-args",
  "detail": "MCP requires qualified issue refs: `<owner>/<repo>#<n>`, a full GitHub URL, or a structured { owner, repo, number } object. Got: \"928\"."
}
```

### Old field name `pr: <IssueRefInput>` (migration)

```json
{
  "tool": "cockpit_merge",
  "input": { "pr": { "owner": "generacy-ai", "repo": "generacy", "number": 928 } }
}
```

Response:

```json
{
  "status": "error",
  "class": "invalid-args",
  "detail": "the 'pr' field was renamed to 'issue'; pass the issue ref, not the PR number"
}
```

## Usage — CLI transport (unchanged interface, new safety)

```bash
generacy cockpit merge 928
generacy cockpit merge 928 --pr 950
```

**New**: `generacy cockpit merge 950` where 950 is a PR — previously a confusing "unresolved" error, now returns exit-2 with:

```
#950 is a pull request; pass the issue number (e.g. the issue whose closing PR is #950).
```

This closes finding #906.

## Callers — playbook migration

Search agencies and post-#406 playbooks for the old field name:

```bash
git grep -n "cockpit_merge" -- 'agency/**' 'specs/**'
```

For each match that carries `{ pr: … }` (with an object or string value, not a number), rename the field to `issue`. The old `pr: <IssueRefInput>` shape now errors out with the redirection message — self-teaching for LLM callers, but a playbook example carrying the old field wastes the LLM's turn.

## Troubleshooting

### "tool returns `wrong-kind` and I'm sure I passed an issue"

- Check the number. `gh browse <n>` — if the URL is `/pull/<n>`, it's a PR.
- The MCP tool now classifies via `resolveIssueToPRRef` tier-1 (GraphQL). If GitHub's node system reports `PullRequest`, the tool refuses.

### "tool returns `invalid-args` on a valid-looking string ref"

- MCP requires qualified refs. Accepted forms:
  - `"generacy-ai/generacy#928"`
  - `"https://github.com/generacy-ai/generacy/issues/928"`
  - `{ "owner": "generacy-ai", "repo": "generacy", "number": 928 }`
- Bare `"928"` or `"#928"` is rejected on MCP (accepted on CLI where cwd inference works). This is deliberate per clarifications Q1.

### "audit test fails after I added a new MCP tool"

- Open `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/tool-schema-audit.test.ts`.
- Add a row to `EXPECTED_KIND` for your new tool, mapped to `'issue'` or `'epic'`.
- Ensure your MCP handler's `normalizeIssueRef` `expects` value and your CLI verb's `.argument('<TOKEN>', …)` both match your table entry.

### "resolver returns `pr-number` but I expected `unresolved`"

- Tier-1 detected the input number is a `PullRequest` node. This takes precedence over `unresolved` — it's a *different* failure. The caller passed the wrong kind, not a number-with-no-linked-PR.
- If you *want* to merge a PR by number, use the `pr` escape hatch: `cockpit_merge({ issue: <the-issue>, pr: <the-pr> })`. The `pr` parameter accepts a bare number; only the `issue` field requires a full ref.

## Rollback / follow-up

- If the resolver's new `pr-number` arm proves too noisy on real repos (e.g. `gh` version drift on the tier-1 GraphQL response shape), the fallback is:
  - Keep the arm.
  - Move the classification to an MCP handler pre-flight — one `gh api /repos/{o}/{r}/issues/{n}` call before `runMerge` (adds one round-trip; loses the CLI-side fix for #906).
- The audit test's hardcoded table is the forcing function: if a new MCP tool ships without updating the table, CI fails. Do not weaken this to a warning.

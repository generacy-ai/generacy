# Contract: schema-audit test — per-verb ref-kind table

## Location

`packages/generacy/src/cli/commands/cockpit/mcp/__tests__/tool-schema-audit.test.ts` (NEW).

## Independent source-of-truth

Per Q3 → B, the test carries its own hardcoded table. No import of a shared registry (that would drift toward tautology). No parser of Commander usage strings (that would miss both-sides-drift-together, which is this finding's history).

```ts
const EXPECTED_KIND: Record<string, 'issue' | 'epic'> = {
  cockpit_status:       'epic',
  cockpit_context:      'issue',
  cockpit_advance:      'issue',
  cockpit_resume:       'issue',
  cockpit_queue:        'epic',
  cockpit_merge:        'issue',
  cockpit_await_events: 'epic',
};
```

## Assertions

For each `[toolName, expectedKind]` in the table:

### 1. MCP handler assertion

Load the MCP tool source file (`packages/generacy/src/cli/commands/cockpit/mcp/tools/${toolName}.ts`). Grep for the `normalizeIssueRef({ expects: <kind> })` string literal (or the `EpicRefInputSchema` marker for `epic`-kind tools that don't currently call `normalizeIssueRef`). Assert equality with `expectedKind`.

Concrete regex (case-sensitive, whitespace-tolerant):

```ts
/expects:\s*['"](issue|pr|epic)['"]/
```

For `epic`-kind tools that use `EpicRefInputSchema` (like `cockpit_queue`, `cockpit_status`, `cockpit_await_events` which today don't run a live kind check), the assertion is that the input schema is `EpicRefInputSchema` (which is a shape-identical alias of `IssueRefInputSchema` — see `schemas.ts:36`). Since `epic` doesn't have a semantic classifier today (there's no `isEpic()` gh call), the schema-name discipline is the audit's mechanism for that arm.

### 2. CLI verb assertion

Load the corresponding CLI command file:
- `cockpit_advance` → `packages/generacy/src/cli/commands/cockpit/advance.ts`
- `cockpit_context` → `.../context.ts`
- `cockpit_merge` → `.../merge.ts`
- etc.

Grep for `.argument('<TOKEN>', ...)`. Canonicalize `TOKEN`:
- `<issue>`, `<issue-ref>`, `<pr-ref>` (the last is DEPRECATED; audit catches it if it still exists) → `issue`
- `<epic>`, `<epic-ref>` → `epic`

Assert equality with `expectedKind`.

If the token is `<pr-ref>` → **fail loudly** with a message directing the maintainer to this spec (#928): the CLI verb still uses PR-ref language even though the MCP contract expects `issue`. This is the drift this spec exists to end.

### 3. New-verb forcing function

The test file's top-level `describe` iterates `EXPECTED_KIND`. Adding a new MCP tool without adding a row means the test doesn't cover it — no failure. To catch this, add a separate assertion:

```ts
it('table covers every registered MCP tool', () => {
  const registeredNames = getRegisteredToolNames(); // introspect server.ts
  const tableKeys = Object.keys(EXPECTED_KIND);
  expect([...tableKeys].sort()).toEqual([...registeredNames].sort());
});
```

`getRegisteredToolNames` reads `server.ts` and greps for `server.registerTool('<name>', …)` — the same discipline as the audit itself. Alternative: import the tool registration function and instrument it — but that risks importing side effects during test, which the schema-audit test should avoid.

## Failure output

When a mismatch is detected, the assertion message must:
- Name the tool (`cockpit_merge`).
- State the expected kind (`issue`).
- State the found kind (`pr` — the docstring or schema still claims PR-ref).
- Reference the spec: `See #928 or specs/928-found-during-cockpit-v1/spec.md § "Fix"`.

Example:

```
✗ cockpit_merge — expected kind 'issue', found 'pr'
  MCP handler in packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_merge.ts
  declares expects: 'pr' at line 49.
  See #928 or specs/928-found-during-cockpit-v1/spec.md § "Fix" for the corrected contract.
```

## Drift modes caught

- **MCP-vs-table drift**: MCP handler says `expects: 'pr'`, table says `'issue'` → fails on assertion 1.
- **CLI-vs-table drift**: CLI verb argument is `<pr-ref>`, table says `'issue'` → fails on assertion 2.
- **Both-sides-drift-together**: MCP and CLI both agree on `'pr'`, table says `'issue'` → **both assertions fail** — the independent third opinion catches this.
- **Table-not-covered drift**: new MCP tool registered but no row added → fails on the coverage assertion.

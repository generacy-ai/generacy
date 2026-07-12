# Data Model: cockpit_merge issue-ref contract fix

## Core Types

### `PullRequestRefResolution` (EXTENDED)

Location: `packages/cockpit/src/gh/wrapper.ts:80-84`.

```ts
export type PullRequestRefResolution =
  | { kind: 'resolved'; ref: PullRequestRef; linkMethod: LinkMethod }
  | { kind: 'ambiguous'; candidates: PullRequestRef[]; linkMethod: LinkMethod }
  | { kind: 'pr-is-draft'; candidates: PullRequestRef[]; linkMethod: LinkMethod }
  | { kind: 'unresolved' }
  | { kind: 'pr-number' };   // NEW — the requested `<issue>` is itself a PR node.
```

**Invariants** (extend the existing set at `wrapper.ts:71-79`):

- **I-6**: `kind === 'pr-number'` ⇒ no other fields present (zero-field variant, matches `unresolved`). The offending number is the caller's `issue` argument; the resolver does not repeat it.
- **I-7**: `resolveIssueToPRRef` returns `pr-number` **only** from tier-1's classification path. Tiers 2 (branch-name) and 3 (pr-body) do not classify — if tier-1 returned no `pr-number` signal, the downstream tiers cannot invent one. This preserves the "detection is where classification data already exists" principle.

**Emitter**: `resolveIssueToPRRef` in `packages/cockpit/src/gh/wrapper.ts`, tier-1 path only.

**Consumers**:
- `runMerge` (`packages/generacy/src/cli/commands/cockpit/merge.ts:309`) — new branch emits exit-2 with `reason: 'pr-number'` and guidance stdout.
- Direct tests in `packages/cockpit/src/__tests__/gh-wrapper.test.ts` and `packages/cockpit/src/gh/__tests__/wrapper.tier1-shape-drift.test.ts`.

### `CockpitMergeInput` (RENAMED + EXTENDED)

Location: `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_merge.ts:16-18`.

```ts
export interface CockpitMergeInput {
  issue: IssueRefInput;   // RENAMED from `pr` (Q5 → B: hard break, targeted redirection message).
  pr?: number;            // NEW — optional escape hatch, mirrors CLI `--pr <number>`.
}
```

**Zod schema** at `packages/generacy/src/cli/commands/cockpit/mcp/schemas.ts:86`:

```ts
export const CockpitMergeInputSchema = z
  .object({
    issue: IssueRefInputSchema,
    pr: z.number().int().positive().optional(),
  })
  .strict();
```

**Validation rules**:

- `.strict()` rejects unknown keys — including the old `pr: <IssueRefInput>` shape.
- When the raw input carries a `pr` key whose type is non-numeric (i.e. someone still sending the old shape), the tool handler overrides the Zod error detail with the redirection copy: `"the 'pr' field was renamed to 'issue'; pass the issue ref, not the PR number"` (Q5 → B).
- On the MCP transport, if `input.issue` is a bare string, the tool handler applies a qualified-forms check *before* calling `normalizeIssueRef` and rejects with `class: 'invalid-args'` naming the accepted forms (Q1 → A). The check regex: `/^([^/\s]+)\/([^/\s#]+)#(\d+)$/` OR a valid GitHub URL (matched by the existing URL parser in `resolver.ts`). This check is a helper (`assertQualifiedString`) shared across the seven MCP tools.

### `CockpitMergeData` (UNCHANGED)

Location: `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_merge.ts:20-27`.

No shape change. Continues to describe the resolved PR (not the input issue) in its `pr` field:

```ts
export interface CockpitMergeData {
  pr: { owner: string; repo: string; number: number; url: string };
  action: 'merged' | 'blocked';
  checksState: 'success' | 'failure' | 'pending' | 'none';
  mergeCommitSha?: string;
  reason?: string;
  raw?: unknown;
}
```

Field-name reuse (`pr` in input as escape-hatch number, `pr` in output as resolved PR object) is intentional: input `pr` is the number a caller passed *to skip resolution*; output `pr` is the PR the tool *acted upon*. Different structural shapes (`number` vs `object`) prevent confusion, and the output name matches the CLI JSON payload for parity.

### `ToolErrorResult.class` (VALUE ADDITION)

Location: `packages/generacy/src/cli/commands/cockpit/mcp/errors.ts:15-24`.

Existing enum `ErrorClass` already contains `'wrong-kind'` — no change. But its emission surface expands: previously emitted only by `normalizeIssueRef` for the URL/structured-object PR case; now also emitted by `toMcpResult` when the CLI reports `reason: 'pr-number'` at exit-2.

### `toMcpResult` (NEW)

Location: `packages/generacy/src/cli/commands/cockpit/mcp/errors.ts` (extend existing file).

```ts
export function toMcpResult<T>(
  cliJsonStdout: string,
  exitCode: number,
): ToolResult<T>;
```

**Contract table** (per Q4 → B — this table *is* the transport contract):

| exit | parsed.reason           | ToolResult class      |
|------|-------------------------|-----------------------|
| 0    | — (any)                 | `ok`, `data: parsed`  |
| 2    | `'pr-number'`           | `wrong-kind` + `hint` |
| 2    | `'unresolved'`          | `gate-refusal`        |
| 2    | `'ambiguous-resolution'`| `gate-refusal`        |
| 2    | `'pr-is-draft'`         | `gate-refusal`        |
| 2    | `'checks-failing'`      | `gate-refusal`        |
| 2    | (other / missing)       | `invalid-args`        |
| 3    | (any)                   | `gate-refusal`        |
| 1    | (any)                   | `transport`           |
| ≥4   | (any)                   | `internal`            |

**JSON-parse failure on `cliJsonStdout`**: `class: 'internal'`, `detail: 'CLI produced non-JSON stdout'`.

**Invariant**: this table's rows are the *only* mapping. Any new `reason` string introduced in `runMerge` requires a row here (unit test in `envelope-mapping.test.ts` catches the omission).

### CLI Payload Shape (EXTENDED)

Location: `packages/generacy/src/cli/commands/cockpit/merge.ts` — `buildFailingCheckPayload`.

Existing `reason` values: `'unresolved' | 'ambiguous-resolution' | 'pr-is-draft' | 'checks-failing'`. ADD: `'pr-number'`.

When emitted:

```json
{
  "reason": "pr-number",
  "pr": null,
  "issue": { "owner": "…", "repo": "…", "number": 15 },
  "hint": "#15 is a pull request; pass the issue number (e.g. the issue whose closing PR is #15)."
}
```

The `hint` field is new for this arm. `toMcpResult` copies `parsed.hint` into `ToolErrorResult.hint`.

## Relationships

```
                            ┌────────────────────────────────────┐
                            │  CockpitMergeInputSchema (Zod)     │
                            │  { issue: IssueRefInput, pr?: n }  │
                            └───────────────┬────────────────────┘
                                            │ parse
                                            ▼
             ┌──────────────────────────────────────────────────┐
             │  cockpit_merge handler                            │
             │  1. .strict() reject → typed redirection copy     │
             │  2. bare-string issue → qualified-forms rejection │
             │  3. normalizeIssueRef({ expects: 'issue' })       │──► classifies URL/object refs
             │  4. if input.pr → runMergeWithExplicitPr          │
             │     else       → runMerge                         │
             │  5. toMcpResult(result.stdout, result.exitCode)   │
             └───────────────┬──────────────────────────────────┘
                             │
                             ▼
             ┌────────────────────────────────────────┐
             │  runMerge                              │
             │  resolveIssueToPRRef → discriminated:  │
             │    'resolved'    → merge               │
             │    'ambiguous'   → exit-2 + payload    │
             │    'pr-is-draft' → exit-2 + payload    │
             │    'unresolved'  → exit-2 + payload    │
             │    'pr-number'   → exit-2 + payload ★  │  ★ NEW
             └────────────────────────────────────────┘
```

The new arm at every layer:

- **Resolver**: emit `{ kind: 'pr-number' }` when tier-1 classifies input as a PR node.
- **CLI**: consume the new arm, emit exit-2 with `reason: 'pr-number'` and `hint` copy.
- **MCP handler → toMcpResult**: map `exit=2 + reason='pr-number'` to `class: 'wrong-kind'`.

## Reference-Kind Audit Table

Location: `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/tool-schema-audit.test.ts` (NEW).

```ts
const EXPECTED_KIND: Record<MpcToolName, 'issue' | 'epic'> = {
  cockpit_status:       'epic',
  cockpit_context:      'issue',
  cockpit_advance:      'issue',
  cockpit_resume:       'issue',
  cockpit_queue:        'epic',
  cockpit_merge:        'issue',   // ← this spec changes this from what the code currently claims ('pr').
  cockpit_await_events: 'epic',
};
```

**Note**: `'pr'` is not a valid kind in the audit table. `cockpit_merge` accepts an issue ref (post-fix) — the escape-hatch `pr: number` is not a *ref* kind, it's an override number.

## No Migrations Required

No stored state (Redis, filesystem, GitHub labels) changes. The change is code-only:
- Callers pass a different field name (`issue` not `pr`).
- Resolver returns one additional arm.
- Tool result envelope carries a new mapping row.

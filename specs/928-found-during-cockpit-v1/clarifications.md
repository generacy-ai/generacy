# Clarifications

## Batch 1 — 2026-07-12

### Q1: Bare-string `IssueRefInput` on MCP transport
**Context**: `IssueRefInputSchema` (`schemas.ts:32`) accepts either a structured `{ owner, repo, number }` object or a bare string. On the CLI, bare-string input flows through `resolveIssueContext` (per #822/#850), which requires a checkout with a resolvable GitHub origin (cwd inference) — MCP transport has no cwd. FR-001 says `cockpit_merge`'s input schema renames `pr → issue, typed as IssueRefInput`, but the spec is silent on what happens when the MCP client passes a bare string like `"928"` (unqualified) with no `owner`/`repo` context. This is the very ambiguity #850 tightened at the CLI layer, and re-appears verbatim at the MCP layer.
**Question**: When `cockpit_merge` receives a bare-string `issue` input (`"928"` or `"#928"`) on the MCP transport with no way to infer `owner`/`repo`, what is the handler's response?
**Options**:
- A: Schema-level rejection — `IssueRefInputSchema` (or the tool wrapper) refuses bare strings at MCP boundary with a typed error naming the required qualified forms (`<owner>/<repo>#<n>`, URL, or structured object). Bare strings are a CLI-only affordance; MCP requires explicit repo qualification.
- B: Accept and defer — pass the bare string to `normalizeIssueRef`/`resolveIssueContext` unchanged; whatever the CLI's cwd-less path already does (probably fail with the FR-002 rejection copy from #850's `resolver.ts:153`) surfaces as the MCP error. No new MCP-layer branch.
- C: Fall back to a workspace-scoped default repo carried in the MCP session (e.g., the epic's home repo from a prior `cockpit_status`), enabling bare strings when that context exists. Adds a new session-carried default.

**Answer**: *Pending*

### Q2: Wrong-kind detection locus (FR-004)
**Context**: FR-004 requires that a number resolving to a pull request (not an issue) produces a typed `wrong-kind` error. The Assumption at line 87 states "`runMerge` and its `resolveIssueToPRRef` codepath do not need behavioral changes — the bug is entirely at the MCP handler's contract boundary." But an issue-vs-PR classification for a given number requires a GitHub round-trip — either the MCP handler adds one before calling `runMerge`, or `runMerge` (or `resolveIssueToPRRef`) must return a discriminated result the handler can translate. The two paths differ in whether the Assumption is intact.
**Question**: Where does the "this number is a PR, not an issue" detection happen for FR-004's typed error?
**Options**:
- A: MCP handler pre-flight — before calling `runMerge`, the handler runs a lightweight `gh` classification (`gh api /repos/{o}/{r}/issues/{n}` and check the `pull_request` field) and returns the typed `wrong-kind` error itself. `runMerge` remains behaviorally unchanged. Adds one GitHub call per invocation.
- B: Bubbled from `resolveIssueToPRRef` — `runMerge` is unchanged behaviorally but its `unresolved` return already distinguishes "number-is-a-PR" from "no linked PR" (or is extended to do so via a discriminated result variant, treated as a non-behavioral shape change). MCP handler maps that variant to the typed `wrong-kind` error.
- C: `normalizeIssueRef({ expects: 'issue' })` handles it — extend the normalizer to perform issue-vs-PR classification when `expects: 'issue'` is set. Detection is centralized in the ref-input layer, shared with any future tool that adopts `expects: 'issue'`.

**Answer**: *Pending*

### Q3: Schema audit source-of-truth (FR-007)
**Context**: FR-007 mandates an audit test that "enumerates every `mcp/tools/*` handler, cross-references its `normalizeIssueRef({ expects })` value against the wrapped CLI verb's ref kind from its Commander usage string, and asserts equality." Commander usage strings (`<issue>`, `<pr-ref>`, `<epic>`, `<issue-ref>`) are free-form; parsing them to a canonical `'issue' | 'pr' | 'epic'` kind is brittle (typos, aliases). Alternative sources exist: a hardcoded per-verb table in the test, or a canonical registry exported alongside the CLI verb (`getExpectedRefKind(commandName)`). The audit's value as a drift-catcher depends entirely on how independent its source-of-truth is from the code it audits.
**Question**: Where does the audit test read each CLI verb's canonical ref kind from?
**Options**:
- A: Parse the Commander usage string with a token → kind table (`<issue>` → `issue`, `<pr-ref>` → `pr`, `<epic>` → `epic`, `<issue-ref>` → `issue`). Real drift-catcher if the CLI command file is the source; fragile to CLI rename.
- B: Hardcoded per-verb table in the test (`{ advance: 'issue', merge: 'issue', queue: 'epic', ... }`). Zero parsing; independent source-of-truth; drift-catcher requires the maintainer to update the test when adding a verb (which is the desired forcing function).
- C: New exported registry (`packages/generacy/src/cli/commands/cockpit/ref-kinds.ts` or similar) that each CLI verb file imports and re-declares its kind against. Audit reads the registry. Single-source-of-truth AND drift-catcher, but adds a new module for the seven verbs.

**Answer**: *Pending*

### Q4: Parity test scope for error branches (FR-009)
**Context**: FR-009 says the parity test asserts `cockpit_merge` result "deep-equals `cockpit merge <issue> --json` for the same input." Deep-equal is well-defined on success; on error paths the CLI writes JSON to stderr with an exit code, while the MCP handler returns a typed `ToolResult` (`{ status: 'error', class, detail }`). "Deep-equal" cannot literally hold across those two shapes without a mapping. SC-004 has the same wording. Whether the parity test covers error branches determines both its power (does it catch a divergent `wrong-kind` message?) and its scope (a wire-shape mapping table becomes required).
**Question**: Does the FR-009 / SC-004 parity assertion cover error branches, and if so how is "deep-equal" defined across the CLI stderr JSON envelope and the MCP `ToolResult` envelope?
**Options**:
- A: Success branches only. Error branches are covered separately by per-verb error-shape fixtures. Parity test deep-equals the CLI `--json` stdout against the MCP `data` field.
- B: All branches, with a canonical envelope-mapping helper (`toMcpResult(cliJsonOutput, exitCode)`) applied to the CLI output before deep-equal. The helper's mapping table (`exit=2 → class:'invalid-args'`, `exit=3 → class:'gate-refusal'`, ...) IS the contract.
- C: All branches, structural equality on a normalized subset (compare `status`, `class`, `reason`/`detail`, and PR ref shape — ignore transport-specific fields like `exitCode`, `stdout` raw string). Weaker than B, no helper needed.

**Answer**: *Pending*

### Q5: Backward compatibility for `pr` → `issue` field rename
**Context**: FR-001 renames the input field from `pr` to `issue`. Because the tool is "unusable for all inputs" today, no client can currently pass `pr` successfully — the rename is technically zero-consumer. But client-side code, autocomplete lists, MCP-consumer LLM prompts, and generated docs may reference the old `pr` field name. The spec doesn't state whether the rename is a hard break or has an alias/deprecation window. Deciding this affects the schema definition (add `.transform` for alias?), the error message when `pr` is passed, and downstream MCP client codegen.
**Question**: When an MCP client passes the old `{ pr: <ref> }` payload, what does `cockpit_merge` do?
**Options**:
- A: Hard-break, no alias — `.strict()` on the schema rejects the unknown key `pr` with a generic Zod parse error. Simplest; consistent with "no consumer today" reality.
- B: Hard-break with a targeted redirection error — schema rejects but returns a typed error with copy like `"the 'pr' field was renamed to 'issue'; pass the issue ref, not the PR number"`. Aids client migration; extra code in the tool handler.
- C: Accept-and-deprecate — schema treats `pr` as an alias for `issue` (with a warning log line on the server side) for one release. Removed in a follow-up. Maximum backward-compat safety at the cost of encoding the very inversion this spec exists to end.

**Answer**: *Pending*

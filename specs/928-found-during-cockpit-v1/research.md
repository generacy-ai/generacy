# Research: cockpit_merge issue-ref contract fix

## Decision 1 — Locus of wrong-kind detection: resolver-bubbled, not MCP pre-flight

**Decision**: Extend `PullRequestRefResolution` in `packages/cockpit/src/gh/wrapper.ts` with a `{ kind: 'pr-number' }` arm. Detection happens inside `resolveIssueToPRRef`; MCP handler translates the arm to a typed `wrong-kind` `ToolErrorResult`.

**Rationale**:

- Free: post-#913, tier-1 is an explicit GraphQL query. GraphQL distinguishes `Issue` from `PullRequest` natively — same query that finds no closing refs can report "this number is a PullRequest" with zero extra round-trips. An MCP pre-flight `gh api /repos/{o}/{r}/issues/{n}` adds one call per invocation to learn something the resolver already touched.
- Fixes both transports at once. `cockpit merge 15` on the CLI deserves the same guidance ("#15 is a pull request; pass the issue number"). This is exactly finding #906. Bubbling from the resolver implements and closes it.
- Preserves the #904 Q5 discriminated-union pattern: adding one arm to a proven discriminated shape is preferred over introducing a parallel classifier layer.

**Alternatives considered**:

- **MCP handler pre-flight** (`gh` call before `runMerge`): fixes only the MCP transport, adds one round-trip per invocation, requires new synchronization if the classifier and resolver disagree at the millisecond boundary (a PR was just merged and then transformed into an issue — negligible but the code has to defend it).
- **`normalizeIssueRef({ expects: 'issue' })` handles it**: mixes network I/O into a pure parser layer. `normalizeIssueRef` today classifies via `gh.getIssue()` for the URL/structured object case, which already does one round-trip. Extending it to run classification for *every* input including bare numbers spreads the responsibility, and — critically — misses the "structured `{ owner, repo, number }` where number is a PR" case whose live classification is exactly the resolver's job.

**Answered by** clarifications Q2 → B, amending the spec's Assumption ("no behavioral changes to `runMerge`/`resolveIssueToPRRef`") to allow a shape change (new arm) that is not a behavior change to any existing path.

**Sources**: `packages/cockpit/src/gh/wrapper.ts:80-84` (union today), `packages/cockpit/src/gh/wrapper.ts:888-904` (resolver body), spec § "Root cause".

## Decision 2 — MCP bare-string handling: schema-level rejection

**Decision**: `IssueRefInputSchema` at the MCP boundary refuses bare strings with a typed `class: 'invalid-args'` error whose detail names the required qualified forms (`<owner>/<repo>#<n>`, URL, or structured `{ owner, repo, number }` object). Structured object form remains fully supported.

**Rationale**:

- The MCP server's cwd is an accident of how the entrypoint spawned it. Accepting bare strings and deferring to `resolveIssueContext` makes the tool's behavior depend on that accident — works when the spawn cwd has the right origin, fails otherwise. Non-deterministic contract.
- Leaks CLI-internal rejection copy through the MCP boundary if the deferred path errors (the copy hardcoded at `resolver.ts:153` in #850 was designed for CLI users, not agent callers).
- The calling agent always knows the epic's owner/repo (it's driving a named epic). Explicit qualification costs the caller nothing, and the typed rejection makes the requirement self-teaching on first contact.

**Alternatives considered**:

- **Accept and defer** (B in the clarification): re-encodes the CLI's cwd-based inference in the MCP layer, inheriting the non-determinism.
- **Workspace-scoped default from prior `cockpit_status`**: invents session-carried hidden state — precisely the implicit-context ambiguity #850 spent a finding removing at the CLI layer. Doing it again at the MCP layer is the drift pattern in reverse.

**Answered by** clarifications Q1 → A.

**Note**: this affects *how* `IssueRefStringSchema`-typed inputs are validated on the MCP transport. The schema is shared with the CLI (which does want bare-string cwd inference), so the rejection must happen at the *tool boundary*, not the schema itself. Implementation: the MCP tool handler, before calling `normalizeIssueRef`, inspects `typeof input.issue === 'string'` and checks that the string is qualified (regex: `^([^/\s]+)/([^/\s#]+)#(\d+)$` or a `https://github.com/…` URL). If not, returns the typed error. A helper in `mcp/ref-input.ts` (`assertQualifiedString`) will keep this logic DRY across the seven tools.

## Decision 3 — Schema audit source-of-truth: hardcoded per-verb table

**Decision**: New test file `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/tool-schema-audit.test.ts` carries a hardcoded `Record<toolName, 'issue' | 'epic'>` table. For each entry: assert the corresponding MCP handler's `normalizeIssueRef({ expects })` value equals the table's value; assert the corresponding CLI verb's Commander usage string (`<issue>` / `<epic>` / `<pr-ref>` / `<issue-ref>`) canonicalizes to the same value.

**Rationale**:

- Independence. The audit's entire value is being an independent third opinion. A parser that reads the Commander usage string (option A) catches MCP-vs-CLI drift but misses the both-sides-drift-together case — which is *this* finding's actual history. Someone consistently believed merge takes PR refs across layers; every artifact-vs-artifact comparison passes when both share the same wrong belief.
- A hardcoded table catches all three drift modes: MCP-vs-table, CLI-vs-table, both-sides-drift-together.
- Maintenance cost — update the table when adding a verb — is the forcing function working as intended. Seven entries is not a burden.

**Alternatives considered**:

- **Parse Commander usage string** (A): fragile to token variants (`<issue>` vs `<issue-ref>` vs `<pr-ref>`), fragile to CLI rename, and — critically — passes when both sides drift together.
- **Exported registry that CLI verb files import** (C): drifts toward tautology the moment implementations start importing it. The audit becomes "does the registry agree with the registry?"

**Answered by** clarifications Q3 → B.

## Decision 4 — Parity test scope: all branches with envelope-mapping helper

**Decision**: Introduce `toMcpResult(cliJsonStdout: string, exitCode: number): ToolResult<T>` in `packages/generacy/src/cli/commands/cockpit/mcp/errors.ts`. Its mapping table (`exit=2 → invalid-args` unless `reason === 'pr-number'` → `wrong-kind`; `exit=3 → gate-refusal`; `exit=1 → transport`; `exit=0 → ok with data`) *is* the transport contract. Parity test asserts `toMcpResult(cliOutput, exitCode)` deep-equals `mcpResult` for every branch — happy path and every error path.

**Rationale**:

- The error branches are where this finding lived. A parity test that skips them (A: success-only) would have passed over the very divergence that mattered.
- The `wrong-kind` guidance copy is part of what must stay in lockstep across transports. If the CLI's copy diverges from the MCP tool's copy on the same exit code, the audit table won't catch it — parity will.
- The mapping table already exists implicitly in every handler's head today. B's helper makes it one testable artifact — the same move as #915's classifier field and #904's linkMethod (implicit correspondences promoted to explicit contracts).

**Alternatives considered**:

- **Success-only parity** (A): would have missed exactly this finding.
- **Normalized structural equality** (C): B with the completeness sanded off. Hides the mapping inside "normalization" logic instead of promoting it to a named artifact.

**Answered by** clarifications Q4 → B.

**Implementation note**: the helper lives in `errors.ts` because it's the counterpart to `mapCockpitExitToToolError` (which already exists at `errors.ts:41-53` for the thrown-`CockpitExit` case). `mapCockpitExitToToolError` handles the throw path; `toMcpResult` handles the `RunMergeResult`-returned path.

## Decision 5 — Old-field-name migration: hard break with targeted redirection error

**Decision**: Schema treats `pr` (with a non-numeric type — i.e. an `IssueRefInput`) as a strict-mode rejection but overrides the Zod message with the targeted copy: `"the 'pr' field was renamed to 'issue'; pass the issue ref, not the PR number"`. The optional `pr: number` escape hatch is unaffected.

**Rationale**:

- LLM agents are the callers. B's copy is one-shot self-healing (read, correct, proceed); A's generic Zod "unknown key 'pr'" error buys a diagnosis round instead. Burning diagnosis rounds on ref-kind confusion is literally the drift pattern this finding is closing.
- Aliasing `pr` (C) re-encodes the very inversion this spec exists to end. Non-starter.
- Companion sweep: `git grep "cockpit_merge" agency/` (and post-#406 migrated playbook locations) to correct existing example payloads carrying the old field name.

**Alternatives considered**:

- **Silent Zod unknown-key error** (A): correct behavior, wrong caller optimization.
- **Alias `pr` for `issue`** (C): defeats the purpose.

**Answered by** clarifications Q5 → B.

## Decision 6 — Optional `pr` parameter mirrors `--pr <number>`

**Decision**: The MCP tool exposes an optional `pr: z.number().int().positive()` parameter. When present, the handler calls `runMergeWithExplicitPr` (already exists at `merge.ts:398`) instead of `runMerge`. All existing linkage-verification and safety preconditions (#913) apply unchanged.

**Rationale**:

- FR-003 requires it. The `--pr` escape hatch (#913) is the CLI's answer to resolver-blind-spot cases (deleted PR body, weird branch names, etc.). Parity means the MCP tool needs the same escape hatch.
- No new safety surface. `runMergeWithExplicitPr` already gates on: linkage verification (PR declares issue as closing), state (open, not draft, not closed-without-merge), completed:validate, and every required check green. The `pr` parameter skips *resolution*, never *safety*.

**Sources**: `packages/generacy/src/cli/commands/cockpit/merge.ts:398-469` (`runMergeWithExplicitPr` body), spec § Fix #3.

## Implementation Patterns

- **Discriminated union extension**: match the existing pattern in `PullRequestRefResolution` (`packages/cockpit/src/gh/wrapper.ts:80-84`). Zero-field variant for `unresolved` sets the precedent for `pr-number` also being zero-field.
- **Exhaustive check via `never`**: every callsite of `resolveIssueToPRRef` result must handle the new arm. TypeScript's structural exhaustive check (`const _: never = resolution;` after the last `if`) catches misses at build time.
- **Tool-boundary error wrapping**: `wrapToolBoundary` at `errors.ts:60-72` is the sole point where thrown `CockpitExit` becomes `ToolErrorResult`. The new `toMcpResult` handles the returned-`RunMergeResult` shape. Both live in `errors.ts`.
- **Stub GhWrapper for tests**: follow `parity-advance.test.ts:11-30` — a `stubGh(overrides)` factory that starts from a minimal record and lets each test override the methods it exercises.

## Sources / References

- **Spec**: `specs/928-found-during-cockpit-v1/spec.md`
- **Clarifications**: `specs/928-found-during-cockpit-v1/clarifications.md`
- **Prior spec (issue-ref grammar)**: `specs/850-…/spec.md` (per CLAUDE.md § "Cockpit `advance` bare-number acceptance & error-copy refresh (#850)")
- **Prior spec (discriminated resolver union)**: #904 Q5 (referenced in clarifications.md Q2)
- **Prior spec (GraphQL resolver rewrite)**: #913 (referenced in clarifications.md Q2 rationale)
- **Prior finding (CLI PR-vs-issue confusion)**: #906 (closed by this spec's resolver-bubble path)
- **Prior finding (playbook drift audit at code layer)**: S6, referenced in spec § Fix #4
- **Prior spec (typed error classifier as contract)**: #915 (referenced in clarifications.md Q4 rationale)

# Research: #1080 — re-justify `cockpit_gate_list`'s `runId` drop

Decisions and rationale that fell out of the /clarify pass and the pre-plan verification sweep. Each is load-bearing on some aspect of the implementation; if any is later found wrong, revisit before implement.

## Decision 1 — Test seam for FR-003b (client-level guard)

**Chosen**: `vi.mock('../gates/query-client.js', ...)` — replace the module's `createGateQueryClient` export with a factory that returns a spy-backed `listGates`. Assert the spy's first-call arg has no `runId` property.

**Why**: The tool at `cockpit_gate_list.ts:48` calls `createGateQueryClient(options)` statically (no DI param on `BuildMcpServerDeps` for the factory). Vitest module mocking is the standard TypeScript-friendly way to intercept a static import without changing production code. FR-004 explicitly forbids a production-code change, which rules out adding a `createClient?: (opts) => GateQueryClient` DI field on `BuildMcpServerDeps` just for this test.

**Alternatives rejected**:
- **Add a `createClient` DI hook**. Would give a cleaner test, but expands `BuildMcpServerDeps` for a documentation-only PR and adds a public surface change (bumping the changeset from `patch` to `minor`). Not worth it for one test.
- **Reuse the existing `fetchImpl` seam**. That IS the wire-level seam; it cannot distinguish "handler stripped the field" from "buildListUrl silently ignored the field" — the exact discrimination Q1=A said the client-seam test must provide. Same seam = redundant coverage.

**Verification precedent**: This repo has no prior `vi.mock('../gates/query-client.js', ...)` usage — the file has only been touched via the `fetchImpl`-injection pattern. First use here. Vitest's module-mock API (`vi.mock` + `vi.hoisted` for the spy factory) is well-established and documented; no repo-specific convention conflicts.

## Decision 2 — Handler-comment wording (FR-001, Q5=B constraint)

**Chosen**: Paraphrase issue Ask #1 into the file's compressed comment voice; preserve the four load-bearing facts + the two literal tokens `agency#471` and `generacy-cloud#894`.

**Load-bearing facts** (must survive intact — SC-002-adjacent):
1. The drop is *policy*, not a workaround.
2. The cloud accepts `?runId=` as an equality filter as of `generacy-cloud#894`.
3. `agency#471`'s startup-sweep adoption depends on `cockpit_gate_list` returning **prior** runs' gates.
4. Forwarding is a behaviour change needing a named consumer (extension-path direction — Q4=A: state the direction, do not design the API).

**Secondary sentences** (per Q3=B):
- Keep (a) `runId` accepted for MCP-surface parity with `cockpit_gate_status`, handler MUST NOT propagate.
- Keep (b) Handler does NOT emit the `runIdSource` log line per Q3=C.
- Delete (c) The stale "cloud follow-up for a list-mode `runId` filter is a separate generacy-cloud issue" line — the cloud follow-up shipped as `generacy-cloud#894` and the primary paragraph names that fact, so restating it here is drift risk.

**File voice reference**: the existing observer-independence header at `cockpit_gate_list.ts:10-15` and the current `#1067` block at `:50-59` establish the register — short, first-clause fact, follow-up clauses justifying. New comment stays in that register; the issue's prose (dashes, "which is exactly why") does not.

## Decision 3 — Docblock discipline on `CockpitGateListInputSchema.runId` (FR-002, Q2=B)

**Chosen**: One line at `query-schemas.ts:65-74`. Fact + cross-link. Handler comment is the sole source of truth for the *why*.

**Wording constraint** (per Q2 answer): the one-liner must **state the load-bearing fact**, not merely point elsewhere. A bare `// see tools/cockpit_gate_list.ts` fails if the file is moved or the reader does not follow the link. The one-liner must convey:
- Field accepted for parity with `cockpit_gate_status`.
- Handler drops it before the cloud call.
- `tools/cockpit_gate_list.ts` is the source of truth for the *why*.

Prose target (approximate — adjust to fit the file's block-comment convention):

```
/** Accepted for MCP-surface parity with `cockpit_gate_status`. Handler drops
 *  it before the cloud call — see `tools/cockpit_gate_list.ts` for rationale. */
```

**Why not restate full rationale here**: two independent full-prose sites are the exact drift surface that produced this issue (both sites in commit `82077f1a` said the same thing about the vanished refine; the refine went away and both had to change). Shrinking the schema site to a one-liner minimises how much prose *can* drift, per Q2's discipline argument.

## Decision 4 — Extension-path sentence (Q4=A, in the handler comment)

**Chosen**: Include one sentence stating the *direction* — "an explicit opt-in for run-scoped list is the correct extension path if a future consumer needs it, not removing the drop." Do not name a concrete API shape (`runScoped: true` flag / `cockpit_gate_list_by_run` tool).

**Why**: Q4=B (naming a shape) commits code-comment authority to an API for a consumer that doesn't exist yet, with no requirements to design against. If the eventual consumer needs a different shape, the comment actively misdirects. Q4=C (omit) leaves the natural reading of "the handler deliberately drops this" ambiguous between "so remove the drop" and "so remove the dead field" — the exact action this issue exists to prevent.

**Length budget**: one sentence. The primary paragraph already supplies the *why* (agency#471 depends on run-agnostic visibility), so the extension-path sentence can be terse.

## Decision 5 — Do not touch `buildListUrl`

**Chosen**: Leave `packages/generacy/src/cli/commands/cockpit/mcp/gates/query-client.ts:112-116` untouched.

**Why it stays**: `buildListUrl` never sets `runId` on the list path in the first place. It is the *second structural drop site* — even if the handler forgot to strip, the URL would still be clean. This is precisely why the wire-level guard (FR-003a) has independent coverage value distinct from the client-seam guard (FR-003b):

| Regression class | Wire-level test | Client-seam test |
|------------------|-----------------|------------------|
| Handler strip removed, `buildListUrl` still ignores `runId` | PASSES (silent) | FAILS |
| Handler strip present, `buildListUrl` taught to append `runId` | FAILS | PASSES (silent) |

Adding a comment in `buildListUrl` to say "we deliberately don't set `runId` on list" is tempting but violates Q2's discipline (three prose sites is worse than two). The two tests already assert the invariant; no third prose site earns its keep.

## Decision 6 — Sibling repo (agency#471, agency `auto.md:86`) is out of scope

**Verified**: Assumption 5 says `grep -c "would 400" packages/claude-plugin-cockpit/commands/auto.md` returns 0 in the agency repo already. FR-005 stands as a no-op. Do not open a cross-repo PR. If the plan-time verification (below) contradicts this in some later state, file a separate agency PR — do not fold into this one.

## Pre-plan verification sweep (SC-001 baseline)

```
$ grep -rniE "runId requires generation|would 400|would produce a 400|RFC-7807" \
    packages/generacy/src/cli/commands/cockpit/
packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_list.ts:53:    // { message: 'runId requires generation' })` — list mode has no
packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_list.ts:54:    // `generation` by construction, so forwarding `runId` would produce a 400
packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_list.ts:55:    // RFC-7807 and break the sweep's primary dedup primitive. The schema
packages/generacy/src/cli/commands/cockpit/mcp/gates/query-schemas.ts:71:     * { message: 'runId requires generation' })` and list mode has no
packages/generacy/src/cli/commands/cockpit/mcp/gates/query-schemas.ts:73:     * 400 RFC-7807 and breaks the sweep's primary dedup primitive.
```

5 matches across 2 files, both flagged in the spec. Post-fix, this same grep MUST return 0 (SC-001 verification).

## Pre-plan verification sweep (test seam)

```
$ grep -n "listGates\|createGateQueryClient" \
    packages/generacy/src/cli/commands/cockpit/mcp/gates/query-client.ts
93:  listGates(input: CockpitGateListInput): Promise<CockpitGateListData>;
203:export function createGateQueryClient(options: QueryClientOptions): GateQueryClient {
210:    async listGates(input) {
```

Seam confirmed: `createGateQueryClient` is a top-level factory export. `vi.mock('../gates/query-client.js', ...)` on that path is the correct interception point.

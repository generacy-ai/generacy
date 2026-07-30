# Implementation Plan: `runId` on gate-query MCP tools (Phase B of #1053 fix)

**Feature**: `runId` accepted (and threaded) on the read-side gate-query MCP tools (`cockpit_gate_status` / `cockpit_gate_list`) so the Phase C caller change can flip the fix on without silently missing every lookup.
**Branch**: `1067-problem-generacy-1053-s`
**Status**: Complete

## Summary

Widen the two read-side MCP query tools to accept an optional `runId` field, thread it through the MCP query-client → orchestrator route → cloud gate-query client so that with Phase A landed on the cloud (`generacy-cloud#892`, deployed `2026-07-29T04:07:07Z`), a caller that supplies `runId` on `cockpit_gate_open` can then re-issue `cockpit_gate_status({...triple, runId})` and get `open` for the gate it just opened in that run. When `runId` is omitted (every existing caller, until agency-side Phase C flips the switch), every derived key/id and outbound URL byte remains identical to today.

**Non-goals** (see `spec.md § Out of Scope`):
- No cloud-side changes (Phase A already merged and deployed).
- No agency-side threading (Phase C, separate issue).
- No `INSTANCE_NONCE` fallback (rejected in #1053 review; do not reintroduce).
- No `cockpit_gate_list` cloud-side `runId` filter (deployed cloud contract 400s any list carrying `runId`; per clarification **Q1=C** the handler drops it — filter is a follow-up cloud issue).
- No new MCP tools, no schema-shape reorganisation, no error-class changes.

## Technical context

**Language / runtime**: TypeScript (strict), Node.js ≥ 22, ESM.

**Framework**: `zod` for MCP boundary + wire schemas; `fastify` for the orchestrator route; `node:https` + `AbortController` for the cluster→cloud client. No new dependencies.

**Packages affected**:
| Package                         | Nature of change                                                           | Changeset bump |
|---------------------------------|----------------------------------------------------------------------------|----------------|
| `@generacy-ai/generacy` (CLI)   | Widen MCP schemas + thread `runId` in `cockpit_gate_status` handler + build `runId` into query-client URL. | **patch** (internal MCP surface; new optional field on existing tool inputs — non-breaking widening) |
| `@generacy-ai/orchestrator`     | Widen `GateQueryStringSchema.runId?`; extend `GetGateStatusInput` + `buildUrl`. Byte-compat preserved on omit. | **patch** (internal; no new exports) |

Single new changeset file: `.changeset/1067-runid-on-gate-query.md` — two-package patch. Neither package adds a new public tool, method, or label vocabulary → `minor` not indicated (per CLAUDE.md § Changesets rules). See `contracts/changeset.md`.

**Ordering constraint** (spec Assumption 1, 6): Cloud Phase A merged at `generacy-cloud@192fca7c` and deployed to `https://api-staging.generacy.ai`. This PR ships only after on-call confirms Phase A is deployed to prod; on-call MUST verify at merge time. Landing this before Phase A produces silent write-4/read-3 mismatch (`#1059` root cause).

**Wire contract source of truth**: `packages/cockpit/src/gates/schemas.ts` (via `@generacy-ai/cockpit`) — unchanged. `gateKey` / `gateId` derivation lives in `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts` and its 4-tuple mode is already merged (#1053). This PR only widens the **read** surface.

## Constitution check

No `.specify/memory/constitution.md` in this repository (checked at plan time). CLAUDE.md gates that apply:
- **Changeset gate** — this diff modifies `packages/*/src/` non-test files under two packages; add `.changeset/1067-runid-on-gate-query.md` in the PR (T007). Both bumps are `patch` (no new capability, no new label vocabulary, no new exports).
- **Observer-independence** — `mcp/__tests__/observer-independence.test.ts` static import-scan MUST still pass. No new cross-boundary imports (FR-009 / SC-007).
- **Test-only escape** does NOT apply — non-test files under `packages/*/src/` change.

## Project structure

### Files created (5)

```
specs/1067-problem-generacy-1053-s/
├── plan.md                              # this file
├── research.md                          # decisions + rationale (this PR)
├── data-model.md                        # types + validation rules
├── quickstart.md                        # usage + verification
├── contracts/
│   ├── query-schemas.md                 # MCP boundary contract (widened)
│   ├── cloud-url.md                     # outbound cloud URL shape (canonical snapshot)
│   └── changeset.md                     # required changeset shape
└── (spec.md, clarifications.md exist; unchanged)
```

### Files modified (5 source + 4 tests)

**Source** (all diffs adding one optional field or one conditional URL segment):

```
packages/generacy/src/cli/commands/cockpit/mcp/gates/query-schemas.ts
├── CockpitGateStatusInputSchema  : + runId: z.string().min(1).optional()    [FR-001]
└── CockpitGateListInputSchema    : + runId: z.string().min(1).optional()    [FR-002]

packages/generacy/src/cli/commands/cockpit/mcp/gates/query-client.ts
└── buildStatusUrl(baseUrl, input)
    ├── if (input.runId !== undefined) url.searchParams.set('runId', input.runId)
    └── buildListUrl unchanged                                              [FR-003a: MCP→orch URL]

packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_status.ts
├── queryInput.runId = parsed.data.runId
├── const runIdSource = parsed.data.runId !== undefined ? 'explicit' : 'unset'
└── post-call log (success AND failure paths):
    getLogger().info({ event: 'cockpit_gate_status.runid-source',
                       runIdSource, mode: 'status', gateType,
                       issueRef, resolvedStatus, gateId })                  [FR-004, FR-008]

packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_list.ts
└── /* inline comment: deliberately drop runId — cloud route .refine
     ((q) => q.runId === undefined || q.generation !== undefined)
     rejects list requests carrying runId with 400. Cloud follow-up: see
     specs/1067-problem-generacy-1053-s/README (out-of-scope). */
    parsed.data.runId is READ (schema accepts) but NOT PASSED to client.
    NO log line emitted (per Q3=C).                                         [FR-004, FR-008 exclusion]

packages/orchestrator/src/routes/cockpit-gates.ts
└── GateQueryStringSchema
    + runId: z.string().min(1).optional()
    (refine stays; runId is a passive pass-through on the route side.
     The route MUST NOT itself refine "runId ⇒ generation" — the cloud
     route does that authoritatively; adding a duplicate refinement here
     would produce a 400 with a route-side error class instead of the
     cloud RFC-7807 the caller must observe.)
    + status branch: client.getGateStatus({ ..., runId })
    + list branch:   runId NOT forwarded to client.listGates              [FR-003, FR-004]

packages/orchestrator/src/services/cloud-gate-query-client.ts
├── GetGateStatusInput  : + runId?: string
└── getGateStatus:
    query = { issueRef, gateType, generation, runId: input.runId ?? undefined }
    (buildUrl already omits undefined values via `if (v !== undefined)`;
     no change to buildUrl needed.)                                       [FR-003, FR-005]
```

**Tests** (added / extended):

```
packages/orchestrator/src/services/__tests__/
└── cloud-gate-query-client.runid.test.ts                                 [NEW; T004]
    ├── SC-001a: snapshot equality — full canonical URL with runId===undefined
    ├── SC-001b: structural — query-string key set is exactly {issueRef, gateType, generation}
    │           and runId is absent
    ├── SC-003: runId=<X> supplied → URL contains runId=X (camelCase)
    └── listGates unchanged when runId provided upstream — smoke: URL never carries runId

packages/generacy/src/cli/commands/cockpit/mcp/__tests__/
├── parity-gate-status.test.ts                                            [EXTEND]
│   ├── SC-006: inputSchema remains flat z.object with non-empty properties (existing → keep)
│   └── + widened-shape acceptance: {issueRef, gateType, generation, runId} validates
├── parity-gate-list.test.ts                                              [EXTEND]
│   ├── SC-006: inputSchema remains flat z.object with non-empty properties (existing → keep)
│   └── + widened-shape acceptance: {issueRef, gateType?, runId} validates
├── parity-gate-tuple-identity.test.ts                                    [NEW; FR-006 / SC-005]
│   └── Matrix (3 tools × {3-tuple, 4-tuple, distinct runId, empty-generation boundary})
│       asserts open-derives(gateKey/gateId) === status-URL-carried tuple ===
│       list-entry.gateId (via fake cloud that persists 4-tuple → gateId).
└── cockpit-gate-status-runid.test.ts                                     [NEW]
    └── Log-line assertion (FR-008): success + failure paths both emit
        {event: 'cockpit_gate_status.runid-source', runIdSource,
         mode: 'status', gateType, issueRef, resolvedStatus, gateId}.
        runId value is NEVER present in the emitted record.
```

**Integration** (SC-004 end-to-end):

```
packages/generacy/src/cli/commands/cockpit/mcp/__tests__/
└── gate-open-then-status-runid.integration.test.ts                        [NEW]
    Fake cloud persists gates keyed by (issueRef, gateType, generation, runId).
    Sequence:
      1. cockpit_gate_open({triple, runId:'A'})  → cloud stores 4-tuple
      2. cockpit_gate_status({triple, runId:'A'}) → 'open' (not 'absent')
      3. cockpit_gate_open({triple, runId:'B'}) → cloud stores DIFFERENT 4-tuple
      4. cockpit_gate_status({triple, runId:'A'}) → still 'open'
      5. cockpit_gate_status({triple, runId:'B'}) → 'open' (fresh gate)
      6. cockpit_gate_status({triple}) [no runId] → returns whichever the
         cloud's 3-segment fallback matches (asserted as: does not throw,
         returns a defined ThreeState). Byte-compat only — legacy path
         behaviour is cloud-owned and out of scope for pinning.
```

### Nothing else moves

- `gates/schemas.ts` (write path) — **untouched**. `deriveGateKey` / `deriveGateId` already support the 4-tuple (#1053 T003).
- `gates/client.ts` (write-path HTTP client) — **untouched**.
- `cockpit_gate_open.ts`, `cockpit_gate_ack.ts` — **untouched**. Wire semantics preserved (spec Assumption 3, FR-007).
- `retained-cockpit-events.ts` — **untouched**. Observer-independence import-scan continues to bar cross-imports (FR-009 / SC-007).
- Orchestrator seven-to-three status collapse (`collapseCloudStatus`) — **untouched**.
- Retry policy (`QUERY_RETRY_SCHEDULE`, `isRetryableGateQueryError`) — **untouched**.

## Implementation strategy

**One PR, additive-only.** Every touch point is either "add one optional field to an existing schema" or "add one conditional URL segment." No shape reorganisation, no method renames, no new public exports. This mirrors the #1053 write-side land: the field is *declared* (schema-typed), not tolerated (`.passthrough` / `.catchall`) — the spec requires `.strict()` preserved on both schemas (FR-001, FR-002, SC-006).

**Landing order** (each row independent enough to be reviewed as a single hunk):

1. `packages/orchestrator/src/services/cloud-gate-query-client.ts` — add `runId?` to `GetGateStatusInput`, thread through `getGateStatus`. **Leaves `buildUrl` unchanged** because it already omits undefined values (`if (v !== undefined)` at line 207).
2. `packages/orchestrator/src/routes/cockpit-gates.ts` — add `runId: z.string().min(1).optional()` to `GateQueryStringSchema`; forward to `client.getGateStatus` on status branch only; do NOT forward on list branch.
3. `packages/generacy/src/cli/commands/cockpit/mcp/gates/query-schemas.ts` — add `runId` to both input schemas.
4. `packages/generacy/src/cli/commands/cockpit/mcp/gates/query-client.ts` — `buildStatusUrl` conditionally sets `runId`. `buildListUrl` unchanged.
5. `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_status.ts` — thread `parsed.data.runId` into `queryInput`; add post-call structured log (success + failure).
6. `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_list.ts` — schema now permits `runId`; handler drops it before calling client with inline comment naming the cloud refine.
7. `.changeset/1067-runid-on-gate-query.md` — patch + patch bump.

**Regression net:**
- FR-005 dual verification (SC-001) — new file `cloud-gate-query-client.runid.test.ts` pins both a checked-in canonical URL (snapshot) and a structural key-set assertion.
- FR-006 three-tool matrix (SC-005) — new file `parity-gate-tuple-identity.test.ts` runs open × status × list-entry across 3-tuple + 4-tuple + distinct-runId + empty-generation boundary.
- FR-008 (SC-005 log-line) — new file `cockpit-gate-status-runid.test.ts` asserts success + failure log emission, absence of `runId` value in the emitted record.
- SC-007 observer-independence unchanged — no new import edges added; existing `observer-independence.test.ts` runs untouched.

## Risks and mitigations

| Risk                                                                          | Likelihood | Mitigation                                                                                                                                                                                       |
|-------------------------------------------------------------------------------|------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Land before Phase A → silent write-4 / read-3 mismatch (#1059 exact repro).   | Low        | On-call reviewer verifies cloud deploy at merge time (spec Assumption 1). Bot check — `curl $GENERACY_API_URL/api/clusters/health` returns cloud version — is not part of this PR; documented in `quickstart.md § Landing check`. |
| Handler forwards `runId` on list mode by accident (regression via next reader). | Medium     | Inline comment at drop site names the cloud refine; `parity-gate-tuple-identity.test.ts` includes an explicit "list URL never carries runId" assertion; SC-003 nails this in the client test.       |
| `runId` value leaks into structured log (data-model E-3 breach).              | Low        | FR-008 test asserts the emitted record does NOT contain the `runId` field, only `runIdSource: 'explicit' | 'unset'`.                                                                              |
| URL encoding drift on `owner/repo#N` (`#` → `%23`) — cloud returns `absent` for live gate. | Low     | Q5=C dual verification: snapshot fixture catches percent-encoding drift byte-for-byte; structural assertion produces the legible failure message.                                                    |
| Widening breaks flat MCP `inputSchema`.                                       | Low        | FR-005 / SC-006 — widening is in-place on the existing `z.object({...}).strict()` (adding a field), not via `z.intersection`. Existing `parity-gate-status.test.ts` / `parity-gate-list.test.ts` assert flat non-empty `properties`. |

## Post-merge follow-ups (not in scope)

- `generacy-ai/agency` Phase C: thread `runId` through `/cockpit:auto` for both open + status/list calls. This is what flips the fix on end-to-end.
- `generacy-ai/generacy-cloud` follow-up: add `runId` filter to list mode (deployed contract currently 400s; operator use case "show me this run's gates" is real).

---

*Generated by /speckit:plan on 2026-07-29.*

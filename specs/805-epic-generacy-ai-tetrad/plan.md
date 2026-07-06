# Implementation Plan: Delete Cockpit Dark Subsystems (S1)

**Feature**: Epic: generacy-ai/tetrad-development#85 | Phase: S1 | Tier: v1-simplification | Issue: G-S1
**Branch**: `805-epic-generacy-ai-tetrad`
**Status**: Complete

## Summary

Delete four dark subsystems in the cockpit stack that shipped without a consumer path:

1. **Orchestrator API client** — `packages/cockpit/src/orchestrator/**` (client, http, stub) and its CLI consumers (`shared/orchestrator-{footer,token,warn}.ts`, `watch/orchestrator-counts.ts`, footer + counts wiring in `status.ts`/`watch.ts`).
2. **Journal liveness sensor** — `packages/cockpit/src/journal.ts` and its call sites in `status.ts` and `watch/poll-loop.ts`.
3. **Confirmed-dead exports** — `appendChildIssue` in `manifest/io.ts`; `health`/`isAvailable` (drop with the client); `StuckReason`/`JournalLivenessResult`/`ReadJournalLivenessOptions` types.
4. **Watch event drift** — `stuck`/`recovered` from `CockpitEventKindDiscriminator` in `watch/emit.ts` and `watch/diff.ts` (also fixes producer/schema drift).

Per Q1 clarification: also delete the now-always-false **`stuck` output surface** entirely — the `STALE` column in `render-table.ts`, `stuck`/`stuckReason` fields in `StatusRow`, status `--json` rows (and its `color.ts` `stuck()` helper), and `IssueSnapshot`; drop `stuck`/`recovered` cases from `watch.diff.test.ts` and stuck-column cases from `status.render.test.ts`.

Config schema loses `orchestrator.*` and `stuckThresholdMinutes`. Status output loses the footer line; watch loses the counts line.

## Technical Context

- **Language**: TypeScript (ESM, Node >=22), strict mode.
- **Framework**: Commander.js CLI (`packages/generacy`), Zod for schema validation, Vitest for tests.
- **Packages touched**:
  - `packages/cockpit` (pre-1.0, no external consumers outside this repo)
  - `packages/generacy` (CLI consumer of cockpit)
- **Dependencies removed**: none (all removed code is internal; no packages become unused).
- **Build gate**: typecheck (`pnpm -w typecheck` per package, or `pnpm build` on the two touched packages).
- **Test gate**: `pnpm -w test` in `packages/cockpit` and `packages/generacy`.

**No external consumers.** Grep confirms `@generacy-ai/cockpit` is only imported from `packages/cockpit/**` and `packages/generacy/src/cli/commands/cockpit/**` (both owned here). `dist/*.d.ts` files are build artifacts, regenerated on typecheck.

## Project Structure — Files Touched

### Deletions (whole file)

```
packages/cockpit/src/
  orchestrator/
    client.ts          [DELETE]
    http.ts            [DELETE]
    stub.ts            [DELETE]
  journal.ts           [DELETE]
  __tests__/
    journal.test.ts              [DELETE]
    orchestrator-client.test.ts  [DELETE]

packages/generacy/src/cli/commands/cockpit/
  shared/
    orchestrator-footer.ts       [DELETE]
    orchestrator-token.ts        [DELETE]
    orchestrator-warn.ts         [DELETE]
  watch/
    orchestrator-counts.ts       [DELETE]
  __tests__/
    orchestrator-token.test.ts               [DELETE]
    orchestrator-warn.test.ts                [DELETE]
    status.footer.test.ts                    [DELETE]
    status.token-precedence.test.ts          [DELETE]
    watch.orchestrator-counts.test.ts        [DELETE]
    watch.orchestrator-failure.test.ts       [DELETE]
```

### Modifications (edit in place)

```
packages/cockpit/src/
  index.ts                       [MOD]  Remove exports: createOrchestratorClient (+ its types),
                                        readJournalLiveness, StuckReason, JournalLivenessResult,
                                        ReadJournalLivenessOptions, appendChildIssue
  types.ts                       [MOD]  Remove StuckReason, JournalLivenessResult,
                                        ReadJournalLivenessOptions
  config/schema.ts               [MOD]  Remove orchestrator{}, stuckThresholdMinutes fields
  manifest/io.ts                 [MOD]  Delete appendChildIssue function
  __tests__/
    config-loader.test.ts        [MOD]  Drop orchestrator/stuckThresholdMinutes assertions
    manifest-io.test.ts          [MOD]  Drop appendChildIssue cases
    fixtures/config-samples/full.yaml  [MOD]  Strip orchestrator/stuckThresholdMinutes keys

packages/generacy/src/cli/commands/cockpit/
  status.ts                      [MOD]  Remove orchestrator + liveness wiring; drop
                                        `liveness` computation + `getFooter`/`renderFooter` calls;
                                        drop imports (createOrchestratorClient, readJournalLiveness,
                                        StuckReason, orchestrator-footer/token/warn)
  watch.ts                       [MOD]  Remove orchestrator wiring (client, warner, prevOrchestrator,
                                        pollOrchestratorCounts, orchestrator-counts stdout write)
  status/render-table.ts         [MOD]  Drop COL_STUCK constant, `stuckCol` computation in fmtRow,
                                        `orchestrator` field from StatusEnvelope, footer param
  status/row.ts                  [MOD]  Drop stuck/stuckReason from StatusRow interface, drop
                                        liveness param + fields from buildStatusRow
  status/color.ts                [MOD]  Drop stuck() method from Colorizer + both colorizer impls
  watch/snapshot.ts              [MOD]  Drop stuck/stuckReason from IssueSnapshot, drop liveness
                                        param + fields from buildIssueSnapshot; drop StuckReason import
  watch/diff.ts                  [MOD]  Drop 'stuck'/'recovered' from CockpitEventDiscriminator,
                                        drop stuckReason optional field, drop stuck-transition
                                        blocks from diffIssue; drop StuckReason import
  watch/emit.ts                  [MOD]  Zod schema already excludes stuck/recovered — no change
                                        needed to the enum (already fixed); verify type alignment
  watch/poll-loop.ts             [MOD]  Drop stuckThresholdMinutes + readLiveness from PollDeps,
                                        drop the liveness branch in the issue path; drop imports
                                        (readJournalLiveness, StuckReason)
  __tests__/
    status.render.test.ts        [MOD]  Drop stuck-column cases; adjust column-count assertions
    watch.diff.test.ts           [MOD]  Drop stuck/recovered cases
    watch.poll-loop.test.ts      [MOD]  Drop stuckThresholdMinutes/readLiveness cases
```

### No changes (verification pass only)

- `packages/cockpit/src/config/loader.ts` — reads via schema; no direct field access to `orchestrator`/`stuckThresholdMinutes` beyond schema parse.
- All other `packages/generacy/src/cli/commands/cockpit/**` (advance, merge, queue, clarify-context, etc.) — do not touch orchestrator or journal.

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo. Skipping principle checks; only the acceptance criteria and Q1 clarification apply.

## Execution Sequence

1. **Delete files** (whole-file removals above) — reduces symbol surface first, so type errors surface as clear "unknown import" messages rather than diffuse ripples.
2. **Update `packages/cockpit/src/{types.ts, index.ts, config/schema.ts, manifest/io.ts}`** — trims the package's exported surface.
3. **Update `packages/generacy/src/cli/commands/cockpit/status.ts` and `watch.ts`** — top-level call sites; removes remaining dead imports.
4. **Update `status/*` and `watch/*` helper modules** — cascades the interface changes.
5. **Trim tests** — matching the surface removals in steps 2–4.
6. **Typecheck + test** — `pnpm --filter @generacy-ai/cockpit build && pnpm --filter @generacy-ai/generacy build`, then `pnpm --filter @generacy-ai/cockpit test && pnpm --filter @generacy-ai/generacy test`.

## Acceptance (from spec)

- No reference to orchestrator client, journal, journal-liveness types, or removed exports remains outside git history.
- `cockpit watch` and `cockpit status` run and their tests pass with reduced output (no STALE column, no `stuck`/`stuckReason` in `--json` or snapshots, no orchestrator footer/counts).
- Package builds green in CI (typecheck step).

## Risks & Mitigations

- **Risk**: Silent references from other packages still typecheck against `dist/*.d.ts`.
  **Mitigation**: `pnpm -w build` after changes; grep for the removed symbol names across `packages/` post-build.
- **Risk**: `watch.no-mutations.test.ts` or `watch.pagination.test.ts` implicitly assume the old orchestrator-counts stdout line.
  **Mitigation**: Read those two test files during step 5; adjust only if they reference orchestrator output.

## Out of Scope

- Any rewrite of the S4 `/cockpit:*` plugin commands (belongs to `generacy-ai/agency#372`, per clarification Q1).
- Reintroducing stuck detection sourced from an event log (v3 candidate).
- Removing lint from CI (not a typecheck concern).

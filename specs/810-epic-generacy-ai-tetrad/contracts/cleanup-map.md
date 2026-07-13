# Contract: Cleanup Map (FR → files → expected post-state)

Each functional requirement resolves to one or more concrete file operations. This document is the acceptance surface: reviewer verifies each row by inspecting the listed file.

## FR-001 — Delete stale pending changesets

| Path                                                    | Operation | Post-state                          |
| ------------------------------------------------------- | --------- | ----------------------------------- |
| `.changeset/792-cockpit-orchestrator-status.md`         | DELETE    | Does not exist.                     |
| `.changeset/793-cockpit-journal-stuck-detection.md`     | DELETE    | Does not exist.                     |

**Verification**: `ls .changeset/79[23]-*.md` returns nothing.

**Blast radius**: release automation. If these files survive to the next `changeset version` run, `@generacy-ai/cockpit` and `@generacy-ai/generacy` each get an extra MINOR bump announcing features that were deleted, and CHANGELOG.md ships two fictional entries.

## FR-002 — Append `STALE`/stuck-fields note to authoritative removal changeset

| Path                                                    | Operation                  | Post-state                          |
| ------------------------------------------------------- | -------------------------- | ----------------------------------- |
| `.changeset/805-cockpit-delete-orchestrator-journal.md` | APPEND ONE PROSE LINE      | Body mentions `STALE` status column and specific stuck fields (`stuckAt`, `lastJournalAt`) removed from `StatusRow`. |

**Frontmatter**: unchanged. Both packages remain at MINOR.

**Wording (illustrative, exact prose left to the author)**:

```text
Also removes the STALE status column from the cockpit status/watch tables and the
stuck-metadata fields (stuckAt, lastJournalAt) from the StatusRow row shape.
```

**Verification**: `grep -E 'STALE|stuckAt|lastJournalAt' .changeset/805-*.md` returns at least one hit.

## FR-003 — Prune orchestrator reference from README

| Path                                          | Operation                                                                 | Post-state                                             |
| --------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------ |
| `packages/cockpit/README.md` (line 5, one hit) | Remove the trailing clause "without depending on the orchestrator runtime" (or the whole sentence if it becomes vestigial). | `grep -in orchestrator packages/cockpit/README.md` returns nothing. |

**Judgement call** (per Q2): default to remove — the primitives don't depend on any runtime by construction; the clause is leftover framing, not a load-bearing claim.

**Verification**: `grep -RIn 'orchestrator\|ORCHESTRATOR_' packages/cockpit/README.md` returns zero hits.

## FR-004 — Prune orchestrator from package.json description

| Path                                | Operation                                                                          | Post-state                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `packages/cockpit/package.json` (line 4) | Change `"description"` from `"…, gh wrapper, and orchestrator client"` to `"…, gh wrapper"` (drop `", and orchestrator client"`). | `description` reads `"Foundation library for the Generacy Epic Cockpit: classifier, config loader, epic manifest, gh wrapper"`. |

**Verification**: `grep -in 'orchestrator client' packages/cockpit/package.json` returns zero hits.

## FR-005 — Prune orchestrator from index.ts header comment

| Path                                    | Operation                                                                                                            | Post-state                                                                                                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cockpit/src/index.ts` (lines 1-3) | Change the header comment to drop `orchestrator/http` and `orchestrator/stub` references. Leave `state/label-map` (still internal and still unexported). | Comment reads (approximately): `// @generacy-ai/cockpit — public API surface.\n// Internal modules (state/label-map) are NOT exported.` |

**Verification**: `grep -in 'orchestrator' packages/cockpit/src/index.ts` returns zero hits.

## FR-006 — Legacy-config tolerance test

| Path                                                                                       | Operation                                            | Post-state                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cockpit/src/__tests__/fixtures/config-samples/legacy-orchestrator-keys.yaml`    | CREATE                                               | YAML fixture nesting `orchestrator:` and `stuckThresholdMinutes:` under `cockpit:` (see data-model.md).                                                                                        |
| `packages/cockpit/src/__tests__/config-loader.test.ts`                                     | APPEND ONE `it()` BLOCK                              | New case `'strips legacy orchestrator/stuckThresholdMinutes keys nested under cockpit: (R4 strip mode)'`. Three assertions (see data-model.md §Entity 3). Reuses existing `writeConfig()` helper. |

**Behavior locked**:

1. `loadCockpitConfig()` on a config carrying nested legacy keys resolves without throwing.
2. `parsed.orchestrator === undefined` — strip mode drops the sub-object.
3. `parsed.stuckThresholdMinutes === undefined` — strip mode drops the primitive.

**Fails loudly under**:

- `CockpitConfigSchema` change to `.strict()` → assertion (1) fails (throws).
- `CockpitConfigSchema` change to `.passthrough()` → assertions (2) and (3) fail (keys leak).

**Verification**: `pnpm --filter @generacy-ai/cockpit test config-loader` passes with the new case reporting.

## FR-007 — MOOT (see clarifications.md Q4)

`packages/generacy/src/cli/commands/cockpit/__tests__/shared.scoping.test.ts` — deleted by #806 (PR #809) along with the manifest scoping it exercised. No file to edit.

**Verification**: `test ! -f packages/generacy/src/cli/commands/cockpit/__tests__/shared.scoping.test.ts` — expected `true`.

## FR-008 — SKIP (owned by in-flight #807)

Four files owned by in-flight #807 (G-S3) — not touched here:

- `packages/generacy/src/cli/commands/cockpit/__tests__/state.test.ts`
- `packages/generacy/src/cli/commands/cockpit/__tests__/advance.test.ts`
- `packages/generacy/src/cli/commands/cockpit/__tests__/clarify-context.test.ts`
- `packages/generacy/src/cli/commands/cockpit/__tests__/queue.test.ts`

Orchestrator-mock removal verified at #807's implementation review. No follow-up issue.

## FR-009 — MOOT ON INSPECTION (see research.md D5)

`packages/generacy/src/cli/commands/cockpit/__tests__/status.render.test.ts` — already asserts positive on `parsed.scope` and `parsed.rows` (see file line 74-76). No `expect(parsed.orchestrator).toBeUndefined()` line present. Nothing to replace.

**Verification**: `grep -n 'parsed\.orchestrator' packages/generacy/src/cli/commands/cockpit/__tests__/status.render.test.ts` returns zero hits.

## Aggregate acceptance grep (SC-001 style)

After all edits, this command must return zero hits:

```bash
grep -RIn 'orchestrator\|ORCHESTRATOR_\|stuckThresholdMinutes\|StuckReason\|readJournalLiveness\|appendChildIssue' \
  packages/cockpit/README.md \
  packages/cockpit/package.json \
  packages/cockpit/src/index.ts \
  .changeset/792-cockpit-orchestrator-status.md \
  .changeset/793-cockpit-journal-stuck-detection.md \
  2>/dev/null
```

(The two changeset paths are listed as tombstones — the grep returns zero because the files no longer exist.)

`.changeset/805-*.md` is explicitly excluded: it legitimately describes the removal and must mention the removed subsystems by name to be a useful changelog entry.

## Diff summary (expected)

```text
D  .changeset/792-cockpit-orchestrator-status.md
D  .changeset/793-cockpit-journal-stuck-detection.md
M  .changeset/805-cockpit-delete-orchestrator-journal.md              (+1 line)
M  packages/cockpit/README.md                                          (-1 clause / -1 sentence at line 5)
M  packages/cockpit/package.json                                       (description field trimmed)
M  packages/cockpit/src/index.ts                                       (header comment trimmed)
A  packages/cockpit/src/__tests__/fixtures/config-samples/legacy-orchestrator-keys.yaml   (new fixture)
M  packages/cockpit/src/__tests__/config-loader.test.ts                (+1 it() block)
```

Files added: 1. Files modified: 5. Files deleted: 2. Net LoC change: single-digit positive.

# Quickstart: #810 residue sweep

Verification walkthrough for the PR. No install / no runtime bring-up — this PR is release metadata + docs + one test.

## Prerequisites

- Repo checked out on branch `810-epic-generacy-ai-tetrad`.
- `pnpm install` already run (workspace dependencies resolved).
- Node ≥ 22.

## Apply the edits

Follow `contracts/cleanup-map.md`. Recommended order:

1. **Delete stale changesets** (protects release train if `changeset version` fires mid-PR):

    ```bash
    rm .changeset/792-cockpit-orchestrator-status.md
    rm .changeset/793-cockpit-journal-stuck-detection.md
    ```

2. **Append `STALE`/stuck-fields note** to `.changeset/805-cockpit-delete-orchestrator-journal.md` (one prose line at the end of the existing body — see `contracts/cleanup-map.md` §FR-002 for the exact wording).

3. **Prune orchestrator references** from three cockpit files:

   - `packages/cockpit/README.md` line 5 — remove the "without depending on the orchestrator runtime" clause.
   - `packages/cockpit/package.json` line 4 — drop `", and orchestrator client"` from the `description`.
   - `packages/cockpit/src/index.ts` lines 1-3 — remove `orchestrator/http` and `orchestrator/stub` from the header comment.

4. **Add the legacy-config fixture + test case** — see `data-model.md` §Entity 2 and §Entity 3 for exact content.

## Verify

### Grep-based structural checks (SC-001)

Each command should return nothing:

```bash
# FR-001 — stale changesets gone
ls .changeset/79[23]-*.md 2>/dev/null

# FR-003 — README free of orchestrator references
grep -in 'orchestrator\|ORCHESTRATOR_' packages/cockpit/README.md

# FR-004 — package.json description trimmed
grep -in 'orchestrator client' packages/cockpit/package.json

# FR-005 — index.ts header comment trimmed
grep -in 'orchestrator' packages/cockpit/src/index.ts

# FR-009 — status.render.test.ts free of tombstone (already true; regression check only)
grep -in 'parsed\.orchestrator' packages/generacy/src/cli/commands/cockpit/__tests__/status.render.test.ts
```

### Positive check on FR-002

`.changeset/805-cockpit-delete-orchestrator-journal.md` must mention the `STALE` column and stuck fields:

```bash
grep -E 'STALE|stuckAt|lastJournalAt' .changeset/805-cockpit-delete-orchestrator-journal.md
```

Expected: at least one line printed.

### Test suite

Run the cockpit test suite and confirm the new legacy-config case appears green:

```bash
pnpm --filter @generacy-ai/cockpit test
```

Expected line in output:

```text
✓ config-loader.test.ts > loadCockpitConfig > strips legacy orchestrator/stuckThresholdMinutes keys nested under cockpit: (R4 strip mode)
```

### Strip-mode regression probe (manual)

Temporarily edit `packages/cockpit/src/config/schema.ts:3` to add `.strict()`:

```ts
export const CockpitConfigSchema = z.object({
  owner: z.string().min(1).optional(),
}).strict();
```

Re-run `pnpm --filter @generacy-ai/cockpit test`. Expected: the new test fails with a Zod error naming `orchestrator` and/or `stuckThresholdMinutes`. Revert the edit — do not commit.

This confirms the test genuinely locks strip mode.

## Full acceptance grep (bundle)

```bash
grep -RIn 'orchestrator\|ORCHESTRATOR_\|stuckThresholdMinutes\|StuckReason\|readJournalLiveness\|appendChildIssue' \
  packages/cockpit/README.md \
  packages/cockpit/package.json \
  packages/cockpit/src/index.ts \
  2>/dev/null
```

Expected output: empty.

## Do NOT touch

- The four in-flight #807 test files (see `research.md` D4 for the list).
- Any file outside the "Owns" clause in `spec.md`.
- The existing enumeration in `.changeset/805-*.md` — append only, no rewrite.

## Troubleshooting

**Symptom**: `pnpm --filter @generacy-ai/cockpit test` reports the new case failing with a Zod error at parse time.

**Cause**: Someone has added `.strict()` to `CockpitConfigSchema`.

**Fix**: revert to the default (strip mode) — `z.object({...})` with no modifier. That's the R4 contract.

---

**Symptom**: `pnpm --filter @generacy-ai/cockpit test` reports the new case failing at the `parsed.orchestrator === undefined` assertion (the key leaks into the parsed object).

**Cause**: Someone has added `.passthrough()` to `CockpitConfigSchema`.

**Fix**: revert. Passthrough leaks arbitrary user YAML into the parsed config type at runtime — not what R4 promises.

---

**Symptom**: Grep on `packages/cockpit/README.md` still finds `orchestrator` after edits.

**Cause**: The line-5 edit was partial — either the trailing clause was dropped but the word survived elsewhere on the line, or a later section still mentions the removed subsystem.

**Fix**: Read the current line 5. If the surrounding sentence still makes sense after clause removal, keep the rest; if it becomes vestigial, delete the whole sentence (Q2's judgement call).

---

**Symptom**: `changeset version` run during PR review produces a version bump entry for `@generacy-ai/cockpit` mentioning "orchestrator API status tier" or "journal-based stuck detection".

**Cause**: `.changeset/792-*.md` or `.changeset/793-*.md` was not actually deleted.

**Fix**: delete them (`git rm`), amend the PR.

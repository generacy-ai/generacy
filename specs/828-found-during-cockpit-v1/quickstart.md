# Quickstart: cockpit status renders phase grouping for epic children

**Issue**: [#828](https://github.com/generacy-ai/generacy/issues/828)
**Branch**: `828-found-during-cockpit-v1`

## What Changes for Users

`generacy cockpit status <epic-ref>` now groups its output by the epic body's `### <phase>` headings instead of one flat table. `--json` output adds a `phase` field to every row. No new flags, no new commands.

## Installation / Dev Setup

Nothing new. Standard workflow:

```bash
pnpm install
pnpm --filter @generacy-ai/generacy build
pnpm --filter @generacy-ai/generacy test
```

## Usage

### Grouped table output

```bash
generacy cockpit status christrudelpw/sniplink#1
```

Before this fix — one flat group:

```
epic christrudelpw/sniplink
christrudelpw/sniplink   #    2   active   phase:plan     PR     -   none      Foundation task
christrudelpw/sniplink   #    3   active   phase:plan     PR     -   none      Foundation cleanup
christrudelpw/sniplink   #    7   review   phase:review   PR    12   success   Ship P2 milestone
...
```

After this fix — one group per phase:

```
— P1 — Foundation —
christrudelpw/sniplink   #    2   active   phase:plan     PR     -   none      Foundation task
christrudelpw/sniplink   #    3   active   phase:plan     PR     -   none      Foundation cleanup

— P2 — Integration —
christrudelpw/sniplink   #    7   review   phase:review   PR    12   success   Ship P2 milestone
...

— P3 — Ship —
christrudelpw/sniplink   #   15   active   phase:plan     PR     -   none      P3 milestone
```

Group headers use `ParsedPhase.heading` verbatim. Label-less phases (`### P1` with no `— Foundation`) fall back to `— P1 —`.

### Phase-less epic

An epic body with zero `### <phase>` headings renders a single fallback group and exits 0:

```
— (no phase) —
some-owner/some-repo   #  10   active   phase:plan   PR   -   none   Task
```

### Trailing "no phase" group

If some children appear in the epic body outside any `### <phase>` heading (i.e. present in `allRefs` but under no phase), they're collected in a trailing group:

```
— P1 — Foundation —
o/r   #  2   ...

— P2 — Integration —
o/r   #  7   ...

— (no phase) —
o/r   #  99   ...
```

### JSON output

```bash
generacy cockpit status --json christrudelpw/sniplink#1
```

Single-line envelope. Each row now has a `phase` field:

```json
{
  "scope": { "kind": "epic", "owner": "christrudelpw", "repo": "sniplink", "issue": 1 },
  "rows": [
    { "repo": "christrudelpw/sniplink", "kind": "issue", "number": 2, ..., "phase": "p1" },
    { "repo": "christrudelpw/sniplink", "kind": "issue", "number": 7, ..., "phase": "p2" },
    { "repo": "christrudelpw/sniplink", "kind": "issue", "number": 15, ..., "phase": "p3" }
  ]
}
```

**Filter by phase in `jq`**:

```bash
generacy cockpit status --json christrudelpw/sniplink#1 \
  | jq '.rows[] | select(.phase == "p2")'
```

**Verify contract (SC-002)**:

```bash
generacy cockpit status --json christrudelpw/sniplink#1 \
  | jq '.rows[] | has("phase")' | sort -u
# → [true]
```

### Cross-phase duplicate refs

A ref listed under multiple `### <phase>` headings (rare but supported) renders:
- **Table**: once per phase group.
- **JSON**: one row per (ref × phase) membership. So the row count can exceed the distinct-issue count.

This mirrors `queue <phase>` semantics: queueing a phase enqueues every ref listed under that phase, regardless of duplication elsewhere.

## Available Commands

Same as before — no new subcommands. Only `cockpit status` changes.

## Testing

Automated:

```bash
pnpm --filter @generacy-ai/generacy vitest run status
```

Key coverage in `packages/generacy/src/cli/commands/cockpit/__tests__/`:
- `status.render.test.ts` — grouping behavior, header format, JSON envelope schema.
- `status.test.ts` — end-to-end integration through `runStatus()` with a mocked `gh` wrapper.

Manual (SC-001 / US3): run `generacy cockpit status christrudelpw/sniplink#1` and confirm ≥3 phase-headed groups.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Table shows one big `— (no phase) —` group. | Epic body has no `### <phase>` headings, or the headings are at wrong nesting (`##` or `####`). | Convert to level-3 headings (`### P1 — Foundation`). Parser rejects `##` and `####+`. |
| A ref you added to the body doesn't appear anywhere. | Task-list line uses bare `#N` (rejected by parser), OR the ref isn't inside a `- [ ]` / `- [x]` bullet. | Use `<owner>/<repo>#<n>` or the full URL. Check stderr for `cockpit: ignored ref-shaped task-list line` warnings. |
| Row count in `--json` exceeds child count. | A ref is listed under multiple phase headings. Documented behavior (FR-006). | Filter by `(repo, number)` in `jq` to get distinct issues. |
| Header shows `— p1 —` (lowercased) instead of `— P1 —`. | Parser bug — `ParsedPhase.token` leaked into a fallback header without uppercasing. | File a bug against `render-table.ts` header formatter. |

## Migration Notes for Downstream Consumers

- The `--json` envelope is a **backward-compatible superset** of the pre-#828 output: all existing fields are preserved unchanged; `phase` is added.
- If your consumer asserts `rows.length === allRefs.length`, relax to `>=` — see FR-006.
- The stdout table format is **not** a stable contract; if you scrape it, migrate to `--json`.

## References

- Spec: `specs/828-found-during-cockpit-v1/spec.md`
- Plan: `specs/828-found-during-cockpit-v1/plan.md`
- JSON contract: `specs/828-found-during-cockpit-v1/contracts/status-envelope.json`
- Repro epic: `christrudelpw/sniplink#1`

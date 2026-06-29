# Quickstart: Verifying the #801 cross-repo cockpit fix

**Feature**: #801 — Cross-repo epic children honored by `resolveEpicIssues`

This is the manual verification path. The acceptance criteria (US1 / US2 / US3)
map to the commands below. Automated coverage lives in
`packages/cockpit/src/__tests__/manifest-scoping.test.ts` and
`packages/generacy/src/cli/commands/cockpit/__tests__/shared.scoping.test.ts`.

## Prerequisites

- Local checkout of `generacy-ai/generacy` on branch `801-found-dogfooding-cockpit-its`.
- `pnpm install` completed at the repo root.
- `gh` CLI installed and authenticated (`gh auth status`).
- A `.generacy/cockpit.yaml` (or env-based `MONITORED_REPOS`) configured for
  the cockpit; `cockpit.repos` should include the repos that hold the test
  epic's children. For SC-001, that means `generacy-ai/generacy` and
  `generacy-ai/agency` must appear (or `MONITORED_REPOS` includes them).

## Build

```bash
pnpm --filter @generacy-ai/cockpit build
pnpm --filter @generacy-ai/generacy build
```

## Unit Tests (FR-008)

```bash
# Library tests: manifest-path cross-repo, fallback union, no-repos warning, malformed manifest
pnpm --filter @generacy-ai/cockpit test

# CLI tests: scope shape migration, watch epic-walk cross-repo
pnpm --filter @generacy-ai/generacy test -- shared.scoping watch.epic-walk
```

Expected: all green, including the new cases added per FR-008.

## US1 — Operator inspects a cross-repo epic with `status`

The canonical repro from the spec:

```bash
generacy cockpit status --epic generacy-ai/tetrad-development#85
```

**Expected output**:
- A single group header `epic generacy-ai/tetrad-development#85`.
- Rows for every issue in `generacy-ai/generacy#786–793` and
  `generacy-ai/agency#350–360`.
- Per-row `repo` column shows the *child's* repo (not the epic's repo).
- No unrelated `generacy-ai/tetrad-development` issues appear.

This satisfies **SC-001** and **SC-002**.

## US2 — Operator runs `watch` on a cross-repo epic

```bash
generacy cockpit watch --epic generacy-ai/tetrad-development#85
```

**Expected behavior**:
- The first poll snapshots every child issue with its own repo.
- Subsequent polls hit each child in its own repo (one `gh search` per repo,
  filtered to that repo's subset of `scope.issues`).
- NDJSON events include the child's full `owner/repo#n` identity.

Stop with `Ctrl+C`.

## US3 — Fallback path (no manifest, `cockpit.repos` configured)

Simulate the manifest-absent case in a scratch directory:

```bash
mkdir -p /tmp/cockpit-fallback-test
cd /tmp/cockpit-fallback-test

cat > .generacy/cockpit.yaml <<'YAML'
repos:
  - generacy-ai/generacy
  - generacy-ai/agency
YAML

# Intentionally no .generacy/epics/<...>.yaml
generacy cockpit status --epic generacy-ai/tetrad-development#85
```

**Expected**:
- Manifest read is skipped (no files in `.generacy/epics/`).
- The label-graph fallback runs against `cockpit.repos ∪ generacy-ai/tetrad-development`.
- Per repo R, both `label:epic-child <epic>` and `<epic> in:body` queries fire.
- Results are repo-qualified and deduped.

This satisfies **SC-003**.

## Negative case — under-configured fallback (FR-005)

```bash
# In a directory with no cockpit config and no manifest:
unset MONITORED_REPOS
generacy cockpit status --epic generacy-ai/tetrad-development#85
```

**Expected**:
- A structured warning on stderr names the limitation
  (`cockpit: resolveEpicIssues called without configured repos; …`).
- Fallback still runs against the epic's own repo
  (`generacy-ai/tetrad-development`) and returns whatever it finds there.
- Exit code 0 (warnings are not fatal).

## Regression — single-repo epic (SC-004)

```bash
generacy cockpit status --epic generacy-ai/generacy#<some-single-repo-epic>
```

**Expected**: identical to pre-fix behavior. Every child resolves to
`generacy-ai/generacy`. Existing `manifest-scoping.test.ts` and
`shared.scoping.test.ts` cases pass after the shape migration.

## Available Commands Touched by This Feature

| Command                                | Behavior change                                                   |
|----------------------------------------|-------------------------------------------------------------------|
| `generacy cockpit status --epic <ref>` | Lists cross-repo children; per-row `repo` matches each child's repo |
| `generacy cockpit watch --epic <ref>`  | Polls each child in its own repo; NDJSON events carry `owner/repo` |
| `generacy cockpit status --repos …`    | Unchanged                                                          |
| `generacy cockpit watch --repos …`     | Unchanged                                                          |

## Troubleshooting

- **"Got unrelated issues from tetrad-development"** — Either the build did
  not pick up the new code (re-run `pnpm --filter … build`) OR the manifest
  at `.generacy/epics/<...>.yaml` is still malformed in the consumer repo
  AND `cockpit.repos` does not include the child repos. Check stderr for
  the malformed-manifest warning (FR-006).
- **"Empty list"** — Confirm the manifest's `epic.repo` matches the
  `owner/repo` in `--epic` exactly (full `owner/repo`, not bare repo).
  Bare-repo manifests trigger the fallback; ensure `cockpit.repos` (or
  `MONITORED_REPOS`) includes every repo that holds children.
- **"gh search rate limit"** — The fallback fires `2 × |repoSet|` searches.
  Reduce `cockpit.repos` or rely on the manifest path.

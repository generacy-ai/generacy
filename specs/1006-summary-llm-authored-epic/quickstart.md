# Quickstart: LLM-authored H4 phase-header epic detection

**Feature**: `1006-summary-llm-authored-epic` | **Date**: 2026-07-19

Local repro and validation workflow for the fix.

## Prerequisites

- Node.js >=22 (matches `packages/cockpit` and `packages/generacy` `engines.node`).
- `pnpm` (workspace package manager).
- `gh` CLI authenticated (only needed for the live-repro step; unit tests do not require it).

## Install

```bash
pnpm install
```

## Run the parser test suite

Runs only the resolver tests — the fastest inner loop while iterating on `parse-epic-body.ts`:

```bash
pnpm --filter @generacy-ai/cockpit test parse-epic-body
```

Runs the full cockpit test suite (adds `resolve.test.ts`, `ref-shapes.test.ts`, `heading-match.test.ts`):

```bash
pnpm --filter @generacy-ai/cockpit test
```

## Run the CLI + MCP test suite

```bash
pnpm --filter @generacy-ai/generacy test
```

Filter to just the status-envelope + `cockpit_status` MCP tests:

```bash
pnpm --filter @generacy-ai/generacy test -- status
pnpm --filter @generacy-ai/generacy test -- cockpit_status
```

## Live repro against `christrudelpw/snappoll#1`

The reference stalled epic. If you have `gh` authenticated and the repo access:

```bash
generacy cockpit status christrudelpw/snappoll#1 --json | jq '.warnings'
```

**Expected output (post-fix)**:
```json
[
  "cockpit: 12 task refs fell to ad-hoc; phase headers must be '###', found '####'"
]
```

The exact count and phrasing may drift; only the marker substring `phase headers must be '###'` is stable per Q2=B.

Interactive-operator channel (stderr):

```bash
generacy cockpit status christrudelpw/snappoll#1 2>&1 >/dev/null
```

Expected: at least one stderr line containing `phase headers must be '###'`.

## Simulate the auto-skill sweep detection

The auto skill infers degradation from a substring check on `warnings[]`:

```bash
generacy cockpit status christrudelpw/snappoll#1 --json \
  | jq --arg m "phase headers must be '###'" '.warnings | any(contains($m))'
```

Expected: `true` on the affected epic; `false` on a clean epic.

## Grep audit (SC-006)

Confirm the marker substring appears exactly once in the resolver:

```bash
rg -n "phase headers must be '###'" packages/cockpit/src/
```

Expected: exactly one hit, inside `packages/cockpit/src/resolver/parse-epic-body.ts`.

Also confirm the marker does not leak into other resolver strings by mistake:

```bash
rg -n "phase headers" packages/cockpit/src/
```

Expected: same single hit.

## Confirm the false-positive gates

Two shapes must NOT trigger the warning:

**Flat-list body** (no `### Phase` headings, refs directly under a preamble):
```bash
cat <<'EOF' | node -e '
  const { parseEpicBody } = await import("./packages/cockpit/dist/resolver/parse-epic-body.js");
  const body = require("fs").readFileSync(0, "utf-8");
  console.log(JSON.stringify(parseEpicBody(body).warnings, null, 2));
'
# ## Scope
# - [ ] owner/repo#1
# - [ ] owner/repo#2
EOF
```

Expected: `[]`.

**Ordinary epic with `#### Notes` sub-headers**:
```bash
cat <<'EOF' | node -e '
  const { parseEpicBody } = await import("./packages/cockpit/dist/resolver/parse-epic-body.js");
  const body = require("fs").readFileSync(0, "utf-8");
  console.log(JSON.stringify(parseEpicBody(body).warnings, null, 2));
'
# ### S1 — planning
# - [ ] owner/repo#1
# #### Notes
# some prose here
# ### S2 — build
# - [ ] owner/repo#2
EOF
```

Expected: `[]`.

## Rebuild + re-run after edits

Vitest picks up TypeScript source directly for the cockpit package — no build needed for the parser tests. For the CLI + MCP tests, `pnpm --filter @generacy-ai/generacy test` handles the pipeline.

## Changeset

Per `CLAUDE.md` §Changesets, this PR modifies non-test files under `packages/cockpit/src/` and `packages/generacy/src/`. Add a changeset **before merging**:

```bash
pnpm changeset
```

Or hand-write `.changeset/1006-<slug>.md`:

```markdown
---
"@generacy-ai/cockpit": minor
"@generacy-ai/generacy": minor
---

Detect LLM-authored H4 phase-header epics and surface a loud signal via `parseEpicBody`'s `warnings[]` on both the `cockpit status --json` envelope and the `cockpit_status` MCP tool return. Fixes the silent `/cockpit:auto` stall on affected epics (#1006).
```

Both packages are `minor` — the resolver ships a new warning family (public surface addition), the CLI ships a new envelope field (public surface addition).

## Troubleshooting

**"The warning fires on my clean epic."** Confirm the four gating conditions from `contracts/parser-behavior.md`. Most likely (d) `sawPhaseShapedH4` is being set spuriously — check the trimmed text of your `####` headings against `PHASE_SHAPED_H4_RE`.

**"The warning does NOT fire on `christrudelpw/snappoll#1`."** Confirm `parsed.phases.length > 0` — the sniplink-shape has ≥ one `### <section>` heading (`### Delivery phases`) even though the H4 headers close it. If the body has been edited since PR time, the fixture may no longer match reality.

**"The MCP tool return does not include `warnings`."** Check that `cockpit_status.ts:86` still returns `data: parsedJson` verbatim. Any filtering there breaks parity with the CLI envelope.

**"Grep audit fails."** Search for accidental duplicates of the marker substring anywhere in `packages/cockpit/src/`. The audit fails if it appears in more than one place (SC-006).

## Manual post-merge verification

After the PR merges to `develop`:

1. Trigger `/cockpit:auto` on a fresh epic authored by `generacy-ai` (whose LLM-emitted phase headers are known to be nondeterministic).
2. If the run hits the H4 shape, the startup sweep now sees the warning in `warnings[]` and can escalate loudly instead of idling.
3. Watch stderr on the same run for the human-readable warning line.

Companion authoring-side change: pinning the epic-authoring template to `###` for phase headers is tracked separately. Until it lands, this fix is defense-in-depth — it converts silent stalls into loud, actionable warnings.

# Quickstart: Verify Cockpit Dark-Subsystem Deletion (S1)

This is a deletion-only change. There's no new feature to demo — quickstart focuses on **verifying** that the cockpit CLI still runs correctly with the reduced surface, and that CI is green.

## Prerequisites

- Node >=22, pnpm installed.
- Repo checked out at branch `805-epic-generacy-ai-tetrad`.

## Steps

### 1. Install and build

```bash
pnpm install
pnpm --filter @generacy-ai/cockpit build
pnpm --filter @generacy-ai/generacy build
```

**Expected**: both build steps exit 0. Any residual reference to a deleted symbol (`readJournalLiveness`, `createOrchestratorClient`, `appendChildIssue`, `StuckReason`, `JournalLivenessResult`, `ReadJournalLivenessOptions`) surfaces as a TypeScript error here.

### 2. Verify no dead references remain

```bash
git grep -nE 'readJournalLiveness|createOrchestratorClient|appendChildIssue|StuckReason|JournalLivenessResult|ReadJournalLivenessOptions|orchestrator-footer|orchestrator-token|orchestrator-warn|orchestrator-counts' -- 'packages/**/*.ts'
```

**Expected**: zero matches inside `packages/` (matches in `specs/`, `dist/`, or committed backups do not count).

### 3. Run the affected test suites

```bash
pnpm --filter @generacy-ai/cockpit test
pnpm --filter @generacy-ai/generacy test
```

**Expected**: both suites pass green with the trimmed test set (six full deletions + three trimmed files listed in plan.md).

### 4. Manual smoke — `cockpit status`

```bash
node packages/generacy/dist/cli/index.js cockpit status --repos generacy-ai/generacy
```

**Expected**:
- Table renders **without** a `STALE` column.
- No `orchestrator:` footer line printed at the bottom.
- Exit code 0.

### 5. Manual smoke — `cockpit status --json`

```bash
node packages/generacy/dist/cli/index.js cockpit status --repos generacy-ai/generacy --json | jq '.rows[0], .orchestrator'
```

**Expected**:
- First row prints an object with **no** `stuck` or `stuckReason` keys.
- Envelope's `.orchestrator` field is `null` (jq exits with null for missing key) — no orchestrator block.

### 6. Manual smoke — `cockpit watch`

```bash
node packages/generacy/dist/cli/index.js cockpit watch --repos generacy-ai/generacy --interval 2000
```

Let it run for two ticks, then Ctrl-C.

**Expected**:
- No `{"type":"orchestrator-counts",...}` lines on stdout.
- No `stuck`/`recovered` events even if you flap labels on a test issue.
- Watch exits cleanly on Ctrl-C.

## Available Commands (post-change)

All previously exposed subcommands still work:

- `cockpit status [--epic <ownerRepoIssue> | --repos <list>] [--json]`
- `cockpit watch [--epic <ownerRepoIssue> | --repos <list>] [--interval <ms>] [--safety-cap <n>]`
- `cockpit advance`, `cockpit merge`, `cockpit queue`, `cockpit manifest`, `cockpit state`, `cockpit exit`, `cockpit clarify-context`, `cockpit review-context`, `cockpit code-references` — unchanged.

The **removed** surface is entirely internal implementation:

- `orchestrator.baseUrl` / `orchestrator.token` config keys — silently ignored on next parse.
- `stuckThresholdMinutes` config key — silently ignored on next parse.
- `ORCHESTRATOR_API_TOKEN` env var — no longer read.

## Troubleshooting

**"Cannot find module '@generacy-ai/cockpit/orchestrator'" at CLI startup**
→ `dist/` still contains old artifacts. Delete `packages/cockpit/dist` and `packages/generacy/dist`, rerun step 1.

**Test failure: `status.render.test.ts` expects STALE column**
→ Test file wasn't fully trimmed. Reopen and drop any `expect(...).toContain('STALE')` cases.

**Test failure: `watch.diff.test.ts` expects `stuck` or `recovered` event**
→ Test file wasn't fully trimmed. Drop the corresponding `it()` blocks.

**Old user configs with `orchestrator:` block fail to parse**
→ They shouldn't — Zod's default `strip` mode ignores unknown keys. If you see this, someone added `.strict()` to `CockpitConfigSchema`. Remove it.

**`git grep` in step 2 returns hits from `specs/`**
→ Expected — the spec directory documents the deletion. Add `-- ':!specs'` to the grep to exclude it.

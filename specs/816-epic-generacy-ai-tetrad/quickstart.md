# Quickstart: Cockpit slash commands via `generacy setup build`

## What this does

After running `generacy setup build`, cockpit slash commands from the `@generacy-ai/claude-plugin-cockpit` package are wired into your Claude Code config. In a fresh Claude Code session, `/cockpit:<name>` (e.g. `/cockpit:watch`) resolves and runs.

## Prerequisites

- Node >= 22.
- Claude Code CLI available on `PATH` (for verification only — `setup build` does not require it).
- The `@generacy-ai/claude-plugin-cockpit` package available in one of the checked locations (see below).

## Installation paths (any one works)

`setup build` looks for the cockpit package in this order:

1. **Workspace source (dev)** — `<agencyDir>/packages/claude-plugin-cockpit/commands/`. Auto-picked when the agency repo is cloned adjacent to generacy at `/workspaces/agency` (default).
2. **generacy `node_modules`** — `<generacyDir>/node_modules/@generacy-ai/claude-plugin-cockpit/`.
3. **agency `node_modules`** — `<agencyDir>/node_modules/@generacy-ai/claude-plugin-cockpit/`.
4. **Shared packages volume** — `/shared-packages/node_modules/@generacy-ai/claude-plugin-cockpit/`. Used by cluster-templates.
5. **npm global** — `npm install -g @generacy-ai/claude-plugin-cockpit`.

If none exist, `setup build` still succeeds and emits one warning line.

## Usage

Run the build subcommand as usual:

```bash
generacy setup build
```

Expected output (excerpt, cockpit present):

```
Phase 4: Installing Claude Code integration (speckit commands + Agency MCP)
INFO { count: <N>, source: "/workspaces/agency/packages/agency-plugin-spec-kit/commands", dest: "/home/<you>/.claude/commands" } Copied speckit command files
INFO { count: <M>, source: "<resolved-cockpit-path>", dest: "/home/<you>/.claude/commands/cockpit" } Copied cockpit command files
Phase 4 complete: Claude Code integration installed
```

Expected output (excerpt, cockpit absent):

```
WARN { checkedPaths: [ ... 5 entries ... ] } @generacy-ai/claude-plugin-cockpit not found — install it locally or globally to enable cockpit commands
Phase 4 complete: Claude Code integration installed
```

The absent-package branch is non-fatal — the exit code is still 0.

## Verify (fresh Claude Code session)

```bash
claude
```

Then type `/cockpit:` — the slash-command dropdown should list every command from the cockpit package. Selecting `/cockpit:watch` (or any listed command) resolves and runs.

Files on disk:

```bash
ls ~/.claude/commands/cockpit/
# clarify.md  plan.md  <other cockpit .md files>
```

## Available commands

Determined by the cockpit package (`@generacy-ai/claude-plugin-cockpit`, owned by A-S2). The setup step copies whatever `.md` files are present in the package's `commands/` directory — the exact command names are not hardcoded on the generacy side.

At time of writing, the epic (`S6 / G-S5`) expects six commands. Verify against `<resolved-cockpit-path>/*.md` after running `setup build`.

## Troubleshooting

### Setup completed but `/cockpit:*` doesn't appear

1. Confirm the files were copied: `ls ~/.claude/commands/cockpit/`.
   - If empty or missing: the warning line was likely emitted — check `setup build` stderr for the "not found" warning and its `checkedPaths` array.
2. Confirm Claude Code sees them: restart the Claude Code session (files are read on startup).
3. Confirm the subdirectory convention is in use in your Claude Code version: some older builds may only load flat `~/.claude/commands/*.md`. Verify with a plain `.md` file at `~/.claude/commands/cockpit/test.md` containing `Test` — restart Claude Code — type `/cockpit:test`.

### Warning fires but the package is installed

1. Confirm the install location matches one of the five checked paths (see "Installation paths" above).
2. For a `pnpm` workspace, the package may not appear at `<workspace>/node_modules/@generacy-ai/claude-plugin-cockpit/` — check under the workspace-specific `node_modules` or run from a directory where a hoisted install is expected. Tier-1's workspace source-directory check (`<agencyDir>/packages/claude-plugin-cockpit/commands`) covers the dev case.
3. Confirm `npm root -g` succeeds if relying on the global install: `npm root -g`.

### Spec-kit commands stopped working

Cockpit copy uses `~/.claude/commands/cockpit/`; spec-kit copy uses `~/.claude/commands/*.md` (top-level). The two never share filenames on disk. If spec-kit commands are missing, the issue is unrelated to this change — check the spec-kit block's own log line for its own resolution/absence status.

### `logger.warn` line missing when package is absent

The warn is emitted at pino's default INFO level or above. If your `LOG_LEVEL` is set to `ERROR`, `WARN` lines are suppressed. Set `LOG_LEVEL=info` (or unset it) to see the warning.

## Related

- Spec: `specs/816-epic-generacy-ai-tetrad/spec.md`
- Plan: `specs/816-epic-generacy-ai-tetrad/plan.md`
- Contract: `specs/816-epic-generacy-ai-tetrad/contracts/cockpit-copy-block.md`
- Epic: `docs/epic-cockpit-plan.md` in `generacy-ai/tetrad-development` (S6 / G-S5).

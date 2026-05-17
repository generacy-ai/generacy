# Implementation Plan: Launch directory selection prompt

**Feature**: Replace yes/no confirm with multi-option directory select in `generacy launch`
**Branch**: `649-context-when-user-runs`
**Status**: Complete

## Summary

Replace the `confirmDirectory` prompt (a simple yes/no `p.confirm()`) with a `p.select()` prompt offering three options: default path (`~/Generacy/<projectName>`), current working directory, or a custom path via free-text input. The `--dir` flag continues to bypass all prompting. This is a small, focused UX improvement touching two files in the CLI launch command.

## Technical Context

**Language/Version**: TypeScript (ESM), Node >=22
**Primary Dependencies**: `@clack/prompts` (already used), `commander`
**Storage**: N/A (filesystem scaffolding — unchanged)
**Testing**: Manual verification (existing patterns — no test framework for interactive CLI prompts)
**Target Platform**: macOS, Windows, Linux CLI
**Project Type**: Monorepo package (`packages/generacy`)
**Constraints**: Must not break `--dir` scripted usage; prompt library already available

## Project Structure

### Documentation (this feature)

```text
specs/649-context-when-user-runs/
├── spec.md
├── plan.md              # This file
├── research.md
├── data-model.md
└── quickstart.md
```

### Source Code (files to modify)

```text
packages/generacy/src/cli/commands/launch/
├── prompts.ts           # Replace confirmDirectory → selectDirectory
└── index.ts             # Update caller to handle selection result
```

## Implementation Steps

### Step 1: Replace `confirmDirectory` with `selectDirectory` in `prompts.ts`

- Export new `selectDirectory(defaultDir: string, cwd: string): Promise<string>` function
- Use `p.select()` with options:
  1. Default path (`~/Generacy/<projectName>`) — value: the resolved default path
  2. Current directory — value: `process.cwd()` resolved path
  3. "Enter a custom path..." — value: sentinel like `'__custom__'`
- If cwd === defaultDir, collapse into single option (don't show duplicate)
- If cwd contains `.generacy/`, annotate label with `(already contains .generacy/)`
- On `'__custom__'` selection, follow up with `p.text()` for free-text path entry
  - Validate: non-empty, resolve to absolute path
- Return the chosen absolute path
- Remove `confirmDirectory` export

### Step 2: Update `index.ts` to use new prompt

- Replace import of `confirmDirectory` with `selectDirectory`
- In step 5 ("Determine project directory + confirm"):
  - When `opts.dir` is provided: use `resolveProjectDir(config.projectName, opts.dir)` directly (no prompt — existing behavior)
  - When `opts.dir` is NOT provided: call `selectDirectory(resolveProjectDir(config.projectName), process.cwd())`
  - Remove the "confirmed === false → exit" branch (selection always returns a valid path)
- Pass the selected path to `scaffoldProject()`

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| `--dir` provided | Skip prompt entirely, use resolved path |
| cwd == default path | Show only 2 options (merged into one + custom) |
| cwd has `.generacy/` | Show warning in label; scaffolder throws if selected |
| User cancels prompt | `exitIfCancelled` handles → exit 130 |
| Custom path is relative | Resolve against cwd via `path.resolve()` |

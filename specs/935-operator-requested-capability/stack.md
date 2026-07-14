# Stack notes: #935

## Packages touched

- `@generacy-ai/cockpit` (`packages/cockpit/`)
  - `src/resolver/parse-epic-body.ts` — `adhocRefs` collection; `## Ad-hoc` L2 heading as phase-terminator
  - `src/resolver/resolve.ts` — `NO_PHASE_HEADINGS` throw removed
  - `src/resolver/types.ts` — `ParsedEpicBody.adhocRefs` field
  - `src/gh/wrapper.ts` — new `updateIssueBody(repo, issue, body)` method (stdin pipe via `--body-file -`)

- `generacy` CLI (`packages/generacy/`)
  - `src/cli/commands/cockpit/watch/diff.ts` — mid-stream first-sight emits `initial: true`
  - `src/cli/commands/cockpit/scope/` (NEW) — pure writer, bounded retry, typed contended error
  - `src/cli/commands/cockpit/scope.ts` (NEW) — CLI verb with `add` / `remove` subcommands
  - `src/cli/commands/cockpit/queue.ts` — `--issue` form dispatches to `runQueueSingleIssue()`
  - `src/cli/commands/cockpit/status.ts` — flat-mode render for `phases: []`
  - `src/cli/commands/cockpit/mcp/tools/cockpit_scope_add.ts` (NEW)
  - `src/cli/commands/cockpit/mcp/tools/cockpit_scope_remove.ts` (NEW)
  - `src/cli/commands/cockpit/mcp/tools/cockpit_queue.ts` — dispatches phase vs issue form
  - `src/cli/commands/cockpit/mcp/schemas.ts` — `CockpitScopeAddInputSchema`, `CockpitScopeRemoveInputSchema`, `CockpitQueueInputSchema` union
  - `src/cli/commands/cockpit/mcp/server.ts` — register scope tools
  - `src/cli/commands/cockpit/mcp/errors.ts` — `contended` and `scope-not-found` error classes
  - `src/cli/commands/cockpit/index.ts` — `command.addCommand(scopeCommand())`

## Runtime dependencies

Zero new packages.

Existing in-tree deps used:
- `commander` — CLI verb registration (already used by every cockpit verb)
- `@clack/prompts` — `p.confirm` for interactive prompts (already used by `queue.ts`)
- `zod` — MCP schema validation (already used throughout MCP handlers)
- `vitest` — tests (already the test runner)

## Test seams

- `applyScopeMutation` — pure function, no seams needed
- `writeScopeWithRetry` — `sleep`, `gh` (GhWrapper), `maxAttempts`, `backoffMs` all injectable
- `runQueueSingleIssue` — same DI pattern as `runQueue` (runner, gh, cockpitGh, loadConfig, prompt, stdout, stderr, env)
- MCP handlers — use `wrapToolBoundary` (existing pattern) and accept `runner` / `gh` injection via `Deps`
- `computeTransitions` — pure, existing tests use SnapshotMap fixtures directly
- Event-bus liveness test — construct fake `GhWrapper`, poll registry twice with body-changing mock, assert emission

## Feature flags / config

None. All behaviours ship on by default.

## Non-code contracts (documented, not enforced by engine)

- `type:cockpit-tracking` label — applied by playbook (agency-side) to issues *created* by ad-hoc mode. Engine never reads it.

## Sequencing / dependencies

This issue lands first. Companion agency (`docs/skills/cockpit/auto.md`) issue lands second, wiring the new engine primitives into the auto playbook (ad-hoc mode, mid-run add-issue flow, phase-boundary interplay).

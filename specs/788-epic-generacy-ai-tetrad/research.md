# Research: `generacy cockpit` — state / advance / clarify-context

This document records the prior art surveyed, the technology choices made, and the alternatives considered before writing the plan. It does **not** restate the plan's architectural decisions (see `plan.md` §Architectural Decisions for those).

## Decisions

### D-R1 — Reuse `GhCliWrapper` from `@generacy-ai/cockpit` instead of a per-command client

**Decision**: All gh CLI access goes through `GhCliWrapper` (or — for endpoints the wrapper does not yet expose, like timeline events and comments — through the same injectable `CommandRunner` it already accepts).

**Why**: The wrapper provides Zod validation, error normalization, and a `CommandRunner` seam for hermetic tests. Building a parallel client per verb would duplicate validation logic and fragment the test infrastructure.

**Implication**: We will need to extend `GhCliWrapper` with three new methods, but this is **out of scope** for #788 (the package is owned by G0.1). For v1 we call `gh` directly via a thin local helper that reuses the same `CommandRunner` runner type. A follow-up issue can fold the methods into the wrapper.

The local helper will cover:
- `gh issue view <n> --repo <r> --json comments` (comments + timestamps)
- `gh api repos/{owner}/{repo}/issues/{n}/timeline` (label events)
- `gh issue comment <n> --repo <r> --body <text>` (the manual-advance comment)
- `gh pr list --search head:<branch> --json url,number` (find PR for branch)
- `gh pr diff <pr> --name-only` + `gh pr diff <pr> --patch | git apply --stat` (touched files + summary)

### D-R2 — Use `WORKFLOW_LABELS` from `@generacy-ai/workflow-engine` as the single source for gate vocabulary

**Decision**: `gate-vocabulary.ts` walks `WORKFLOW_LABELS` once at module load, pairs each `waiting-for:<x>` with the matching `completed:<x>` (if present), and exports `GATES: Map<string, { waitingLabel, completedLabel }>`.

**Why**: SC-005 explicitly forbids a parallel `completed:*` list. The workflow-engine constant is already the source of truth for label sync and the orchestrator's label monitor.

**Alternatives considered**:
- Hand-rolled enum: Faster to read, but creates a second list that drifts on label additions. Rejected.
- Re-export from `@generacy-ai/cockpit`: Would be cleaner long-term. Deferred to OQ-1.

### D-R3 — Issue identifier accepts `<n>`, `<owner>/<repo>#<n>`, full URL

**Decision**: `issue-ref.ts` parses three forms via straightforward regex matches. Bare-number form delegates to `cockpit.repos` lookup; AD-5 applies.

**Why**: Matches FR-003. Three forms covers gh-style references (`owner/repo#n`), URL paste (most common from browser), and the bare number for the single-repo case.

### D-R4 — Read `spec.md` and `plan.md` from the **current** branch's spec dir

**Decision**: `clarify-context` derives the spec directory from the current git branch name (`git branch --show-current` → `specs/<branch>/spec.md`), with a fallback to scanning `specs/` for a dir whose name starts with `<issue-number>-`.

**Why**: Matches the existing speckit convention (`/specify` writes to `specs/<branch-name>/`). Branch name is the closest thing to a stable spec-dir identifier — issue numbers can repeat across forks/clones; branch names track the developer's checked-out state.

**Failure mode**: If neither path finds a `spec.md`, the field is emitted as `null`. The consumer schema (FR-009) explicitly allows this.

### D-R5 — Manual-advance comment uses a single, parse-friendly HTML marker

**Decision**: First line of the manual-advance comment is exactly:

```
<!-- generacy-cockpit:manual-advance gate=<name> actor=<gh-login> ts=<ISO-8601> -->
```

…followed by a blank line, then a one-line human summary. Downstream tooling that wants to identify manual advances greps for the literal string `generacy-cockpit:manual-advance`.

**Why**: HTML comments don't render in GitHub's issue UI, so the marker stays invisible to humans while remaining trivially grep-able. The `key=value` shape is small, parseable with a single regex, and extensible without breaking older consumers.

**Alternatives considered**:
- JSON in the comment body: Renders visibly. Rejected.
- A trailing footer line: Slightly less reliable (callers might prepend, not append). Rejected.

### D-R6 — `prDiffSummary` capped at 4 KiB

**Decision**: `gatherCodeReferences()` runs `gh pr diff <pr> --patch | head -c 4096` (logically; we'll read the patch in node and truncate). If truncated, the field is suffixed with `…[truncated]`.

**Why**: Spec assumption: "we are not optimizing for streaming or huge code blobs." 4 KiB is plenty for an LLM-targeted summary (≈800-1000 tokens) and bounds the JSON payload size predictably.

**Alternatives considered**:
- No cap: Violates the spec assumption and can produce multi-MB JSON for a refactor PR. Rejected.
- Stat-only (`gh pr diff --stat`): Loses too much signal — the consumer (clarification skill) benefits from actual change context. Rejected.
- 16 KiB / 64 KiB: Larger budgets help marginally for big PRs but most clarifications fit in 4 KiB. Re-evaluate after first usage telemetry.

### D-R7 — Output discipline: explicit stderr stream for logging

**Decision**: Top of each command file:

```ts
const logger = getLogger().child({ component: 'cockpit:<verb>' }, { stream: process.stderr });
```

…and we never call `console.log` in the verb body except to emit the user-facing payload. Errors thrown from within verbs are caught at the Commander layer and printed to stderr by `setupErrorHandlers()`.

**Why**: FR-010 requires "JSON to stdout, logs to stderr". The default `pino` stream is stderr, but we make it explicit to defend against future changes to the logger module. Verified by `clarify-context` integration test that pipes stdout into `JSON.parse()`.

## Alternatives Considered (rejected at plan stage)

### A-R1 — Build `cockpit` as a separate binary instead of a subcommand group

Rejected. The `generacy` CLI is the established surface; users already know it. A separate binary would fragment installation, version-skew between binaries, and confuse the help/discoverability story. Subcommand group matches FR-012.

### A-R2 — Use Octokit (`@octokit/rest`) instead of `gh` CLI shell-out

Rejected. The cockpit foundation (#786) deliberately uses `gh` so that developers' existing `gh auth` state, enterprise SSO, and proxy/network config "just work". Introducing Octokit here would require re-implementing the auth path. Out of scope for #788.

### A-R3 — Single `cockpit <verb>` command file instead of one file per verb

Rejected. The CLI's existing pattern (see `commands/cluster/`, `commands/launch/`, `commands/status/`) is one directory per verb (or per command group) with focused files. Three verbs at ~50-150 LOC each are easier to navigate as separate files, and the test files mirror the source files 1:1.

### A-R4 — `cockpit state` accepts multiple issues

Rejected. The spec scopes all three verbs as "single-issue". A batch verb is the right shape for a future `cockpit status` (#787, G1.1), which already has list-mode semantics.

## Implementation Patterns Borrowed

- **Command directory layout**: `packages/generacy/src/cli/commands/status/` (single-purpose verb with `index.ts` + `formatter.ts` + `__tests__/`).
- **Injectable runner for tests**: `packages/cockpit/src/gh/wrapper.ts` (`CommandRunner` constructor injection).
- **Config loading**: `loadCockpitConfig` from `@generacy-ai/cockpit` (already wraps `.generacy/config.yaml` parsing).
- **JSON-flag pattern**: `commands/status/index.ts` `--json` boolean + dual formatter.
- **Pino logger setup**: `cli/utils/logger.ts` `getLogger()` + child loggers.

## References

- Spec: `specs/788-epic-generacy-ai-tetrad/spec.md`
- Clarifications: `specs/788-epic-generacy-ai-tetrad/clarifications.md` (answers were not recorded; AD-1..5 inferred from spec)
- Foundation package: `packages/cockpit/src/` (#786, landed)
- Label vocabulary: `packages/workflow-engine/src/actions/github/label-definitions.ts`
- CLI registration: `packages/generacy/src/cli/index.ts`
- Epic plan: `docs/epic-cockpit-plan.md` in `tetrad-development` (P1 / G1.2)
- Issue: https://github.com/generacy-ai/generacy/issues/788

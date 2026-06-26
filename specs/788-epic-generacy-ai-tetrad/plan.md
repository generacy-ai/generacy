# Implementation Plan: `generacy cockpit` — `state`, `advance`, `clarify-context`

**Feature**: Three single-issue verbs on the `generacy cockpit` CLI (G1.2 of the Epic Cockpit), built on the `@generacy-ai/cockpit` foundation package that landed in #786.
**Branch**: `788-epic-generacy-ai-tetrad`
**Status**: Complete
**Issue**: generacy-ai/generacy#788
**Epic**: generacy-ai/tetrad-development#85 — Phase P1 / Tier v1-core

## Summary

Wire three new subcommands under a new top-level `cockpit` command group in `packages/generacy`:

1. **`generacy cockpit state <issue> [--json]`** — call `classify()` from `@generacy-ai/cockpit` on one issue's labels and print the curated tier + source label.
2. **`generacy cockpit advance <issue> --gate <name>`** — add `completed:<name>` and remove `waiting-for:<name>` for an issue whose current waiting gate matches; mark the action as manual via a structured issue comment so downstream watchers can distinguish it from agent-driven completions.
3. **`generacy cockpit clarify-context <issue>`** — emit a stable JSON document (`{ issue, clarificationComment, spec, plan, codeReferences }`) to stdout, refusing to run unless the issue is currently in `waiting-for:clarification`.

All three verbs reuse foundation primitives (`classify`, `GhCliWrapper`, `loadCockpitConfig`, `WORKFLOW_LABELS`). No new label vocabulary, no new classification logic. JSON to stdout, logs to stderr, named errors (not stack traces).

## Technical Context

- **Language / runtime**: TypeScript, Node.js ≥22 (matches existing `@generacy-ai/generacy` package).
- **CLI framework**: `commander` (existing pattern across `packages/generacy/src/cli/commands/*`).
- **Validation**: `zod` for inbound JSON shapes (gh CLI output, optional flags).
- **Logging**: `pino` via `getLogger()` (existing `utils/logger.ts`), routed to stderr.
- **Dependencies**:
  - `@generacy-ai/cockpit` workspace dep (already landed in #786) — `classify`, `GhCliWrapper`, `loadCockpitConfig`, plus we re-export `WORKFLOW_LABELS` (or import directly from `@generacy-ai/workflow-engine`, see Open Question OQ-1).
  - `@generacy-ai/workflow-engine` for `WORKFLOW_LABELS` (single source of truth for the `waiting-for:*` ↔ `completed:*` vocabulary).
- **Testing**: `vitest` integration tests under `packages/generacy/src/cli/commands/cockpit/__tests__/`, with an injectable `CommandRunner` (already on `GhCliWrapper`) for hermetic test runs — no live `gh` calls.
- **Output discipline**: stdout reserved for the user-facing payload (text or JSON); stderr for logs and errors. Verified by integration tests that pipe stdout into `JSON.parse()`.

## Architectural Decisions

These are the load-bearing decisions for this issue. Five of them resolve open questions that the `/clarify` phase opened on this spec. The clarifications file recorded the questions but did **not** record explicit answers — the saved "Answer" sections mirror the question text. The decisions below are inferred from the **spec's own assumptions and Out-of-Scope sections** so that planning can proceed; each is annotated with a back-pointer. If the user later records different answers, the corresponding section can be revisited without disturbing the other four.

### AD-1: Manual-advance marker = issue comment with HTML structured marker (resolves Q1)

When `cockpit advance` flips a gate, it posts **one issue comment** with the shape:

```
<!-- generacy-cockpit:manual-advance gate=<name> actor=<gh-login> ts=<ISO-8601> -->
Manually advanced `waiting-for:<name>` → `completed:<name>` by **@<gh-login>**.
```

Then adds `completed:<name>` and removes `waiting-for:<name>` via `gh issue edit`. The HTML comment is the machine-readable side; the human line is for the issue thread reader. No label vocabulary change.

**Why**: Spec §Assumptions: "The 'marked' mechanism on manual advance does not require new label vocabulary (no `manual:` prefix); a comment + the `completed:*` label suffices." Body markers were ruled out by the assumption (they conflict with stage trackers); label suffixes were ruled out by Out of Scope ("No new label types or vocabulary changes").

### AD-2: `codeReferences` shape = `{ touchedFiles, prUrl, prDiffSummary }` (resolves Q2)

The `codeReferences` field in the `clarify-context` JSON is:

```ts
codeReferences: {
  touchedFiles: string[];           // from `gh pr diff --name-only` or `git diff --name-only` fallback
  prUrl: string | null;             // open PR for the issue's branch, or null
  prDiffSummary: string | null;     // short text: `git diff --stat` output, capped at 4 KiB
} | null
```

No raw unified diff blob. Bounded payload size.

**Why**: Spec §Assumptions: "The consumer of `clarify-context`'s JSON … is OK with a flat structured shape; we are not optimizing for streaming or huge code blobs." Option B (raw diff) violates the size assumption; Option C (per-file hunks) is richer than the consumer needs and pushes diff-parsing logic into the CLI.

### AD-3: Clarification comment = first comment after `waiting-for:clarification` label event (resolves Q3)

`clarify-context` selects "the clarification comment" by:

1. Fetch `gh api repos/{owner}/{repo}/issues/{number}/timeline` to find the **most recent** event with `event === 'labeled'` and `label.name === 'waiting-for:clarification'`. Record its `created_at` timestamp.
2. Fetch `gh issue view {number} --json comments` and return the **first** comment whose `created_at >= label_event_timestamp`.
3. If no qualifying comment exists, the field is `null` (consumer error-handles).

**Why**: Robust against bot identity drift (we don't have to know which actor posts clarifications), works for clarifications posted by humans, and is the most defensible "this is the thing the developer just got asked about" heuristic. Option A (bot-marker matching) couples to a specific marker format we'd need to keep in sync; Option C (return all comments) pushes selection logic into every consumer.

### AD-4: `--force` deferred to a follow-up issue (resolves Q4)

`cockpit advance` always refuses to advance a gate that is not the active `waiting-for:*`. No `--force` flag in v1.

**Why**: FR-006 calls out `--force` as P2, and the spec's Out of Scope does not include it. Shipping a `--force` here would expand scope, require additional integration tests, and create a foot-gun. A follow-up issue can add it once the v1 surface is in use.

### AD-5: Bare-number issue resolution requires exactly one monitored repo (resolves Q5)

Issue identifier parsing accepts three forms: `<number>`, `<owner>/<repo>#<number>`, and a full URL. The bare-number form resolves **only** when `cockpit.repos` (loaded via `loadCockpitConfig`) contains exactly one repo. Zero or >1 monitored repos with a bare-number argument → exit non-zero with: `Cannot resolve issue #<n>: <m> monitored repos configured. Use <owner>/<repo>#<n> or the full URL.`

**Why**: Fail-loud is the right default at a small CLI surface. Option B (search every repo) adds gh round-trips per command invocation and can silently pick the wrong issue when numbers collide across repos. Option C (first-in-list) is the foot-gun the assumption was written to avoid.

### AD-6: Manual-advance idempotency check is label-state, not comment-history

When `completed:<name>` is already on the issue, `cockpit advance` exits 0 with `already advanced` and does **not** post a second comment. We do not scan comment history for an existing manual-advance marker — a label on the issue is the authoritative idempotency token.

**Why**: Matches FR-005 ("Idempotent: re-running on an already-advanced issue is a no-op with a clear message"). Comment-scanning would add a round trip and an edge case (what if the comment was deleted?) for no functional gain.

### AD-7: `cockpit clarify-context` does **not** mutate the issue

The command is strictly read-only against GitHub. It does not post a comment, change a label, or call any write API. Failures (404, gh auth, wrong gate) exit non-zero before any side effect.

**Why**: FR-008/FR-009/FR-010 describe a read-and-emit verb. Mutating in this verb would couple the clarification skill's success to the side effect of running the gather step, making retries unsafe.

### AD-8: Single-repo scope for v1

All three verbs operate on one issue in one repo per invocation. No cross-repo fan-out, no batch mode.

**Why**: Spec §Out of Scope: "Cross-repo advance (advancing an issue in a sibling repo from a different cwd) — single-repo scope for v1."

## Project Structure

### New files (owned by this issue)

```
packages/generacy/src/cli/commands/cockpit/
├── index.ts                          # cockpitCommand() — registers state/advance/clarify-context as subcommands
├── state.ts                          # stateCommand(): calls cockpit.classify on one issue
├── advance.ts                        # advanceCommand(): gate-validate → comment → addLabel → removeLabel
├── clarify-context.ts                # clarifyContextCommand(): assemble + emit JSON
├── issue-ref.ts                      # parseIssueRef() — accepts <number> | owner/repo#<number> | URL; resolves via cockpit config
├── gate-vocabulary.ts                # listGates() — derives valid gate names from WORKFLOW_LABELS (paired waiting-for / completed)
├── manual-advance-marker.ts          # formatManualAdvanceComment({ gate, actor, ts }) — single source for the HTML marker
├── clarification-comment-finder.ts   # findClarificationComment(gh, repo, issue) — implements AD-3
├── code-references.ts                # gatherCodeReferences(repo, issue, branch?) — touchedFiles + prUrl + prDiffSummary
└── __tests__/
    ├── state.test.ts
    ├── advance.test.ts
    ├── advance-marker.test.ts
    ├── clarify-context.test.ts
    ├── clarification-comment-finder.test.ts
    ├── code-references.test.ts
    ├── issue-ref.test.ts
    └── gate-vocabulary.test.ts
```

### Modified files

```
packages/generacy/src/cli/index.ts    # add: import { cockpitCommand } from './commands/cockpit/index.js';
                                      #      program.addCommand(cockpitCommand());
packages/generacy/package.json        # add workspace dep on @generacy-ai/cockpit (if not already)
                                      # ensure dep on @generacy-ai/workflow-engine
```

### Files that must NOT be touched (isolation boundary)

- `packages/cockpit/**` — owned by G0.1; this issue consumes it only.
- `packages/workflow-engine/src/actions/github/label-definitions.ts` — single source of label vocabulary; this issue reads it.
- Any `packages/orchestrator/**` or `packages/control-plane/**` file — out of scope.
- `specs/788-epic-generacy-ai-tetrad/spec.md` — spec is read-only after `/specify`.

## Implementation Phases

1. **Wire-up**: scaffold `packages/generacy/src/cli/commands/cockpit/index.ts`, register under `program`, add an empty subcommand stub for each verb that prints usage. Validate `generacy cockpit --help`.
2. **Shared helpers**: `issue-ref.ts`, `gate-vocabulary.ts`. Pure functions, unit-tested. Foundation deps wired (`@generacy-ai/cockpit`, `@generacy-ai/workflow-engine`).
3. **`state` verb**: load config, parse ref, fetch issue labels via `GhCliWrapper`, call `classify()`, format output (text and `--json`). Integration test using a stub `CommandRunner`.
4. **`advance` verb**: validate gate, fetch labels, refuse if not active waiting gate, format comment, gh comment + addLabel + removeLabel. Integration test for happy path, already-advanced, wrong-gate, unknown-gate.
5. **`clarify-context` verb**: parse ref, refuse if not `waiting-for:clarification`, gather all four payload sections, emit JSON. Integration test for happy path and refusal cases.
6. **Polish**: error messages, `--help` text, doctor-style entry if applicable. Smoke test against a live test issue (manual, documented in `quickstart.md`).

## Constitution Check

No `.specify/memory/constitution.md` file exists in this repo. Cross-checked the spec against repository conventions instead:

- **Single source of truth for label vocabulary** — SC-005 requires no hard-coded `completed:` list. Plan honors via `gate-vocabulary.ts` deriving from `WORKFLOW_LABELS`.
- **JSON to stdout, logs to stderr** — FR-010 explicit; plan honors via `pino` logger configured to stderr stream.
- **gh CLI mediated through `GhCliWrapper`** — established pattern in `packages/cockpit/src/gh/wrapper.ts`. Plan does not add a second gh client.
- **No new label vocabulary** — explicit Out of Scope. Plan honors via AD-1 (comment-based marker).
- **CLI command pattern** — matches existing `commands/<verb>/index.ts` layout (see `cluster/`, `launch/`, `status/`).

## Open Questions Carried Forward

- **OQ-1**: Whether to import `WORKFLOW_LABELS` directly from `@generacy-ai/workflow-engine` in this package, or have `@generacy-ai/cockpit` re-export it for consumer convenience. Doesn't affect functionality. Decision: import directly from `workflow-engine` for v1 (matches the existing pattern in `packages/cockpit/src/state/label-map.ts`); revisit if a second consumer appears.
- **OQ-2**: Whether `clarify-context` should follow the issue body's "Generated by speckit" hint to locate `spec.md` on disk, or use the branch name (`<n>-<short>`). Plan: prefer branch name (`specs/<branch>/spec.md` where `<branch>` is the current checked-out branch), with a fallback to scanning `specs/` for a dir starting with `<n>-`. Documented in `quickstart.md`.
- **OQ-3**: Confirmed-but-flagged: the recorded answers in `clarifications.md` are question restatements, not selections. AD-1 through AD-5 above use spec assumptions as the answer source. If the `/clarify` phase is re-run with explicit selections that differ, those ADs should be revised before `/tasks` proceeds.

## Next Step

Run `/speckit:tasks` to generate the dependency-ordered task list from this plan, the data model, and the contracts.

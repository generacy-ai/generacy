# Feature Specification: `generacy cockpit` — `state`, `advance`, `clarify-context` verbs

**Branch**: `788-epic-generacy-ai-tetrad` | **Date**: 2026-06-26 | **Status**: Draft
**Epic**: generacy-ai/tetrad-development#85 | **Phase**: P1 | **Tier**: v1-core | **Issue**: G1.2 (generacy-ai/generacy#788)

## Summary

Add three single-issue verbs to the `generacy cockpit` CLI, built on the foundation package landed in G0.1 (#786):

1. **`generacy cockpit state <issue>`** — classify one issue's current cockpit state (the curated tier: `pending` / `active` / `waiting` / `error` / `terminal` / `unknown`) and print the source label that drove the classification.
2. **`generacy cockpit advance <issue> --gate <name>`** — manually advance a gated issue by adding the matching `completed:<name>` label (and removing the corresponding `waiting-for:<name>` label). Tags the action as a manual advance so downstream tooling can distinguish it from agent-driven completions.
3. **`generacy cockpit clarify-context <issue>`** — gather everything a clarification skill needs to answer the open clarification request: the latest `waiting-for:clarification` comment, the feature `spec.md`, the `plan.md` (if present), and the relevant snippet of code touched by the in-flight branch — emitted as structured JSON on stdout.

**Owns (isolation):** `packages/generacy/src/cli/commands/cockpit/{state,advance,clarify-context}.ts`

**Depends on:** G0.1 (`@generacy-ai/cockpit` package — provides `classify()`, `GhCliWrapper`, config loader). Already landed in #786.

**Plan reference:** Epic Cockpit plan in tetrad-development, P1 / G1.2.

## User Stories

### US1: Inspect one issue's cockpit state (primary)

**As a** developer running a speckit epic,
**I want** to ask "what state is issue #N in right now?" from the terminal,
**So that** I can decide whether to wait, clarify, review, or merge — without round-tripping through the GitHub web UI.

**Acceptance criteria:**
- [ ] `generacy cockpit state 788` exits 0 and prints (at minimum) the curated state tier and the label that drove the classification.
- [ ] `--json` flag emits machine-readable `{ issue, state, sourceLabel }` for piping into other tools.
- [ ] Unknown / unclassified issues print `unknown` rather than erroring.
- [ ] Missing or inaccessible issue (404, no auth) exits non-zero with a clear error pointing at the offending step (gh auth vs. repo scope vs. issue not found).

### US2: Manually advance a gate

**As a** developer reviewing a waiting issue (e.g., I've answered the clarification, approved the plan, signed off on tasks),
**I want** to run one command that flips the gate forward,
**So that** the agent watcher picks it up on the next tick and I don't have to click through GitHub's label UI.

**Acceptance criteria:**
- [ ] `generacy cockpit advance 788 --gate clarification` adds `completed:clarification` to the issue (and removes `waiting-for:clarification` if present).
- [ ] The `--gate` name maps to the label pair (`waiting-for:<name>` ↔ `completed:<name>`) via the same workflow-engine label vocabulary the rest of the system uses (no duplicated label list).
- [ ] The command refuses to advance a gate that is not currently the active `waiting-for:*` on the issue (no silent skipping forward two phases at once).
- [ ] The completion is marked (e.g., a comment, body marker, or label-comment trail) so downstream tooling can identify it as a manual advance rather than an agent-driven completion.
- [ ] Unknown / typo'd gate names exit non-zero with the valid gate list.

### US3: Gather structured clarification context

**As a** clarification skill (or the developer prepping one),
**I want** all the artifacts needed to answer an open clarification request in one structured JSON payload,
**So that** I don't have to scrape the issue thread, find the spec, locate the plan, and grep the diff by hand.

**Acceptance criteria:**
- [ ] `generacy cockpit clarify-context 788` emits a single JSON document to stdout containing: the clarification comment (text + author + timestamp), the feature `spec.md` contents, the `plan.md` contents (when present), and a list of relevant code references (touched files / open PR diff).
- [ ] The command refuses to run on an issue that is not in the `waiting-for:clarification` state, with an explanatory error.
- [ ] Missing artifacts (no plan yet, no PR yet) are represented as explicit `null` / empty fields rather than omitted — the consumer schema is stable.
- [ ] Output is valid JSON parseable by the consumer skill (no log noise mixed in; logs go to stderr).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `cockpit state <issue>` calls `classify()` from `@generacy-ai/cockpit` and prints the result | P1 | Reuses foundation; no new classification logic. |
| FR-002 | `cockpit state` supports `--json` for machine-readable output | P1 | Default is a short human-readable line. |
| FR-003 | `cockpit state` uses the cockpit config (`gh auth` + `MONITORED_REPOS`) to resolve the issue's repo when only a number is given | P1 | Accept `<number>`, `<owner>/<repo>#<number>`, or full URL. |
| FR-004 | `cockpit advance <issue> --gate <name>` maps `<name>` to the `waiting-for:<name>` ↔ `completed:<name>` label pair from `WORKFLOW_LABELS` | P1 | Single source of truth — must not hard-code a parallel list. |
| FR-005 | `cockpit advance` adds the `completed:<name>` label and removes `waiting-for:<name>` when present | P1 | Idempotent: re-running on an already-advanced issue is a no-op with a clear message. |
| FR-006 | `cockpit advance` refuses to advance a gate that is not the currently active `waiting-for:*` on the issue | P1 | Prevents skipping phases. Override with `--force` (P2). |
| FR-007 | `cockpit advance` marks the completion as manual (so downstream watchers can distinguish it from agent-driven completions) | P1 | Mechanism: an issue comment + a marker on the `completed:*` label addition. Exact format decided in plan. |
| FR-008 | `cockpit clarify-context <issue>` refuses to run on issues not in `waiting-for:clarification` | P1 | Exits non-zero with explanatory error. |
| FR-009 | `cockpit clarify-context` emits a JSON document with: clarification comment, spec.md, plan.md (or null), and code references (touched files / PR diff summary, or null) | P1 | Stable schema; missing fields = explicit nulls, not omissions. |
| FR-010 | `cockpit clarify-context` writes JSON to stdout, logs to stderr | P1 | Stdout must be parseable; no mixed output. |
| FR-011 | Errors from gh auth / repo scope / network failures are reported with the failing step named, not a stack trace | P1 | Matches the rest of the generacy CLI's UX. |
| FR-012 | All three verbs are wired into `packages/generacy/src/cli/index.ts` under the `cockpit` subcommand group | P1 | Discoverable via `generacy cockpit --help`. |
| FR-013 | All three verbs work on closed/merged issues (just report state + abort gracefully) | P2 | Edge case but common. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `cockpit advance` adds the correct `completed:*` label and removes the matching `waiting-for:*` label | 100% match for a real `waiting-for:clarification` issue | Run against a live test issue; assert via `gh issue view --json labels`. |
| SC-002 | `cockpit clarify-context` emits structured JSON for a real `waiting-for:clarification` issue | Parses with `JSON.parse()`; all four top-level fields present | Run against a real waiting issue; pipe stdout into `jq`. |
| SC-003 | `cockpit state` correctly classifies all curated tiers (`pending`/`active`/`waiting`/`error`/`terminal`/`unknown`) | All 6 tiers covered by integration tests | Vitest integration tests in `packages/generacy/src/cli/commands/cockpit/__tests__/`. |
| SC-004 | Time from `cockpit advance` invocation to the GitHub label change | < 3s for a single issue (network-limited) | Manual observation; the bottleneck is `gh` round-trips. |
| SC-005 | No duplicated label vocabulary | `cockpit advance` imports from `WORKFLOW_LABELS` (via `@generacy-ai/workflow-engine` or re-exported by `@generacy-ai/cockpit`) — `grep` finds no hard-coded `completed:` list in this issue's owned files | Code review + grep. |

## Assumptions

- The `@generacy-ai/cockpit` package (G0.1 / #786) is available and exports `classify()`, `GhCliWrapper`, config loader, and label-vocabulary access. (Confirmed — landed in #786.)
- `gh` CLI is authenticated in the developer's environment; the foundation handles `gh auth status` errors with a clear message.
- Feature/spec layout follows the speckit convention: `specs/<issue-short-name>/spec.md` and `specs/<issue-short-name>/plan.md` are discoverable from the issue (via branch name or issue body link).
- The "marked" mechanism on manual advance does not require new label vocabulary (no `manual:` prefix); a comment + the `completed:*` label suffices.
- The consumer of `clarify-context`'s JSON (the clarification skill) is OK with a flat structured shape; we are not optimizing for streaming or huge code blobs.

## Out of Scope

- The `cockpit watch` and `cockpit status` verbs (separate issue G1.1 / #787).
- The `cockpit merge` and `cockpit review-context` verbs (separate issue G1.3 / #789).
- `cockpit manifest init/sync` and `cockpit queue <phase>` pipeline verbs (P3 issues G3.x).
- Slash-command surface (`/cockpit:state`, `/cockpit:clarify`, etc.) — those live in the `agency` repo (P2).
- Process-label vocabulary (`process:*`) — explicitly deferred per the epic plan.
- New label types or vocabulary changes — this issue consumes the existing label vocabulary, it does not extend it.
- Cross-repo advance (advancing an issue in a sibling repo from a different cwd) — single-repo scope for v1.

---

*Generated by speckit; enhanced from issue #788.*

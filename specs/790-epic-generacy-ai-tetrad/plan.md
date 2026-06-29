# Implementation Plan: cockpit manifest init/sync verb

**Feature**: Add `generacy cockpit manifest <init|sync>` CLI verb that creates and maintains the per-epic manifest YAML at `.generacy/epics/<slug>.yaml`.
**Branch**: `790-epic-generacy-ai-tetrad`
**Date**: 2026-06-26
**Status**: Complete
**Issue**: [generacy-ai/generacy#790](https://github.com/generacy-ai/generacy/issues/790)
**Spec**: [spec.md](./spec.md)

## Summary

`cockpit manifest` is the missing front door for the v2 epic cockpit pipeline. Today, every other cockpit verb (`watch`, `status`, `queue`, `merge`, `advance`) reads `.generacy/epics/<slug>.yaml` but no command writes it — manifests are hand-edited, which is the bottleneck blocking `cockpit queue <phase>` (#791, G3.2).

This feature adds two subverbs:

- `init <epic-ref>` reads the epic issue from GitHub, parses its "Children by phase" body section under a lenient grammar (per [clarifications.md](./clarifications.md) Q1/B), derives a kebab-case slug from the title, records the `Plan:` line as `epic.plan` (bare repo-relative path, Q4/A), and writes the manifest via the foundation package's atomic IO. `--force` / `--slug <s>` resolve collisions per Q5/A.
- `sync` re-reads the same epic body, matches phases by their `P\d+` index (Q2/B), mirrors phase-level shape (Q3/A — adds phases new to the body, removes vanished phases, parses `tier` from the `→ vN` heading marker), and diffs `issues[]` within matched phases. Leaves `autonomy` and unknown keys untouched. Idempotent.

The whole feature is built on the `@generacy-ai/cockpit` foundation package (#786, G0.1) — no new manifest schema, no new gh wrapper, no new YAML IO. The CLI command is a thin pure-function parser + diff layer over `readManifest`/`writeManifest`/`GhCliWrapper`.

## Technical Context

**Language/Version**: TypeScript 5.x, Node ≥22 (matches CLI package gate)
**Primary Dependencies**:
- `@generacy-ai/cockpit` (workspace) — `EpicManifestSchema`, `readManifest`, `writeManifest`, `GhCliWrapper`, `CommandRunner` for fakeable gh access.
- `commander` (already a CLI dep) — subcommand registration under the existing `cockpit` group.
- `yaml` (transitive via cockpit) — schema round-trip; never imported directly here.
- `zod` (transitive via cockpit) — validation only via `EpicManifestSchema.parse`.

No new runtime dependencies. No new dev dependencies (vitest already configured).

**Storage**: YAML files on disk under `.generacy/epics/<slug>.yaml`. Atomic writes via existing `writeManifest()` (temp+rename). No database, no network state.

**Testing**:
- Vitest unit tests at `packages/generacy/src/cli/commands/cockpit/__tests__/manifest.test.ts`.
- All gh calls go through `CommandRunner` and are stubbed with the existing `fake-gh.ts` pattern used by sibling verbs (`state.test.ts`, `advance.test.ts`).
- Filesystem tests use Node tmp dirs (`fs.mkdtemp`) — no global state.

**Target Platform**: CLI execution on developer machines (macOS / Linux WSL2). Node 22+ via `bin/generacy.js`.

**Project Type**: Single TypeScript monorepo package (`packages/generacy`), adding one file (+ tests) inside an existing subcommand group.

**Performance Goals**: Not perf-sensitive. `init` makes one `gh issue view`; `sync` makes one `gh issue view` and one disk read/write. Sub-second is fine; no targets.

**Constraints**:
- **Isolation contract (FR-003, SC-005)**: only `packages/generacy/src/cli/commands/cockpit/manifest.ts` (plus optional `cockpit/manifest/` helpers) and a one-line registration in `cockpit/index.ts` are added or modified. `git diff --stat` on the branch must show only these.
- **No direct `child_process`** in `manifest.ts` (FR-011). All gh access via the foundation wrapper or the existing `CommandRunner` injection pattern.
- **No duplicate manifest IO** (FR-004). Importing `EpicManifestSchema` directly is fine; re-implementing parse/write is not.

**Scale/Scope**: One CLI verb with two subcommands. ~300 LOC of source + ~400 LOC of tests. Single-repo manifests for v1; cross-repo `phases[*].repos` is populated incidentally from `owner/repo#n` refs (FR-004/Assumptions). One epic body parser and one phase diff function are the only new units of complexity.

## Constitution Check

There is no `.specify/memory/constitution.md` in this repo (verified by `find .specify`). The implicit constitution gates we check against are the spec's own non-functional constraints and the isolation contract:

| Gate | Status | Notes |
|------|--------|-------|
| Isolation contract (FR-003, SC-005) | ✅ Plan-pass | Only `manifest.ts` + one-line `index.ts` import. No edits in `@generacy-ai/cockpit`. |
| No duplicate manifest schema/parser (FR-004) | ✅ Plan-pass | Reuse `EpicManifestSchema`, `readManifest`, `writeManifest` from `@generacy-ai/cockpit`. |
| No direct `child_process` calls (FR-011) | ✅ Plan-pass | All gh access via `GhCliWrapper` or the `CommandRunner` injection used by sibling verbs in `gh-ext.ts`. |
| Fail-loud, no partial writes (US3) | ✅ Plan-pass | `writeManifest()` already atomic; `init` writes once at end after all parsing succeeds; `sync` only writes when diff is non-empty. |
| Atomic IO | ✅ Plan-pass | Inherited from `writeManifest` (tmp + rename). |
| Tests fakeable without live gh (FR-011) | ✅ Plan-pass | `CommandRunner` injected into `GhCliWrapper` constructor lets tests use `fake-gh.ts`. |

No deviations. No complexity tracking entries needed.

Re-check post-design (Phase 1): unchanged — all three artifacts below (research, data-model, contracts) stay inside the isolation contract.

## Project Structure

### Documentation (this feature)

```text
specs/790-epic-generacy-ai-tetrad/
├── spec.md                # Feature specification (read-only here)
├── clarifications.md      # Locked Q&A (Batch 1, 2026-06-26)
├── plan.md                # This file
├── research.md            # Phase 0: technology decisions, parser strategy
├── data-model.md          # Phase 1: parser/diff types, schema reuse map
├── contracts/
│   └── cli.md             # CLI invocation contract, --json output schema, exit codes
├── quickstart.md          # Phase 1: install + usage examples
├── checklists/            # (populated by /speckit:checklist later)
└── tasks.md               # Phase 2: generated by /speckit:tasks
```

### Source Code (repository root)

```text
packages/generacy/
├── src/cli/commands/cockpit/
│   ├── index.ts                           # MODIFIED: +1 import + 1 addCommand line
│   ├── manifest.ts                        # NEW: subcommand registration + action handlers
│   ├── manifest/                          # NEW (optional helpers — split only if manifest.ts grows past ~250 LOC)
│   │   ├── parse-epic-body.ts             # NEW: lenient body parser → ParsedEpicBody
│   │   ├── derive-slug.ts                 # NEW: title → kebab-case + collision resolution
│   │   ├── extract-plan.ts                # NEW: "Plan:" line → bare repo-relative path
│   │   ├── diff-phases.ts                 # NEW: ParsedEpicBody vs EpicManifest → ChangeSet
│   │   └── resolve-manifest-path.ts       # NEW: cwd → manifest path (single-manifest scoping)
│   └── __tests__/
│       ├── manifest.test.ts               # NEW: covers FR-010 (body-parse, slug, sync diff, --force)
│       └── fixtures/
│           ├── epic-cockpit-body.md       # NEW: fixture for SC-002 hand-verified diff
│           └── epic-cockpit-expected.yaml # NEW: golden output for init
└── package.json                           # UNCHANGED — no new dependencies

packages/cockpit/                          # UNCHANGED (foundation, already published)

.generacy/epics/
└── epic-cockpit.yaml                      # NEW (reference manifest committed alongside this work, per Assumption)
```

**Structure Decision**:

Adopted the **isolation-by-single-file** layout: all new logic owned by `packages/generacy/src/cli/commands/cockpit/manifest.ts`, optionally split into a sibling `manifest/` directory if the single file grows past ~250 LOC during implementation. This matches the FR-003 / SC-005 isolation contract literally and mirrors the structure already in use for sibling verbs (`watch.ts` + `watch/`, `status.ts` + `status/`).

The optional `manifest/` helpers are pure functions — parser, slug deriver, diff — so they can be unit-tested directly without the Commander shim or any gh stub.

The one-line wire-up in `cockpit/index.ts` (`command.addCommand(manifestCommand());`) is the only modification outside the owned path, and is explicitly allowed by FR-003.

## Complexity Tracking

No constitution violations. Section intentionally empty.

## Next Steps

1. `/speckit:tasks` — generate the dependency-ordered task list from this plan + data-model.md + contracts/cli.md.
2. `/speckit:implement` — execute tasks.md against the codebase.

The unblock target after merge is `cockpit queue <phase>` (#791, G3.2), which assumes a populated `.generacy/epics/<slug>.yaml` exists.

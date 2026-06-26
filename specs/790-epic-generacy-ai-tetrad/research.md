# Research: cockpit manifest init/sync verb (#790)

**Status**: Complete
**Date**: 2026-06-26

This document records the technology decisions made for `generacy cockpit manifest <init|sync>`, why each was chosen, what alternatives were rejected, and what implementation patterns the existing codebase already established.

## R1. Manifest schema, parser, and IO — reuse `@generacy-ai/cockpit`

**Decision**: Import `EpicManifestSchema`, `readManifest`, and `writeManifest` directly from `@generacy-ai/cockpit`. Do not re-implement.

**Rationale**:
- FR-004 mandates reuse — the spec is explicit.
- `writeManifest()` already does the atomic tmp+rename write that US3 requires (no partial writes).
- `readManifest()` already validates with Zod and returns null on ENOENT (the shape `sync` needs to detect "no manifest here").
- The foundation package is the only place we want a YAML schema to live; duplicating it would split the contract between two packages.

**Alternatives rejected**:
- Defining a parallel `ManifestV2Schema` in the CLI package — would split the schema across two packages and break FR-004.
- Writing YAML by hand via `yaml.stringify()` directly — bypasses the validation that `writeManifest()` does post-edit. Reuses the file IO but loses the safety net.

**Source**: `packages/cockpit/src/manifest/io.ts:34-41` (atomic write), `packages/cockpit/src/manifest/schema.ts:20-24` (schema).

## R2. gh access — `GhCliWrapper` + injected `CommandRunner`

**Decision**: Get the epic issue body via `GhCliWrapper.listIssues()` with a `repo:` + `is:issue` search query (`repo:owner/repo is:issue {number}`). Inject the underlying `CommandRunner` so tests can stub `gh` with a fixture function — same pattern as `state.ts` / `advance.ts` already use.

**Rationale**:
- FR-011 forbids direct `child_process` calls in `manifest.ts`.
- `GhCliWrapper.listIssues()` returns `Issue { number, title, body, labels, ... }` — covers everything `init` needs (title for slug, body for parsing, labels are unused but harmless).
- The `CommandRunner` injection on `GhCliWrapper`'s constructor (already in place) is the exact hook that makes the verb fakeable in unit tests without touching the network.
- Existing sibling verbs (`state.ts`, `advance.ts`) consume this same pattern with `createCockpitGh(runner)` — readers will recognize it.

**Alternatives rejected**:
- `gh issue view <n> --repo <r> --json title,body,labels` directly via `child_process` — violates FR-011.
- Add `getIssueDetail(repo, n)` to `GhCliWrapper` — wider change to the foundation package, breaks the isolation contract. `listIssues()` already covers the need.
- Use `octokit` REST client — would add a runtime dep and break the "all gh through the shared wrapper" architectural convention.

**Source**: `packages/cockpit/src/gh/wrapper.ts:415-440` (listIssues + runner injection), `packages/generacy/src/cli/commands/cockpit/state.ts:73-80` (sibling pattern).

## R3. Epic body parser — lenient regex, line-oriented

**Decision**: A line-oriented parser that walks the body once, classifying each line into `{ heading | bullet | other }`:
- `heading`: matches `^(##|###|####)\s+(.*)$` and captures the title; then a separate `P\d+` matcher inside that title (anywhere before the first separator) extracts the phase id and a `→ vN` matcher (anywhere in the title) extracts the optional tier.
- `bullet`: matches `^[\s]*-\s*(?:\[[ xX]\]\s*)?([A-Za-z0-9._-]+/[A-Za-z0-9._-]+#\d+)(?:\s*[—-]\s*.+)?$` and captures the issue ref. Trailing title is ignored at parse time (it's not stored in the schema).
- Anything else (prose, empty lines, indented lines that aren't bullets): silently skipped.

State machine: the parser tracks `currentPhase | null`. On `heading`, it flushes the previous phase (if any) and starts a new one if the title matched the `P\d+` pattern. On `bullet`, it appends the ref to `currentPhase.issues` only when `currentPhase` is non-null. On EOF, it flushes the last phase.

**Rationale**:
- Q1/B locked the grammar: lenient, optional checkboxes, `##`/`###`/`####` headings, prose between bullets skipped. A line-oriented regex matcher is the simplest faithful implementation.
- Real GitHub epic bodies are mixed Markdown — they contain prose paragraphs, footnotes, links, callouts. A strict block parser breaks the moment someone adds a sentence between bullets.
- The parser is pure (string → ParsedEpicBody) so it's trivially unit-testable against fixtures (FR-010, SC-002).

**Alternatives rejected**:
- Full Markdown AST via `remark` — adds a runtime dep, overkill. The grammar is regular; no nested constructs matter.
- A YAML-front-matter approach where the epic body has a fenced YAML block — out of scope and would require a fix to every existing epic body in the org.
- Single regex over the whole body — hard to reason about, hard to give precise error messages for malformed lines.

**Notes for implementation**:
- `P\d+` matcher must be greedy on digits (`P1`, `P10`, `P100` all valid) and ignore case (`p3` is tolerated to be safe).
- The `→ vN` tier matcher accepts ASCII fallback `-> vN` because GitHub Markdown sometimes loses the arrow character on copy-paste.
- The issue-ref regex pins `owner/repo#n` literally; we reject anything that doesn't match (silently — those bullets are just "prose").

## R4. `Plan:` line extraction — bare repo-relative path

**Decision**: Scan the body line-by-line for `^Plan:\s*(.+)$`. Take the captured group, strip a trailing `\s+in\s+\S+` qualifier, strip a trailing `\s*\(.+\)\s*$` parenthesized suffix, trim whitespace. If no `Plan:` line is found, exit non-zero with `Error: cockpit manifest init: epic body has no "Plan:" line. Add a line like 'Plan: docs/<your-plan>.md' to the epic body.`

**Rationale**:
- Q4/A locked the format: bare path, strip `in <repo>` and trailing `(...)`. The error message is explicitly an "actionable" one per the clarification.
- Two regexes is enough — order matters (strip `in <repo>` before stripping the parenthesized suffix, since the suffix can contain whitespace).

**Alternatives rejected**:
- Cross-repo qualified ref (`generacy-ai/tetrad-development:docs/...`) — rejected in Q4. The plan lives in the epic's own repo by convention.
- Default to the epic ref when missing (`generacy-ai/tetrad-development#85`) — rejected in Q4. Spec requires fail-loud behavior here so missing plans don't silently produce a manifest that misroutes later verbs.

## R5. Slug derivation + collision policy

**Decision**: `deriveSlug(title)` strips a leading `Epic:\s*` prefix (case-insensitive), lowercases, replaces any run of non-`[a-z0-9]+` with `-`, trims leading/trailing dashes, collapses repeated dashes.

`init` resolves the target file as:
1. `--slug <s>` provided → target is `<manifestRoot>/<s>.yaml`.
2. Otherwise → target is `<manifestRoot>/<derived>.yaml`.

Collision rule (Q5/A): if the target already exists, exit non-zero with `Error: cockpit manifest init: <path> already exists. Pass --force to overwrite or --slug <other> to choose a different name.` unless `--force` is passed, in which case the existing file is overwritten.

**Rationale**:
- Q5/A is precise: `--force` is the only way to overwrite. `--slug` selects the filename. Both flags together mean "overwrite at this filename."
- Stripping `Epic:` is convention — the spec's example epic title is `Epic: Cockpit` and the desired slug is `cockpit` (not `epic-cockpit`).

**Alternatives rejected**:
- Auto-suffixing (`-2`, `-3`) on collision — rejected in Q5. Surprising and produces orphan files.
- Allow `--slug` to silently overwrite without `--force` — rejected in Q5; would defeat the safety check.

## R6. Phase identity in `sync` — `P\d+` index

**Decision**: Phase matching key is the `P\d+` index parsed from the heading. The manifest's existing `name`, `tier`, and `autonomy` for a matched phase are preserved; only `name` is overwritten when the body's display name changed.

**Rationale**:
- Q2/B is explicit: index is stable, display name is cosmetic.
- The schema has no dedicated `id` field — the index is reconstructed from the existing `name` string on the manifest side using the same regex as the parser. Since the manifest is the parser's output (modulo edits to `autonomy`), this round-trip is stable.

**Implementation note**: When matching manifest phases to parsed phases, the matcher extracts the `P\d+` index from `manifestPhase.name` using the same regex used for body headings. If a manifest phase has a name without a `P\d+` prefix (hand-edited), it's matched only on display-name equality as a fallback — same as Q2/A semantics for that one phase. This handles legacy manifests gracefully without violating Q2/B for the common case.

**Alternatives rejected**:
- Add a `phases[*].id` field to `EpicManifestSchema` — schema change in the foundation package, breaks the isolation contract.
- Normalized name match (Q2/C) — rejected in Q2. Renames within normalization (e.g., adding emoji) would silently shadow the index.

## R7. Phase-level diff in `sync` — mirror semantics

**Decision**: `sync` computes a `ChangeSet` with four buckets:
- `phasesAdded` — phases in the body, not in the manifest. Inserted into `manifest.phases` in body order, with `tier` from the heading marker, `repos: []` (the foundation schema's `.default([])` handles it), `issues` populated from the body, no `autonomy`.
- `phasesRemoved` — phases in the manifest, not in the body. Removed entirely. Their `autonomy` entries are dropped along with the phase.
- `phasesRenamed` — phases matched by index where `body.name !== manifest.name`. Manifest's `name` overwritten with body's.
- `issuesAdded` / `issuesRemoved` (per matched phase) — set diff on `issues[]`, preserving existing order then appending added refs to the end of the phase's list.

**Rationale**:
- Q3/A is explicit: mirror semantics; body is source of truth at the phase level too. `autonomy` untouched only because it's epic-level configuration, not body-derivable.
- Computing the full ChangeSet first (then writing once) gives us atomic writes with no partial state and lets `--json` summarize counts.

**Alternatives rejected**:
- Issue-only diff with phase warnings (Q3/B) — rejected. Would diverge from `init`'s output over time and require manual `init --force` to reconcile.
- Strict mode (Q3/C) — rejected. Forces users to re-run `init` for trivial body edits and breaks CI idempotency (SC-003).

## R8. `--json` output shape — single line, structured

**Decision**: When `--json` is passed, the command's last stdout line is a single JSON object:

```json
{
  "verb": "init" | "sync",
  "path": ".generacy/epics/cockpit.yaml",
  "epic": "generacy-ai/tetrad-development#85",
  "wrote": true,
  "changes": {
    "phasesAdded": ["P4: Hardening"],
    "phasesRemoved": [],
    "phasesRenamed": [{"from": "P3 Manifest", "to": "P3 — Manifest"}],
    "issuesAdded": {"P3": ["generacy-ai/generacy#791"]},
    "issuesRemoved": {}
  }
}
```

For `init`, `changes.phasesAdded` lists every phase (all are new) and `phasesRemoved/Renamed` and `issuesRemoved` are empty. `wrote` is `true` unless `init` errored before the write.

For `sync`, `wrote` is `false` and `changes` are empty arrays/objects when there are no diffs (SC-003 idempotency check passes by inspecting `wrote === false`).

**Rationale**:
- FR-009: structured single-line JSON.
- Mirrors `state.ts` and other cockpit verbs' `--json` output style (one machine-readable line on stdout).
- The shape is direct: each top-level key answers one question a script integrating this verb would ask. Per-phase issue diffs are scoped under `issuesAdded[phaseId]` so a script can attribute changes back to a phase without re-parsing the body.

**Alternatives rejected**:
- Multi-line JSON Lines stream (one event per change) — heavier; the verb is one-shot, not a stream.
- `wrote: <bytes>` integer — gives no extra info; boolean is enough.

## R9. Manifest scoping for `sync` — `resolveManifestPath`

**Decision**: `sync` resolves the manifest path as:
1. `--epic <slug>` flag provided → `<manifestRoot>/<slug>.yaml` (errors if missing).
2. Otherwise → glob `<manifestRoot>/*.yaml`. If exactly one file matches, use it. If zero, exit non-zero with "no manifest found". If more than one, exit non-zero with "multiple manifests found, pass --epic <slug>".

`<manifestRoot>` defaults to `<cwd>/.generacy/epics`; opt-in `--manifest-root <dir>` for tests.

**Rationale**:
- US2 says "current directory (single-manifest case) or accepts an explicit `--epic <slug>`" — this is the literal implementation.
- US3 wants explicit failures, including "multiple manifests match" — that's the third branch.
- The foundation package's `resolveEpicIssues()` already uses the same `.generacy/epics/*.yaml` glob convention; we reuse the directory contract.

**Alternatives rejected**:
- Always require `--epic <slug>` — annoying in the single-epic workspace case.
- Walk up from cwd to find `.generacy/epics/` — overcomplicated; the current cwd is the right base for a CLI invocation. (Tests inject `--manifest-root`.)

## R10. Testing strategy — pure-function unit tests + Commander integration test

**Decision**: All five helpers (parse-epic-body, derive-slug, extract-plan, diff-phases, resolve-manifest-path) are pure-function modules with their own vitest files. `manifest.test.ts` then has a small set of integration tests that drive the full Commander command with a stubbed `CommandRunner` (using the `fake-gh.ts` pattern from sibling verbs).

**Rationale**:
- FR-010 enumerates five required test categories. Splitting them across small files keeps each pure-function test under 50 LOC.
- `fake-gh.ts` (already in `__tests__/`) returns a function that pattern-matches on argv and returns canned `{stdout, stderr, exitCode}` — exactly what we need to stub `gh issue view`.
- The fixture `epic-cockpit-body.md` doubles as the SC-002 golden test and as input to the parser unit tests.

**Alternatives rejected**:
- End-to-end tests against a live `gh` — slow, requires auth, flaky in CI.
- Snapshot tests for the YAML output — `writeManifest()` round-trips through `EpicManifestSchema.parse()` so the schema validation is the snapshot.

## Key Sources

- Spec: [spec.md](./spec.md)
- Clarifications: [clarifications.md](./clarifications.md) (Q1–Q5, all locked Batch 1, 2026-06-26)
- Foundation package:
  - `packages/cockpit/src/manifest/schema.ts` — `EpicManifestSchema` definition.
  - `packages/cockpit/src/manifest/io.ts` — `readManifest`, `writeManifest`, atomic write pattern.
  - `packages/cockpit/src/manifest/scoping.ts` — `.generacy/epics/*.yaml` glob convention.
  - `packages/cockpit/src/gh/wrapper.ts` — `GhCliWrapper`, `listIssues()`, `CommandRunner` injection.
- Sibling CLI verbs (patterns to mirror):
  - `packages/generacy/src/cli/commands/cockpit/state.ts` — `--json` style, `CockpitExit` error class, `CommandRunner` injection.
  - `packages/generacy/src/cli/commands/cockpit/advance.ts` — Commander subcommand structure.
  - `packages/generacy/src/cli/commands/cockpit/exit.ts` — `CockpitExit` carrier.
  - `packages/generacy/src/cli/commands/cockpit/gh-ext.ts` — `createCockpitGh(runner)` factory.
  - `packages/generacy/src/cli/commands/cockpit/__tests__/fake-gh.ts` — runner stub pattern.
- Epic ref:
  - [generacy-ai/tetrad-development#85](https://github.com/generacy-ai/tetrad-development/issues/85) (Epic Cockpit).
  - Unblocked sibling: #791 (`cockpit queue <phase>`, G3.2).
  - Blocking dependency (closed): #786 (`@generacy-ai/cockpit` foundation, G0.1).

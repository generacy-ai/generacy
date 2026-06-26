# Feature Specification: cockpit manifest init/sync verb

**Branch**: `790-epic-generacy-ai-tetrad` | **Date**: 2026-06-26 | **Status**: Draft
**Issue**: [generacy-ai/generacy#790](https://github.com/generacy-ai/generacy/issues/790)
**Epic**: [generacy-ai/tetrad-development#85](https://github.com/generacy-ai/tetrad-development/issues/85) (Epic Cockpit) | **Phase**: P3 | **Tier**: v2-pipeline | **Issue ID**: G3.1

## Summary

Add a `generacy cockpit manifest <init|sync>` CLI verb that creates and maintains the per-epic manifest YAML at `.generacy/epics/<slug>.yaml`.

- `init <epic-ref>` — generate a new manifest by reading the epic issue (labels + body) plus its referenced planning doc, producing the phase/issue structure consumed by every other cockpit verb.
- `sync` — reconcile an existing manifest against current GitHub state: pick up new child-issue numbers, prune closed/moved issues, and refresh per-phase issue references.

Owned source path (isolation contract): `packages/generacy/src/cli/commands/cockpit/manifest.ts`.

Built on the `@generacy-ai/cockpit` foundation package (#786, G0.1) — uses its existing `EpicManifestSchema`, `readManifest()`/`writeManifest()` IO, and `gh` wrapper. Unblocks `cockpit queue <phase>` (#791, G3.2) which assumes a populated manifest.

## Clarifications

Locked in via [clarifications.md](./clarifications.md) Batch 1 (2026-06-26):

- **Epic body grammar**: lenient — phase headings `##`/`###`/`####` with `P\d+` id and any separator before the name; bullets are `- [ ]`/`- [x]`/`-` `owner/repo#n` with optional ` — title`; prose between bullets skipped. (Q1 → B)
- **Phase identity for `sync`**: matched by `P\d+` index, not display name. Body's display name is written back in place when it changes. (Q2 → B)
- **Phase-level diff in `sync`**: mirror semantics — add phases new to the body (parsing `tier` from the `→ vN` marker), remove vanished phases; `autonomy` never touched. (Q3 → A)
- **`epic.plan` format**: bare repo-relative path (e.g. `docs/epic-cockpit-plan.md`); strip `in <repo>` and any trailing `(...)`. Missing `Plan:` line → non-zero exit with actionable error. (Q4 → A)
- **Slug collision flags on `init`**: `--force` overwrites the file at the derived `<slug>.yaml`; `--slug <s>` picks a different filename but still errors if `<s>.yaml` exists unless `--force` is also passed. (Q5 → A)

## User Stories

### US1: Bootstrap a new epic's manifest

**As an** epic owner using the cockpit,
**I want** to run `generacy cockpit manifest init generacy-ai/tetrad-development#85`,
**So that** I get a populated `.generacy/epics/epic-cockpit.yaml` describing every phase, every child issue, and the epic's planning doc — without hand-writing YAML.

**Acceptance Criteria**:
- [ ] Reads the epic issue from GitHub (title, body, labels) via the existing `gh` wrapper.
- [ ] Derives a slug for the epic from its title (kebab-case, deduplicated against existing files).
- [ ] Parses the epic body's "Children by phase" structure to populate `phases[]` with `name`, optional `tier`, and `issues[]` as `owner/repo#n` refs.
- [ ] Records the planning doc as `epic.plan`, persisting the bare repo-relative path (e.g. `docs/epic-cockpit-plan.md`) with any `in <repo>` and trailing `(...)` stripped (see FR-007). Errors when no `Plan:` line is present.
- [ ] Writes via `writeManifest()` (atomic tmp+rename) and exits 0 with the resulting path.
- [ ] Refuses to overwrite an existing manifest unless `--force` is passed.

### US2: Keep a running epic's manifest in sync

**As an** epic owner working through phases,
**I want** to run `generacy cockpit manifest sync`,
**So that** newly filed child issues, renumbered references, renamed phases, and added/removed phases are reflected in the manifest without me re-running `init`.

**Acceptance Criteria**:
- [ ] Resolves the manifest path from the current directory (single-manifest case) or accepts an explicit `--epic <slug>`.
- [ ] Re-reads the epic issue's checklist and per-phase issue references.
- [ ] Matches each parsed phase back to a manifest phase by its `P\d+` index (not display name). When the body's display name changes for the same index, updates the manifest's `name` in place.
- [ ] Adds new `owner/repo#n` entries to the right phase preserving existing order; removes refs that no longer appear in the epic body.
- [ ] Mirrors phase-level shape: adds phases the manifest doesn't have (parsing `tier` from the heading's `→ vN` marker, populating `issues[]`, leaving `autonomy` untouched) and removes phases that vanished from the body.
- [ ] Leaves `autonomy` and any unknown keys untouched at the epic level.
- [ ] Exits 0 with a summary of changes (e.g., `+2 -0` per phase, plus `+N -M` phases at the epic level) or "no changes" on a clean run.

### US3: Safe failure when state is ambiguous

**As an** epic owner running cockpit in CI or a scripted flow,
**I want** the command to fail loudly when its inputs are inconsistent (epic ref unknown, body unparseable, multiple manifests match),
**So that** I don't silently produce a corrupt manifest that misroutes later `queue`/`watch` verbs.

**Acceptance Criteria**:
- [ ] Non-zero exit + structured error on: missing epic ref, gh auth failure, malformed epic body, manifest already present without `--force` (init), or no matching manifest (sync).
- [ ] No partial writes — manifest IO already atomic; either the new file exists in full or the previous one is untouched.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | New subcommand `cockpit manifest init <epic-ref>` registered under the existing `cockpit` command group in `packages/generacy/src/cli/commands/cockpit/index.ts`. | P1 | `<epic-ref>` is `owner/repo#n`. |
| FR-002 | New subcommand `cockpit manifest sync` registered alongside `init`. | P1 | |
| FR-003 | All code owned by `cockpit/manifest.ts` (split into a helpers dir is fine; nothing outside `cockpit/manifest*` is modified beyond `index.ts` wire-up). | P1 | Isolation contract from issue. |
| FR-004 | Reuse `@generacy-ai/cockpit` for: manifest schema (`EpicManifestSchema`), IO (`readManifest`, `writeManifest`), and `gh` access (`packages/cockpit/src/gh/wrapper.ts`). | P1 | No duplicate manifest parsing/writing in the CLI package. |
| FR-005 | `init` parses the epic body's children-by-phase block under a lenient grammar: phase headings at `##`/`###`/`####` levels with id `P\d+` followed by any separator (`—`/`-`/`:`/whitespace) then a name; issue lines as bulleted `- [ ]`/`- [x]`/`-` `owner/repo#n` refs with an optional ` — title`; prose between bullets is silently skipped. Each phase's bullet list ends at the next heading. | P1 | Strict parsing would break on hand-edited epic bodies. |
| FR-006 | `init` derives `epic.slug` from the epic title (kebab-case, stripped of leading "Epic:"). On a slug collision: error unless `--force` (overwrite the existing file at the derived `<slug>.yaml`) or `--slug <s>` (use `<s>.yaml` instead) is provided. `--slug <s>` still errors when `<s>.yaml` exists unless `--force` is also passed. | P1 | Overwrite only when explicitly requested. |
| FR-007 | `init` records `epic.plan` from a recognizable `Plan: ...` line in the epic body. The bare repo-relative path is persisted (e.g. `docs/epic-cockpit-plan.md`); any trailing `in <repo>` qualifier and parenthesized suffix (e.g. `(P3 / G3.1)`) are stripped. Missing `Plan:` line → non-zero exit with an actionable "add a Plan: line to the epic body" error. | P1 | The plan lives in the epic's own repo; no cross-repo qualifier. |
| FR-008 | `sync` matches each parsed phase to a manifest phase by its `P\d+` index (not display name), updates the display `name` in place when it changes, mirrors phase-level shape (adds phases new to the body, removes phases that vanished from it, parsing `tier` from each heading's `→ vN` marker), and diffs `issues[]` within matched phases. Exits 0 with no write when nothing has changed. | P1 | Mirror semantics — body is source of truth. Idempotent in CI loops. |
| FR-009 | Both verbs emit a structured single-line JSON summary on stdout when `--json` is passed (path, phases modified, issues added/removed). | P2 | Mirrors other cockpit verbs. |
| FR-010 | Unit tests cover: body-parse happy path, body-parse with checkboxes, slug derivation + collision, sync add/remove diff, refusal to overwrite without `--force`. | P1 | Co-located in `packages/generacy/src/cli/commands/cockpit/__tests__/manifest.test.ts`. |
| FR-011 | gh interactions use the shared wrapper — no direct `child_process` calls in `manifest.ts`. | P1 | Keeps tests fakeable via `fake-gh.ts`. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `cockpit manifest init` against issue tetrad-development#85 produces a manifest that validates against `EpicManifestSchema`. | passes | Run command in a workspace, parse output with `readManifest()`. |
| SC-002 | Generated manifest's phase/issue structure matches the epic body. | exact match | `init` output diffed against a hand-verified fixture for #85. |
| SC-003 | `cockpit manifest sync` exits 0 with "no changes" when run twice in a row. | idempotent | Integration test. |
| SC-004 | All FRs covered by unit tests in `__tests__/manifest.test.ts`. | 100% | Vitest run. |
| SC-005 | `manifest.ts` (+ optional helpers under `cockpit/manifest/`) is the only non-test file added or modified, plus the one-line registration in `cockpit/index.ts`. | isolation contract held | `git diff --stat` on the branch. |

## Assumptions

- The epic issue body has a "Children by phase" section whose headings carry a `P\d+` phase id and whose bullets reference issues as `owner/repo#n`. The exact grammar is intentionally lenient (see FR-005) to tolerate hand-edited epic bodies.
- Phase identity is the `P\d+` index, not the display name. Renaming a phase in the body does not destroy its manifest entry; reordering or renumbering phases does (and is treated as remove+add).
- The `@generacy-ai/cockpit` foundation package is published/locally-linked into the generacy CLI — its manifest IO and gh wrapper are the only external deps needed. A reference manifest is committed at `.generacy/epics/epic-cockpit.yaml`.
- `gh` CLI is authenticated in the environment running the command; auth failure is surfaced as-is.
- `.generacy/epics/` is the canonical location for per-epic manifests (matches `manifest/io.ts` callers in #786).
- Single-repo manifest is sufficient for v1; cross-repo `phases[*].repos` (already in the schema) is populated from issue refs but not otherwise validated.

## Out of Scope

- Editing the `autonomy:` block (driven by `cockpit queue` and per-gate policy work in later issues).
- Cross-epic merge or rebase of manifests.
- A `cockpit manifest add-phase` / `remove-phase` editor — manual YAML edits remain supported.
- Wiring the verb into a slash command (`/cockpit:manifest`) — that lands later in the agency repo (P4).
- Migrating any existing manifest format (none exists yet).
- Auto-running `sync` on a timer or in `watch`'s poll loop.

## Dependencies

- **Blocking**: #786 (G0.1, `@generacy-ai/cockpit` foundation) — closed/merged. Provides manifest schema, IO, and gh wrapper.
- **Unblocks**: #791 (G3.2, `cockpit queue <phase>`) — depends on a populated manifest.

---

*Generated by speckit*

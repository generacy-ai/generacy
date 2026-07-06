# Feature Specification: Epic: generacy-ai/tetrad-development#85 | Phase: S2 | Tier: v1-simplification | Issue: G-S2

Replace the two-tier manifest+label-search discovery with one mechanism (plan rev 3, principle 1): an engine resolver that parses the epic issue body — owner/repo#N task-list refs ("- [ ]"/"- [x]") grouped under "### <phase>" headings — and fails loud with the expected format when nothing parses

**Branch**: `806-epic-generacy-ai-tetrad` | **Date**: 2026-07-06 | **Status**: Draft

## Summary

Epic: generacy-ai/tetrad-development#85 | Phase: S2 | Tier: v1-simplification | Issue: G-S2

Replace the two-tier manifest+label-search discovery with one mechanism (plan rev 3, principle 1): an engine resolver that parses the epic issue body — owner/repo#N task-list refs ("- [ ]"/"- [x]") grouped under "### <phase>" headings — and fails loud with the expected format when nothing parses. watch/status scope by --epic only (drop --repos; repos derive from the refs); the issue set is re-resolved every poll tick so children added mid-epic join automatically. queue becomes `queue <epic-ref> <phase>`, reading membership from the matching heading, with --label to override the default process:speckit-feature. Delete: the manifest read path and label-search fallback in manifest/scoping.ts (resolveEpicIssues), the manifest init/sync verbs and manifest/** subcommand files, `repos` from the config schema, and the MONITORED_REPOS coupling. Watch interval: default 30000ms, floor 15000ms.

Owns (isolation): packages/cockpit/src/manifest/** ; packages/generacy/src/cli/commands/cockpit/{watch*,status*,queue.ts,manifest*,shared/scoping.ts}

Acceptance: on a fresh project with only gh auth + a conformant epic body, watch/status/queue work with zero config; cross-repo children resolve (regression test for generacy#801); a body with no parseable refs errors loudly (regression for the tetrad-development#86 silent fallback); no YAML manifest is read anywhere.

Depends on: G-S1 (shared watch/status files) (see the epic checklist for issue numbers)

---
Part of the Epic Cockpit. Plan: docs/epic-cockpit-plan.md in tetrad-development (S2 / G-S2).


## User Stories

### US1: Zero-config epic discovery from the epic issue body

**As a** cockpit user running `watch`, `status`, or `queue` on a fresh project,
**I want** the cockpit to derive the set of child issues by parsing the epic issue body directly,
**So that** I don't have to author or sync a YAML manifest, and I don't have to configure `repos:` — cross-repo children resolve from the same source of truth the humans already edit.

**Acceptance Criteria**:
- [ ] With only `gh auth` and a conformant epic body, `cockpit watch --epic <ref>`, `cockpit status --epic <ref>`, and `cockpit queue <epic-ref> <phase>` all succeed with no other config.
- [ ] Child refs in a different `owner/repo` from the epic resolve correctly (regression: generacy#801).
- [ ] Children added to the epic body mid-watch are picked up on the next poll tick without restarting the process.

### US2: Loud failure when the epic body cannot be parsed

**As a** cockpit user pointed at an epic whose body has no parseable `owner/repo#N` task-list refs,
**I want** the command to error immediately with a message that shows the expected format,
**So that** I can fix the body instead of getting silently-empty output that looks like "nothing to do" (regression: tetrad-development#86).

**Acceptance Criteria**:
- [ ] A non-conformant epic body causes `watch`, `status`, and `queue` to exit non-zero with a message describing the required `### <phase>` heading + `- [ ] owner/repo#N` task-list ref format.
- [ ] The error path is exercised by a regression test.

### US3: Phase-scoped queue by heading

**As a** cockpit user who wants to enqueue only a subset of the epic's children,
**I want** `queue <epic-ref> <phase>` to read membership from the `### <phase>` heading in the epic body,
**So that** I can hand off a phase's worth of work in one command, with the default workflow label overridable via `--label`.

**Acceptance Criteria**:
- [ ] `cockpit queue <epic-ref> <phase>` enqueues exactly the refs under the matching `### <phase>` heading.
- [ ] Default label applied is `process:speckit-feature`; `--label` overrides it.
- [ ] A phase name that matches no heading errors loudly.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Engine resolver parses the epic issue body for `owner/repo#N` task-list refs (`- [ ]` / `- [x]`) grouped under `### <phase>` headings. | P1 | Single source of truth; replaces the manifest+label-search two-tier. |
| FR-002 | Resolver fails loud with the expected-format message when zero refs parse. | P1 | Regression against tetrad-development#86 silent fallback. |
| FR-003 | `watch` and `status` accept only `--epic`; `--repos` is removed. Repos are derived from the resolved refs. | P1 | Drop MONITORED_REPOS coupling. |
| FR-004 | The child issue set is re-resolved on every `watch`/`status` poll tick. | P1 | Enables mid-epic additions to join automatically. |
| FR-005 | `queue` command signature becomes `queue <epic-ref> <phase>`; membership comes from the matching heading. | P1 | Replaces prior queue verb shape. |
| FR-006 | `queue` accepts `--label` to override the default `process:speckit-feature`. | P1 | |
| FR-007 | Default watch interval is 30000 ms; enforced floor is 15000 ms. | P2 | Overrides below the floor are clamped or rejected. |
| FR-008 | Delete: `manifest/scoping.ts::resolveEpicIssues` manifest read path + label-search fallback; manifest `init`/`sync` verbs and `manifest/**` subcommand files; `repos` from the config schema; `MONITORED_REPOS` coupling. | P1 | Deletion is part of acceptance; no YAML manifest is read anywhere. |
| FR-009 | Cross-repo child refs (`owner/repo#N` where `owner/repo` differs from the epic's repo) resolve correctly end-to-end. | P1 | Regression: generacy#801. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Config required for a fresh project to run `watch`/`status`/`queue` | Zero (only `gh auth` + a conformant epic body) | Manual walkthrough on a clean checkout with no `.cockpit`/manifest files. |
| SC-002 | References to YAML manifest read paths in the shipped code | 0 | `grep` across `packages/cockpit/src/` and `packages/generacy/src/cli/commands/cockpit/` post-deletion. |
| SC-003 | Cross-repo epic-child regression (generacy#801) | Passes | Automated test resolving a child ref whose repo differs from the epic's. |
| SC-004 | Silent-fallback regression (tetrad-development#86) | Passes | Automated test asserting non-zero exit + expected-format message when body has no parseable refs. |
| SC-005 | Mid-epic child pickup latency | ≤ 1 watch poll interval (default 30 s) | Automated test adds a ref to the epic body between ticks and asserts it appears on the next tick. |

## Assumptions

- The epic issue body is edited by humans (or another agent) as the canonical membership list — this feature does not write back to the body.
- `gh auth` is present and has permission to read the epic issue and any linked `owner/repo` children.
- Heading style is `### <phase>` (three hashes). Alternative heading levels are out of scope for parsing.
- Task-list refs use GitHub's standard `- [ ]` / `- [x]` syntax; nested lists are not required to be supported in v1.
- G-S1 (spec 805) has landed, so shared `watch`/`status` files are already in place.

## Out of Scope

- Writing back to the epic body (e.g., auto-checking `- [x]` when a child closes).
- Any YAML manifest format — the manifest subsystem is being deleted, not migrated.
- Non-`### <phase>` heading levels, alternative task-list markers, or non-`owner/repo#N` ref shapes.
- Restoring or preserving the `--repos` flag or `MONITORED_REPOS` env coupling.
- Orchestrator client, journal liveness, or stuck/recovered event handling (owned by G-S1 / spec 805).

---

*Generated by speckit*

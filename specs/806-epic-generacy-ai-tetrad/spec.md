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

### US1: Zero-config epic discovery from the issue body

**As an** operator running the epic cockpit on a fresh project,
**I want** `watch`, `status`, and `queue` to derive the child-issue set directly from the epic issue body — with no manifest file, no `repos` config, and no label-search fallback,
**So that** the only setup required is `gh auth` and a conformant epic body.

**Acceptance Criteria**:
- [ ] On a fresh project with only `gh auth` and a conformant epic body, `watch`, `status`, and `queue` succeed with zero config.
- [ ] Cross-repo children (refs like `owner/repo#N` under a phase heading) resolve to the correct repo (regression test for generacy#801).
- [ ] An epic body with no parseable refs errors loudly with the expected format (regression for the tetrad-development#86 silent fallback).
- [ ] No YAML manifest is read anywhere in the watch/status/queue paths.

### US2: Mid-epic children join watch automatically

**As an** operator running `watch --epic <ref>`,
**I want** the resolver to re-parse the epic body every poll tick,
**So that** child refs added mid-run join the watched set without restarting the process.

**Acceptance Criteria**:
- [ ] Refs appended to the epic body between poll ticks appear in the next tick's resolved set.
- [ ] Refs removed from the body drop out of the resolved set on the next tick.
- [ ] Default poll interval is 30000 ms; floor is 15000 ms.

### US3: Queue by phase heading

**As an** operator running `queue <epic-ref> <phase>`,
**I want** membership to be read from the matching `### <phase>` heading in the body, with `--label` overriding the default `process:speckit-feature`,
**So that** enqueuing a phase's cohort of children requires no external manifest.

**Acceptance Criteria**:
- [ ] `queue <epic-ref> <phase>` enqueues every ref listed under the matching heading (per FR-005 match rule).
- [ ] `--label` overrides the default `process:speckit-feature` label.
- [ ] Ineligible refs (closed / already-labeled) are skipped at preview time.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Engine resolver parses the epic issue body: task-list refs (`- [ ]` and `- [x]`) grouped under `### <phase>` headings. Both checked and unchecked items are included in the resolved set for `watch`, `status`, and `queue`; downstream commands decide eligibility (issue state/labels are the authoritative done-signal, not the checkbox). | P1 | Clarified by Q1 → A. |
| FR-002 | Accepted ref shapes: bare `owner/repo#N`, markdown-linked variants (`[owner/repo#N](...)`, `[#N](https://github.com/owner/repo/issues/N)`), and plain issue URLs (`https://github.com/owner/repo/issues/N`) — all normalized to the same `owner/repo#N` key. Same-repo `#N` shorthand is NOT accepted. | P1 | Clarified by Q3 → B. Cross-repo epics make bare `#N` ambiguous (wrong-repo bug class from #801). |
| FR-003 | Unresolved ref-shaped task-list lines (e.g., bare `#N` shorthand) emit a loud stderr warning naming the line, so silent drops (rev-3 failure mode) cannot occur. | P1 | Follow-up: doc alignment filed as generacy-ai/tetrad-development#90. |
| FR-004 | When the same `owner/repo#N` appears under multiple `### <phase>` headings, the resolver de-duplicates globally: `watch`/`status` see one entry; `queue <phase>` enqueues the ref if it is listed under the requested phase. Duplicates within a single heading collapse to one. | P1 | Clarified by Q2 → A. Fail-loud is reserved for unparseable bodies, not defensible authoring choices. |
| FR-005 | `<phase>` argument in `queue <epic-ref> <phase>` matches a heading via case-insensitive first-token match (whitespace/punctuation-delimited) — e.g., `s2` matches `### S2 — single-source discovery`. Ambiguous matches (>1 heading matches the token) error loudly and list the candidate headings. | P1 | Clarified by Q5 → C. |
| FR-006 | Empty or unparseable epic body (no `### <phase>` headings, or no task-list refs under any heading) errors loudly with the expected format. No silent fallback. | P1 | Regression coverage for tetrad-development#86. |
| FR-007 | Watch poll interval: default 30000 ms, floor 15000 ms. A `--interval` value below the floor warns to stderr, clamps to 15000 ms, and continues. | P1 | Clarified by Q4 → B. stdout is reserved for the NDJSON event stream. |
| FR-008 | `watch --epic <ref>` re-resolves the epic body every poll tick; refs added mid-epic join automatically, refs removed drop out. Repos derive from the refs — the `--repos` flag is removed. | P1 | |
| FR-009 | Delete: `packages/cockpit/src/manifest/**`, `manifest/scoping.ts:resolveEpicIssues` (manifest read path + label-search fallback), manifest `init`/`sync` verbs and subcommand files, `repos` field from the config schema, and the `MONITORED_REPOS` env coupling. | P1 | Isolation boundary — no other packages are touched. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Zero-config bring-up | `watch`, `status`, `queue` succeed on a fresh project with only `gh auth` and a conformant epic body | E2E test on a scratch repo — no `.generacy/`, no manifest file, no `repos` config. |
| SC-002 | Cross-repo resolution | Refs like `owner/repo#N` under a phase heading resolve to the correct repo | Regression test covering generacy#801. |
| SC-003 | Loud failure on unparseable body | Body with no parseable refs exits non-zero with a message naming the expected format | Regression test covering tetrad-development#86. |
| SC-004 | Mid-epic join | Ref appended to epic body between ticks appears in next tick's resolved set within `interval` ms | Watch-loop test with mocked GitHub body updates. |
| SC-005 | No manifest reads | No code path under `packages/cockpit/src/manifest/**` or `resolveEpicIssues` is reachable from `watch`/`status`/`queue` | Static check — files deleted; grep in `packages/cockpit/**` and `packages/generacy/src/cli/commands/cockpit/**` returns zero hits. |
| SC-006 | Interval floor enforcement | `--interval` below 15000 ms emits a stderr warning and continues at 15000 ms; stdout NDJSON stream unaffected | CLI test asserting stderr warning + effective interval. |

## Assumptions

- The epic body is authored by a human and may include markdown links, plain URLs, or bare `owner/repo#N` refs — all three normalize to the same key (FR-002).
- The `- [x]` checkbox is human-maintained and unreliable as a done-signal; issue state/labels are authoritative (Q1 rationale).
- `stdout` is reserved for the NDJSON event stream in `watch`; all diagnostics and warnings go to `stderr` (Q4 rationale).
- G-S1 (shared watch/status files) has landed and provides the file layout this change plugs into.

## Out of Scope

- Same-repo `#N` shorthand support (excluded — see FR-002 / Q3 rationale).
- Doc alignment for the label-protocol contract — filed as generacy-ai/tetrad-development#90.
- Any changes outside `packages/cockpit/src/manifest/**` and `packages/generacy/src/cli/commands/cockpit/{watch*,status*,queue.ts,manifest*,shared/scoping.ts}`.
- Reintroducing manifest, label-search, or `repos` config as a fallback path.

---

*Generated by speckit*

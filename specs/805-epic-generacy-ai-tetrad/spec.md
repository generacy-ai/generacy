# Feature Specification: Delete Cockpit Dark Subsystems (Orchestrator Client, Journal Liveness, Dead Exports)

**Branch**: `805-epic-generacy-ai-tetrad` | **Date**: 2026-07-02 | **Status**: Draft
**Source**: [generacy-ai/generacy#805](https://github.com/generacy-ai/generacy/issues/805) | Epic: tetrad-development#85 | Phase: S1 | Tier: v1-simplification | Issue: G-S1

## Summary

Cockpit rev 2 shipped several subsystems "dark" — code that exists, is exported, and is partially wired into `status`/`watch`, but delivers no working end-to-end value (plan rev 3, Findings). This feature deletes them:

1. **Orchestrator API client** — `packages/cockpit/src/orchestrator/**` (client, http, stub) and its CLI consumers: `watch/orchestrator-counts.ts`, `shared/orchestrator-footer.ts`, and the orchestrator token/warn helpers (`shared/orchestrator-token.ts`, `shared/orchestrator-warn.ts`).
2. **Journal liveness** — `packages/cockpit/src/journal.ts` (`readJournalLiveness`) plus its call sites in `status.ts` and `watch/poll-loop.ts`.
3. **Confirmed-dead exports** — `appendChildIssue` in `packages/cockpit/src/manifest/io.ts` (exported, never called); `health`/`isAvailable` go with the client.
4. **Event-model drift** — drop `stuck`/`recovered` from the watch event model. The producer (`watch/diff.ts`) emits these events, but `CockpitEventSchema` (`watch/emit.ts` — note: located in the CLI package, not `packages/cockpit` as the issue text states) never included them, so emission would fail schema validation at runtime. Removing the producer side fixes the drift.
5. **Config schema cleanup** — remove `orchestrator.*` (`baseUrl`, `token`) and `stuckThresholdMinutes` from the cockpit config schema and loader.

User-visible effect: `cockpit status` loses the orchestrator footer line; `cockpit watch` loses the orchestrator counts line and never emits `stuck`/`recovered` events. Everything else is behavior-preserving deletion.

## User Stories

### US1: Maintainer removes dead weight before v1

**As a** cockpit maintainer,
**I want** the dark subsystems (orchestrator client, journal liveness, dead exports) deleted in one isolated change,
**So that** subsequent S-chain simplification work builds on a codebase that only contains functioning, load-bearing code.

**Acceptance Criteria**:
- [ ] `packages/cockpit/src/orchestrator/` directory no longer exists; `createOrchestratorClient`, `OrchestratorClient`, `HealthResult`, `JobsResult`, `WorkersResult`, `JobSummary`, `UnavailableReason` are no longer exported from `packages/cockpit/src/index.ts`.
- [ ] `packages/cockpit/src/journal.ts` no longer exists; `readJournalLiveness` is not exported.
- [ ] `appendChildIssue` is removed from `packages/cockpit/src/manifest/io.ts` and the package's public exports.
- [ ] No source file outside git history references the removed modules or exports (spot-check via grep for `createOrchestratorClient`, `readJournalLiveness`, `appendChildIssue`, `orchestrator-footer`, `orchestrator-counts`, `resolveOrchestratorToken`, `createFirstFailureWarner`, `stuckThresholdMinutes`).
- [ ] Tests covering the deleted subsystems are deleted with them (`orchestrator-client.test.ts`, `journal.test.ts`, and CLI tests: `orchestrator-token.test.ts`, `orchestrator-warn.test.ts`, `status.footer.test.ts`, `status.token-precedence.test.ts`, `watch.orchestrator-counts.test.ts`, `watch.orchestrator-failure.test.ts`); `manifest-io.test.ts` and `config-loader.test.ts` are trimmed, not deleted.

### US2: Cockpit user gets clean, honest output

**As a** cockpit CLI user,
**I want** `status` and `watch` to only show data the tool can actually produce,
**So that** I'm not misled by orchestrator footers/counts backed by a stub client or stuck-detection that never validated.

**Acceptance Criteria**:
- [ ] `cockpit status` runs successfully and its output contains no orchestrator footer line.
- [ ] `cockpit watch` runs successfully and its output contains no orchestrator counts line.
- [ ] `cockpit watch` event stream can never contain `stuck` or `recovered` events; the event discriminator in `watch/diff.ts` and `CockpitEventSchema` in `watch/emit.ts` agree on the same 5-event set (`label-change`, `issue-closed`, `pr-merged`, `pr-closed`, `pr-checks`).

### US3: Operator's config stays valid

**As a** cockpit operator with an existing config file,
**I want** a defined behavior for now-removed config keys (`orchestrator.*`, `stuckThresholdMinutes`),
**So that** upgrading doesn't break my setup.

**Acceptance Criteria**:
- [ ] The cockpit config schema no longer defines `orchestrator.baseUrl`, `orchestrator.token`, or `stuckThresholdMinutes`.
- [ ] A config file that still contains these keys does not cause `status`/`watch` to fail (unknown keys are ignored or stripped per the schema's existing unknown-key policy).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Delete `packages/cockpit/src/orchestrator/` (client.ts, http.ts, stub.ts) and remove all its re-exports from `packages/cockpit/src/index.ts` | P1 | `health`/`isAvailable` are methods on the client — removed with it |
| FR-002 | Delete `packages/cockpit/src/journal.ts` and its exports | P1 | |
| FR-003 | Remove `appendChildIssue` from `packages/cockpit/src/manifest/io.ts` and public exports | P1 | Confirmed dead: exported, zero callers |
| FR-004 | Delete CLI orchestrator consumers: `watch/orchestrator-counts.ts`, `shared/orchestrator-footer.ts`, `shared/orchestrator-token.ts`, `shared/orchestrator-warn.ts` | P1 | Under `packages/generacy/src/cli/commands/cockpit/` |
| FR-005 | Remove journal-liveness call sites from `status.ts` and `watch/poll-loop.ts`; both commands must still run end-to-end | P1 | Call-site cleanup only in the CLI package |
| FR-006 | Remove `stuck`/`recovered` from the watch event model: `CockpitEventDiscriminator` and emission logic in `watch/diff.ts`; verify `CockpitEventSchema` in `watch/emit.ts` matches the producer exactly | P1 | Schema already lacks stuck/recovered — fix is producer-side; corrects issue text's path (`watch/emit.ts` is in the CLI package) |
| FR-007 | Remove `orchestrator.*` and `stuckThresholdMinutes` from `packages/cockpit/src/config/schema.ts` and any handling in `config/loader.ts` | P1 | |
| FR-008 | Remove the orchestrator footer line from `status` output and the orchestrator counts line from `watch` output, including any rendering hooks in `status/render-table.ts` | P1 | |
| FR-009 | Delete or trim tests for removed code; remaining `status`/`watch` tests pass against the reduced output | P1 | See US1 AC for the file list |
| FR-010 | Update `packages/cockpit/README.md` to drop documentation of removed exports/config | P2 | README currently documents the orchestrator client |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | References to removed subsystems in source | 0 outside git history and prior-feature spec archives | Grep for the identifiers listed in US1 AC across `packages/` |
| SC-002 | `cockpit status` and `cockpit watch` functionality | Both run and their test suites pass with reduced output | `pnpm test` for `packages/cockpit` and `packages/generacy` cockpit tests |
| SC-003 | CI build health | Typecheck step green (lint not gating per issue) | CI on the PR |
| SC-004 | Producer/schema agreement | `watch/diff.ts` discriminator and `CockpitEventSchema` define the identical event set | Code inspection / type-level check in tests |

## Assumptions

- Verified (2026-07-02): no package outside `packages/cockpit` and `packages/generacy/src/cli/commands/cockpit` imports any of the removed modules/exports — the deletion is isolated to the "Owns" boundary in the issue.
- Prior-feature spec archives (`specs/786-*`, `specs/787-*`, `specs/792-*`, `specs/793-*`) mention these subsystems; they are historical records and are NOT edited. The acceptance criterion "no reference remains outside git history" applies to source code and living docs (README), not archived specs.
- The issue text's `packages/cockpit/src/watch/emit.ts` path is incorrect; `CockpitEventSchema` lives at `packages/generacy/src/cli/commands/cockpit/watch/emit.ts`. Scope is unchanged — the file is inside the issue's "Owns" boundary for the CLI package.
- The cockpit config schema's existing unknown-key policy determines behavior for stale `orchestrator.*`/`stuckThresholdMinutes` keys in user configs; no migration tooling is needed for v1.

## Out of Scope

- Any change to the orchestrator *package* (`packages/orchestrator`) or other packages with "orchestrator" in the name — only the cockpit's orchestrator API *client* is deleted.
- Rebuilding orchestrator status or stuck-detection on a sounder foundation (later S-chain/epic work).
- Editing prior-feature spec archives under `specs/`.
- Lint-rule cleanup beyond what typecheck requires (acceptance gates on typecheck, not lint).
- Changes to `manifest/io.ts` beyond removing `appendChildIssue`.

---

*Generated by speckit*

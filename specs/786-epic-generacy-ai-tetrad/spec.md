# Feature Specification: @generacy-ai/cockpit engine foundation package

**Branch**: `786-epic-generacy-ai-tetrad` | **Date**: 2026-06-25 | **Status**: Draft
**Epic**: generacy-ai/tetrad-development#85 | **Phase**: P0 | **Tier**: v1-foundation | **Issue ID**: G0.1

## Summary

Create the `@generacy-ai/cockpit` package — the foundation library that powers the Epic Cockpit. It provides everything a higher-layer UI or service needs to observe and reason about epic-scoped workflow progress *without* taking a dependency on any orchestrator runtime. Concretely it ships:

1. A new pnpm workspace package built with `tsc` and tested with `vitest`.
2. A config loader for a new `cockpit:` block in `.generacy/config.yaml`, layered onto `@generacy-ai/config`.
3. Shared TypeScript types and a canonical `CockpitState` enum that names every workflow state the cockpit can report (including error and terminal states).
4. A label → state **classifier** that consumes a `Set<string>` of label names and returns the single most-specific `CockpitState`. The classifier imports `WORKFLOW_LABELS` from `@generacy-ai/workflow-engine` so the cockpit and the runtime cannot drift.
5. **Epic manifest** read/write helpers plus a scoping resolver that, given an epic, returns the full set of child issue numbers. Resolution order: manifest first, then the `epic-child`/`epic-parent` label graph as fallback.
6. A thin `gh` CLI integration layer for listing issues, mutating labels, and reading PR check runs.
7. An **orchestrator API client** built on the existing `NativeHttpClient` pattern (zero new HTTP deps). It must degrade gracefully when no API token is configured — the rest of the cockpit must remain usable in read-only mode.

This package owns `packages/cockpit/**` exclusively, plus the schema for the `cockpit:` block in `.generacy/config.yaml`. Nothing else in the repo is modified beyond what is required to register the new package in the workspace and (minimally) extend the config schema.

This is the foundation issue for the Epic Cockpit epic — every other G0.x issue depends on this package existing.

---

## User Stories

### US1: Cockpit consumer reads epic progress from a label set

**As a** developer integrating the Epic Cockpit (UI, CLI, or service),
**I want** to pass a set of issue labels into a pure classifier and get back a single canonical `CockpitState`,
**So that** I can render progress consistently without re-implementing label semantics or duplicating the workflow-engine's label catalog.

**Acceptance Criteria**:
- [ ] `classify(labels: Iterable<string>): { state: CockpitState; sourceLabel: string }` is exported from `@generacy-ai/cockpit` (returns a struct, not a bare enum — the watcher needs the originating label to route gate-specific actions like `waiting-for:clarification` → `/cockpit:clarify` vs `waiting-for:implementation-review` → `/cockpit:review`).
- [ ] `CockpitState` is a small curated enum: `pending | active | waiting | error | terminal | unknown`.
- [ ] Every entry in `WORKFLOW_LABELS` (including error states like `agent:error` and terminal states like `closed`/`done`) maps to a non-`unknown` `state` with a populated `sourceLabel`.
- [ ] When multiple workflow labels co-exist on an issue, the classifier applies the **authoritative** precedence rule `terminal > error > waiting > active > pending` (curated tier). Tie-breaks within a tier: within `waiting`, surface the earliest unsatisfied gate in pipeline order `spec-review → clarification → plan-review → tasks-review → implementation-review → manual-validation`; within any other tier, break ties by index in `WORKFLOW_LABELS`. `sourceLabel` reports the winning label.
- [ ] Classifier is unit-tested with one case per state plus precedence and tie-break edge cases.

### US2: Cockpit consumer resolves an epic's child issue set

**As a** developer building epic-progress views,
**I want** to ask the cockpit "what issues belong to epic #N?" and get a deterministic list,
**So that** I can aggregate state across the epic without writing my own GitHub queries or manifest parsers.

**Acceptance Criteria**:
- [ ] `resolveEpicIssues(epic: number, owner, repo): Promise<number[]>` is exported.
- [ ] Manifest location is canonical: `.generacy/epics/<slug>.yaml` in the epic's primary (epic-parent's) repo. The manifest is a **repo path** (a file), not the issue body.
- [ ] Resolver first scans `.generacy/epics/*.yaml`, matches `epic.issue == N`; the manifest's Zod-validated shape (owned by this package) is `epic: { repo, issue, slug, plan }`, `autonomy: {}`, `phases: [{ name, tier?, repos: [...], issues: ["owner/repo#n", ...] }]`. Reference manifest: `.generacy/epics/epic-cockpit.yaml` in tetrad-development.
- [ ] If no manifest matches, the resolver falls back to querying `gh` for issues labeled `epic-child` referencing the epic, plus issues whose body references the epic-parent.
- [ ] Manifest write helper supports appending a child issue without rewriting unrelated entries.
- [ ] Both resolution paths are unit-tested with fixtures (no live `gh` calls).

### US3: Cockpit configures itself from project conventions

**As a** developer adopting the cockpit in an existing repo,
**I want** the package to read its config from a `cockpit:` block in `.generacy/config.yaml` and fall back to sensible defaults,
**So that** I don't need to wire up every parameter explicitly to get a working cockpit.

**Acceptance Criteria**:
- [ ] `loadCockpitConfig()` reads `.generacy/config.yaml` via `@generacy-ai/config`'s loader.
- [ ] When `cockpit:` block is absent or partial, defaults are filled in: owner derived from `gh auth status`, repo list defaulted to the `MONITORED_REPOS` env var (comma-separated). Entries in `MONITORED_REPOS` are `owner/repo` strings.
- [ ] When both `cockpit.repos` and `MONITORED_REPOS` are unset, `loadCockpitConfig()` resolves with `repos: []` and emits a warn-level log (read-only mode still loads; commands needing repos error at use-time). Distinct from malformed config (bad YAML/types), which still throws with a useful message.
- [ ] Config schema is exported as a Zod schema so consumers can validate or extend it.
- [ ] Loader is unit-tested with: full config, partial config, missing config (warn + empty repos), and invalid config (must error with a useful message).

### US4: Cockpit talks to the orchestrator when authenticated, degrades when not

**As a** cockpit consumer running locally without an orchestrator API token,
**I want** the package to still expose every feature that does not require the orchestrator (classifier, scoping, `gh` reads),
**So that** I can use the cockpit offline or in CI without provisioning a token.

**Acceptance Criteria**:
- [ ] `createOrchestratorClient(config)` returns a client with the v1 surface: `isAvailable(): boolean`, `health()`, `getJobs()`, `getWorkers()`. (Real method coverage expands in G5.1 — orchestrator status tier.)
- [ ] When no API token is present, the factory returns a stub whose `health` / `getJobs` / `getWorkers` return typed `{ available: false }` results (never throw) and `isAvailable()` → `false`.
- [ ] All other exports of the package work identically with or without the orchestrator client being live.

---

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Create `packages/cockpit/` as a TypeScript ESM pnpm workspace package (`@generacy-ai/cockpit`), Node >=22, `tsc` build, `vitest` test. | P1 | Mirror conventions of `@generacy-ai/credhelper` for layout. |
| FR-002 | Export a curated `CockpitState` enum/string-literal union: `pending | active | waiting | error | terminal | unknown`. | P1 | Curated abstraction, not 1:1 with labels — the `sourceLabel` field on `classify()` output carries the originating `WORKFLOW_LABELS` entry. Naming must be stable. |
| FR-003 | Export `classify(labels: Iterable<string>): { state: CockpitState; sourceLabel: string }` that imports `WORKFLOW_LABELS` from `@generacy-ai/workflow-engine` (no copy/paste of label data). | P1 | Pure function, no I/O. Returns a struct so the watcher can route gate-specific actions. |
| FR-004 | Implement the **authoritative** precedence rule `terminal > error > waiting > active > pending` (curated tier). Tie-breaks within a tier: within `waiting`, surface the earliest unsatisfied gate in pipeline order `spec-review → clarification → plan-review → tasks-review → implementation-review → manual-validation`; within any other tier, break ties by index in `WORKFLOW_LABELS`. | P1 | Normative, not suggested. `sourceLabel` reports the winning label. |
| FR-005 | Add a `cockpit:` block to `.generacy/config.yaml`'s schema (via `@generacy-ai/config`) and load it through a typed loader. `MONITORED_REPOS` entries are `owner/repo` strings. When both `cockpit.repos` and `MONITORED_REPOS` are unset, return `repos: []` with a warn-level log (absent config — graceful). Malformed config still throws. | P1 | Zod-validated. Defaults pulled from `gh auth status` and `MONITORED_REPOS`. |
| FR-006 | Implement epic manifest read/write helpers. Canonical on-disk path: `.generacy/epics/<slug>.yaml` in the epic-parent's repo. Zod-validated shape owned by this package: `epic: { repo, issue, slug, plan }`, `autonomy: {}`, `phases: [{ name, tier?, repos: [...], issues: ["owner/repo#n", ...] }]`. | P1 | Atomic writes. Idempotent. Reference: `.generacy/epics/epic-cockpit.yaml` in tetrad-development. |
| FR-007 | Implement `resolveEpicIssues(epic, owner, repo)` with manifest-first, label-fallback resolution: scan `.generacy/epics/*.yaml`, match `epic.issue == N`; fall back to `epic-child` / `epic-parent` label graph. | P1 | Manifest is a known repo path (file), not the issue body. |
| FR-008 | Provide a thin wrapper over the `gh` CLI for: list issues by query, add/remove labels on an issue, read PR check-run summaries. | P1 | No new HTTP deps — `gh` is the authenticated transport. |
| FR-009 | Implement an orchestrator API client using the existing `NativeHttpClient` pattern (e.g. `packages/activation-client`). v1 method surface: `isAvailable()`, `health()`, `getJobs()`, `getWorkers()`. | P1 | No `node-fetch`/`undici` adds. Exact endpoint mapping is a plan-phase detail. |
| FR-010 | Orchestrator client must degrade gracefully when no API token is configured: factory returns a stub whose `health` / `getJobs` / `getWorkers` return typed `{ available: false }` results (never throw); `isAvailable()` → `false`. | P1 | No throw at construction. Real coverage expands in G5.1. |
| FR-011 | Ship unit tests for: classifier (every state + precedence), config loader (4 scenarios in US3), epic manifest read/write, both branches of `resolveEpicIssues`, orchestrator client degraded mode. | P1 | Vitest. No live network. |
| FR-012 | Export a single public API surface from `packages/cockpit/src/index.ts`. Internal modules stay internal. | P2 | |
| FR-013 | Document the package's public API and the `cockpit:` config block in a `README.md` inside the package. | P2 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Classifier coverage of `WORKFLOW_LABELS` states. | 100% of entries in `WORKFLOW_LABELS` map to a `(state, sourceLabel)` pair with non-`unknown` state and populated `sourceLabel`. | Static check in a unit test that iterates `WORKFLOW_LABELS` and asserts every label produces a non-`unknown` state + populated `sourceLabel`. |
| SC-002 | Classifier behavior is unit-tested. | One test per state + precedence cases all green. | `pnpm --filter @generacy-ai/cockpit test` passes. |
| SC-003 | Config loader produces working defaults on a clean machine. | Given an empty `.generacy/config.yaml`, `loadCockpitConfig()` resolves with `owner` from `gh auth status` and `repos` from `MONITORED_REPOS`. | Unit test with mocked `gh` + env. |
| SC-004 | Epic-scoping resolves both ways. | Given a manifest, resolver returns manifest contents; given no manifest, resolver returns labeled issues. | Unit tests for both branches. |
| SC-005 | Orchestrator-less mode works. | Importing and using every non-orchestrator export succeeds when `ORCHESTRATOR_API_TOKEN` is unset. | Integration-style unit test. |
| SC-006 | Package builds, lints, and tests in CI. | `pnpm build && pnpm test` green in the package directory. | CI. |
| SC-007 | Isolation respected. | Only `packages/cockpit/**` and the `cockpit:` block of the config schema are modified by this issue. | `git diff --name-only` review at PR time. |

## Assumptions

- `@generacy-ai/workflow-engine` already exports `WORKFLOW_LABELS` and `LabelDefinition` (verified — `packages/workflow-engine/src/index.ts:93`).
- `@generacy-ai/config` already exposes a loader for `.generacy/config.yaml` that the cockpit can extend with its `cockpit:` block.
- The `gh` CLI is installed and authenticated in the environments where the cockpit runs (this is consistent with the rest of the repo's tooling).
- The orchestrator HTTP API surface needed by cockpit consumers is either already defined or will be specified by a sibling G0.x issue — for this foundation issue the client only needs the *shape* and the degraded-mode behavior, not full method coverage.
- The epic manifest's canonical on-disk location is `.generacy/epics/<slug>.yaml` in the epic-parent's repo; the Zod-validated schema is owned by this package (see FR-006). The reference manifest is committed at `.generacy/epics/epic-cockpit.yaml` in `tetrad-development`.

## Out of Scope

- Any cockpit **UI** (CLI dashboard, web view, etc.) — those are downstream issues.
- Long-running pollers, schedulers, or daemons — the package exposes pure helpers; *callers* decide the polling cadence.
- Real-time updates (SSE/WebSocket) from the orchestrator — only HTTP polling is in scope here.
- Modifying the workflow-engine's label catalog itself — this package only *consumes* `WORKFLOW_LABELS`.
- Multi-repo or multi-org scoping beyond what `MONITORED_REPOS` + `cockpit:` config provides.
- Writing new GitHub Actions or workflow files.
- Persistence beyond the epic manifest read/write (no database, no cache layer).

## Splittability

The issue notes this is the largest in the epic and can be split into three sub-issues at the cost of one extra phase:

1. **Scaffold + state** — package scaffolding, types, `CockpitState`, classifier.
2. **Manifest** — epic manifest read/write + `resolveEpicIssues` scoping.
3. **gh + orchestrator client** — `gh` wrapper + degraded-mode orchestrator client.

**Decision (clarification Q5 follow-up note)**: land this as a **single PR** — the three parts are small and tightly coupled; splitting adds a phase and integration friction for little gain.

---

*Generated by speckit*

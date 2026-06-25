# Clarifications

Issue: [#786](https://github.com/generacy-ai/generacy/issues/786) — `[cockpit] @generacy-ai/cockpit engine foundation package`

---

## Batch 1 — 2026-06-25

### Q1: CockpitState granularity
**Context**: FR-002 says the enum must cover "every state in `WORKFLOW_LABELS` plus explicit `error`, `terminal`, and `unknown` buckets." `WORKFLOW_LABELS` contains 40+ entries across `phase:*`, `waiting-for:*`, `completed:*`, `failed:*`, `agent:*`, and others. Whether `CockpitState` is one-value-per-label or a curated higher-level abstraction completely changes the public API surface, downstream rendering, and how the precedence rule is expressed.
**Question**: What granularity should `CockpitState` have?
**Options**:
- A: One value per `WORKFLOW_LABELS` entry (~40+ values; enum mirrors labels 1:1; classifier returns the label-equivalent state).
- B: A small curated abstraction (~8–12 values such as `pending`, `active`, `waiting`, `error`, `terminal`, `unknown`); classifier maps many labels into one state.
- C: Two-tier: a curated top-level state plus an optional `subState: string` carrying the source label, so consumers can drill in without re-deriving.

**Answer**: *Pending*

### Q2: Precedence rule authority
**Context**: FR-004 calls the precedence rule "Suggested", but the US1 acceptance criterion states it as a documented rule (`terminal > error > waiting > active > pending`). The classifier is pure and unit-tested per FR-004 / SC-002, so this ordering becomes part of the public contract. We need to know whether implementers can refine it or must implement it verbatim.
**Question**: How authoritative is `terminal > error > waiting > active > pending`?
**Options**:
- A: Authoritative — implement exactly as stated; downstream issues can extend later.
- B: Authoritative top-level, but specify tie-breaking within a tier (e.g. when two `waiting-for:*` labels co-exist) — implementer chooses a sub-rule and documents it.
- C: Suggested only — implementer is free to propose a different ordering in the plan phase.

**Answer**: *Pending*

### Q3: Epic manifest on-disk location and shape
**Context**: FR-006 requires manifest read/write helpers and FR-007 requires manifest-first resolution. The Assumptions section defers the "exact on-disk location and schema" to `docs/epic-cockpit-plan.md` in the `tetrad-development` repo. But the package's tests, types, and fallback behavior depend on a concrete shape. Without a decision, FR-006 / SC-004 cannot be implemented or verified.
**Question**: How should the manifest location and shape be resolved for this foundation issue?
**Options**:
- A: Lock in a canonical path now — e.g. `.generacy/cockpit/epics/{epicNumber}.yaml` with a Zod-validated schema defined in this package.
- B: Make the path configurable via the `cockpit:` block (default `.generacy/cockpit/epics/{epicNumber}.yaml`), but the schema is still owned and Zod-validated here.
- C: Defer the manifest helpers — implement only the label-graph fallback now; ship the manifest helpers in a follow-up once `tetrad-development` resolves the shape.

**Answer**: *Pending*

### Q4: `MONITORED_REPOS` format and unset behavior
**Context**: US3 / FR-005 says the repo list defaults to the `MONITORED_REPOS` env var (comma-separated). The spec does not state whether entries are `owner/repo` or bare `repo`, nor what the loader does when both the `cockpit:` block and `MONITORED_REPOS` are absent. This directly affects `loadCockpitConfig` semantics and unit-test fixtures called out in US3 AC.
**Question**: What is the exact contract for `MONITORED_REPOS` and the absent-config case?
**Options**:
- A: Entries are `owner/repo` strings; if both `cockpit.repos` and `MONITORED_REPOS` are unset, loader returns an empty `repos: []` with a warn-level log (read-only mode still works).
- B: Entries are bare repo names; the cockpit `owner` is derived from `gh auth status` and prepended; if both are unset, loader throws a config-validation error.
- C: Entries are `owner/repo`; if both are unset, loader throws a config-validation error (fail-loud, no implicit default).

**Answer**: *Pending*

### Q5: Orchestrator client v1 method surface
**Context**: FR-009 / US4 require an orchestrator client built on `NativeHttpClient`, with degraded-mode behavior when no token is configured. Assumptions explicitly say this issue only needs "the shape and degraded-mode behavior, not full method coverage." The US4 AC names `getJobs` and `getWorkers` as examples. We need to know what counts as "done" so the test surface (SC-005) is unambiguous.
**Question**: What is the v1 minimum method surface for the orchestrator client?
**Options**:
- A: Only `getJobs()` and `getWorkers()` (the US4 examples) — both return typed "unavailable" results in degraded mode; everything else is follow-up.
- B: A small read-only surface — `health()`, `getJobs()`, `getWorkers()` — plus the `isAvailable()` predicate.
- C: An empty/minimal client interface (just `isAvailable()` and one representative stub method) — the surface is filled in by sibling G0.x issues that actually need each method.

**Answer**: *Pending*

---

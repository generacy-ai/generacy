# Research: Per-workflow orchestrator overrides

## Decision 1 — Top-level shape: sibling map vs. fold into `agents.workflows`

**Decision**: New sibling map `orchestrator.workflows.<name>` (clarification Q1 → A).

**Rationale**: `AgentsConfigSchema` (`template-schema.ts:69`) is a shipped, `.strict()`,
agent-specific schema — `workflows.<name>` there holds `{ default, phases }` agent
selectors (#1095). The new fields (`validateCommand`, `preValidateCommand`,
`maxRemediations`, `review`) are not agent selectors. Folding them in (option B) would blur
two concerns, force `WorkflowAgentEntriesSchema` to grow non-agent keys, and rework a strict
shipped schema plus every existing agents fixture. A sibling map keeps `AgentsConfigSchema`
untouched; both maps key on the same workflow-name space and compose cleanly.

**Alternatives considered**: B (fold into `agents.workflows.<name>`) — rejected as above.

## Decision 2 — Tiering for `review` / `maxRemediations`

**Decision**: No repo-level tier. `review`/`maxRemediations` resolve workflow-level >
built-in default (two tiers). Only `validateCommand`/`preValidateCommand` keep the
three-tier chain workflow > repo > cluster (Q2 → A).

**Rationale**: The spec defines `review` and `maxRemediations` **only** under
`WorkflowOverride` (FR-001, FR-003) — there is no `orchestrator.review` /
`orchestrator.maxRemediations` repo-level sibling today, and the design sketch shows them
only under `workflows.<name>`. Adding a repo tier (option B) adds schema surface, an extra
precedence tier, and fixtures the design never calls for. Keeping the two-tier chain for
the new fields matches the design intent and keeps the resolver simple.

## Decision 3 — Built-in defaults live in resolve logic, not schema `.default()`

**Decision**: `maxRemediations` and `review.*` defaults are applied inside
`resolveWorkflowOverrides`, not via Zod `.default()` on the schema (Q3 → A; FR-002, FR-010).

**Rationale**: A Zod `.default()` would materialize the value at parse time, erasing the
distinction between "absent" and an explicit value. FR-002 requires an absent
`maxRemediations` to be distinguishable from an explicit `0`. Applying defaults at resolve
time keeps the parsed config faithful to the YAML and matches the established pattern in
`resolveAgentForPhase` (where `DEFAULT_PROVIDER` is a resolve-time fallback, not a schema
default) and `PhaseTimeoutOverridesSchema`'s deliberate per-field optionality.

**Constants**:
- `DEFAULT_REVIEW = { profile: 'standard', blockingSeverity: 'critical', failThenPass: false }`.
  `blockingSeverity: 'critical'` is the conservative baseline (feature config sets `major`
  as an explicit override); `profile: 'standard'` is the general profile vs bugfix-specific
  `verification`; `failThenPass` is opt-in.
- `maxRemediations`: `speckit-bugfix` → 2, everything else (incl. `speckit-feature` and
  unknown names) → 3.

## Decision 4 — `??` preserves explicit falsy values

**Decision**: Use nullish coalescing (`??`) for every field walk.

**Rationale**: The only "explicit but falsy" values in play are `preValidateCommand: ""`,
`maxRemediations: 0`, and `review.failThenPass: false`. None are nullish, so `??` returns
them rather than falling through:
- `"" ?? clusterDefault === ""` — preserves the repo-level "skip install" semantics
  (US1 AC-3, SC-003).
- `0 ?? 3 === 0` — explicit zero budget survives (FR-002).
- `false ?? true === false` — explicit opt-out survives.

Using `||` here would be a bug (it treats `""`/`0`/`false` as absent). This mirrors the
`!== undefined` guards already used in `applyRepoValidateOverrides` (`config.ts:132,138,141`).

## Decision 5 — No loader change (FR-005)

**Decision**: Leave `tryLoadOrchestratorSettings` untouched.

**Rationale**: It already calls `OrchestratorSettingsSchema.parse(doc['orchestrator'])`
(`loader.ts:65`). Once the schema carries the `workflows` field, the parse path returns the
extended block with zero loader edits. FR-005 ("loader parses and returns the new block
unchanged") is satisfied by the schema change alone.

## Decision 6 — Resolver ships without a consumer (FR-007 / FR-011, Q4 → A)

**Decision**: Add `resolveWorkflowOverrides` and its return type, but do not extend
`WorkerContext` or call the resolver from `claude-cli-worker.ts`.

**Rationale**: The review/remediate phases that consume `maxRemediations`/`review` are out
of scope (epic #1120). Adding those fields to `WorkerContext` now creates dead fields no
code reads. The resolver is a pure function exercised by unit tests (so not dead code) and
is ready for the consuming phase to import — the same lifecycle `AgentsConfigSchema` /
`resolveAgentForPhase` followed before their consumers landed. The consuming phase will call
it mirroring `resolveAgentForPhase` usage (`phase-loop.ts:528`).

## Implementation patterns referenced

- `applyRepoValidateOverrides` (`config.ts:126`) — reference-equality "no override" fast
  path and `!== undefined` field guards; preserved unchanged (SC-005).
- `resolveAgentForPhase` (`config.ts:283`) — independent per-field tier walks with a
  resolve-time built-in fallback; the new resolver mirrors this structure.
- `AgentsConfigSchema` / `WorkflowAgentEntriesSchema` (`template-schema.ts:36,69`) —
  `z.record(z.string(), …)` for extensible workflow names + `.strict()` value schema.

## Key sources

- `packages/config/src/template-schema.ts` — schema home.
- `packages/config/src/loader.ts` — parse path (unchanged).
- `packages/orchestrator/src/worker/config.ts` — resolver home.
- `packages/orchestrator/src/worker/claude-cli-worker.ts:486-500` — future plumb-through site.
- Clarifications Q1–Q4 (`clarifications.md`).

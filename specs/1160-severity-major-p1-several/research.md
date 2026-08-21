# Research: Per-workflow/agent config keys parse but do not apply

Four config keys shipped by the review/remediate epic (#1120) parse cleanly (or
are documented) but are ignored at runtime. This document records the technology
decisions behind wiring each to its call site, the alternatives considered, and
the exact code seams the plan builds on. All line references are against develop
as read this session.

## Decision 1 — `validateCommand`: seed the effective command from the resolver

**Decision**: At `phase-loop.ts:696`, change the seed
`let effectiveValidateCommand = config.validateCommand;` to read
`resolveWorkflowOverrides(config, settings, workflowName).validateCommand`.

**Rationale**: `resolveWorkflowOverrides` (config.ts:63) already resolves the
per-workflow precedence chain (`wf?.validateCommand ?? settings?.validateCommand
?? config.validateCommand`). The only defect is that the non-bugfix seed reads
the raw cluster value, dropping the workflow/repo tiers. Seeding from the
resolved value fixes FR-001 for every workflow in one line.

**FR-002 is preserved by construction**: the `speckit-bugfix` targeted-validate
path (`resolveTargetedValidate`, phase-loop.ts:1815) *already* calls
`resolveWorkflowOverrides(config, settings, workflowName).validateCommand`
(phase-loop.ts:1821-1825) and *overwrites* `effectiveValidateCommand` with the
narrowed command. So the targeted narrowing continues to apply on top of the
resolved command — no change needed on the bugfix branch.

**Alternatives considered**:
- *Resolve inside `resolveTargetedValidate` only*: rejected — leaves the
  non-bugfix (`speckit-feature`) path still reading raw config, which is the
  headline defect (US1).
- *Resolve at the spawn call site*: rejected — `effectiveValidateCommand` is
  read by multiple branches; seeding once at declaration is the smallest correct
  surface and keeps the bugfix overwrite intact.

## Decision 2 — `preValidateCommand`: read the resolved value, keep the truthiness skip

**Decision**: At `phase-loop.ts:662`, replace the raw `config.preValidateCommand`
read with `resolveWorkflowOverrides(config, settings, workflowName).preValidateCommand`.

**Rationale**: The install step is already guarded by `if (cmd)` truthiness, and
the resolver uses `??` (first non-nullish wins). So an explicit `""` at any tier
survives resolution and then correctly *skips* install via the existing
truthiness guard (FR-004), while `undefined`/`null` falls through to the cluster
default (FR-003). Distinguishing empty (skip) from unset (fall back) needs **no
new branch** — the `??` semantics plus the existing `if (cmd)` cover both.

**Alternatives considered**:
- *Add an explicit `=== ''` sentinel check*: rejected — redundant. `??`
  preserves `""` and `if (cmd)` already treats `""` as skip.
- *Resolve once and pass down through the call chain*: rejected — the install
  site is the only consumer; resolving inline at the read is minimal.

## Decision 3 — `phases.review`/`phases.remediate` agent: field-by-field helper

**Decision**: Add a pure helper `resolveReviewLikeAgent(config, workflowName,
phase)` (config.ts) that prefers the `phases.<phase>` tier **field by field** and
falls back to the full `implement` resolution for any field the phase tier omits.
Call it from `review-executor.ts` (`phase: 'review'`) and `remediate-executor.ts`
(`phase: 'remediate'`), replacing the `'implement'` literal.

**Rationale**: `resolveAgentForPhase(config, w, 'review')` walks only
`phases.review → workflowEntry.default → config.agents.default → defaultsAgent →
DEFAULT_PROVIDER` (config.ts:409-415). It **never consults `phases.implement`**.
So calling it directly would change today's behavior: whenever `phases.review` is
unset, the executor would stop inheriting the implement-tier model/provider that
it uses today. The clarified intent (Q1=A) is "resolve review, **fall back to
implement**." Field-by-field fallback delivers exactly that: an operator setting
only `phases.review.model` keeps implement's provider and effort.

Shape (mirrors `resolveAgentForPhase`'s field-independent resolution):
```ts
export function resolveReviewLikeAgent(
  config: WorkerConfig,
  workflowName: string,
  phase: 'review' | 'remediate',
): { provider: string; model?: string; effort?: Effort } {
  const base = resolveAgentForPhase(config, workflowName, 'implement');
  const tier = config.agents?.workflows?.[workflowName]?.phases?.[phase];
  const provider = tier?.provider ?? base.provider;
  const model = tier?.model ?? base.model;
  const effort = tier?.effort ?? base.effort;
  // reassemble with the same optional-field discipline as resolveAgentForPhase
}
```

**Remediate never inherits `phases.review` (Q3=A)**: because the fallback for a
missing `phases.remediate` field is the `implement` resolution (never the
`review` tier), an operator's deliberately cheaper `phases.review` model cannot
silently downgrade the code-writing remediate phase.

**Alternatives considered**:
- *Call `resolveAgentForPhase(config, w, 'review')` directly*: rejected — ignores
  `phases.implement`, changing today's behavior when `phases.review` is unset
  (a silent regression, the opposite of the fix intent).
- *Add a synthetic `implement` tier below `phases.<phase>` inside
  `resolveAgentForPhase`*: rejected — would entangle the generic per-phase
  resolver with review-specific fallback semantics and affect every caller.
- *Reject `phases.review`/`phases.remediate` at parse time*: rejected by
  clarification Q1=A (implement, do not reject). Schema already enumerates them.

## Decision 4 — `ciWaitTimeoutMs`: mirror `maxRemediations` (no repo tier)

**Decision**: Add optional `ciWaitTimeoutMs: z.number().int().min(30_000).optional()`
to the `.strict()` `WorkflowOverrideSchema` (template-schema.ts). Add
`ciWaitTimeoutMs: number` to `ResolvedWorkflowConfig` and resolve it in
`resolveWorkflowOverrides` as `wf?.ciWaitTimeoutMs ?? config.ciWaitTimeoutMs`.
Wire the resolved value into the CI-wait call site at phase-loop.ts:1333.

**Rationale**: The migration guide documents `ciWaitTimeoutMs` as a per-workflow
key, but `WorkflowOverrideSchema` is `.strict()` without it — so the documented
YAML **fails to parse** today. Adding the optional field is what makes the
documented YAML valid (Q2=A). It has no repo tier, exactly like `maxRemediations`
(`wf?.maxRemediations ?? defaultMaxRemediations(w)`): the base value comes from
`config.ciWaitTimeoutMs`, which the cluster env `WORKER_CI_WAIT_TIMEOUT_MS`
already feeds (loader.ts:264-269). The stale "Per-workflow-overridable" comment
at config.ts:155 becomes accurate once this lands.

**`.min(30_000)` mirrors the `WorkerConfigSchema` bound** at config.ts:157 so the
override cannot set a shorter floor than the cluster-level field allows.

**Alternatives considered**:
- *Add a repo tier (`settings.ciWaitTimeoutMs`)*: rejected — `maxRemediations`
  (the schema sibling the spec names) has no repo tier; adding one for
  `ciWaitTimeoutMs` alone would be an inconsistent surface with no documented
  demand.
- *Keep it cluster-env-only and remove the stale comment / fix the docs*:
  rejected by clarification Q2=A (add the key, make the YAML parse).

## Cross-cutting: precedence semantics via `??`

Every resolved field uses `??` (first non-nullish wins), so explicit `""` / `0`
/ `false` at a higher tier survives and only `undefined`/`null` falls through.
This is the existing convention (`resolveWorkflowOverrides` docstring,
config.ts:52-54) and is load-bearing for FR-004 (empty-string
`preValidateCommand` = skip, not fall back).

## Test strategy (FR-008)

Each key gets a round-trip test proving it reaches its runtime call site for the
workflow it names. Vitest, existing suites under
`packages/orchestrator/src/worker/__tests__/` and `packages/config/src/__tests__/`.
- `validateCommand` / `preValidateCommand`: assert the resolved command reaches
  the spawn / install call for a `speckit-feature` job (and empty-string skip).
- `resolveReviewLikeAgent`: unit matrix — phase-tier win per field + implement
  fallback per field; remediate never inherits `phases.review`.
- `ciWaitTimeoutMs`: schema accepts it (unknown key still rejected by `.strict()`),
  resolver precedence, and the resolved value reaches the CI-wait call.

## No new dependencies

No new packages. `WorkflowOverride` gains one additive optional field (a widened
public type in `@generacy-ai/config`); everything else is internal call-site
wiring in `@generacy-ai/orchestrator`.

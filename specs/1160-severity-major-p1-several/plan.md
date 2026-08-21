# Implementation Plan: Per-workflow/agent config keys parse but do not apply

**Feature**: Wire four silently-dropped config keys (`validateCommand`, `preValidateCommand`, `phases.review`/`phases.remediate` agent selection, `ciWaitTimeoutMs`) to their runtime call sites so each either changes behavior or is rejected at parse time.
**Branch**: `1160-severity-major-p1-several`
**Status**: Complete

## Summary

Four config keys shipped by the review/remediate epic (#1120) parse cleanly (or are documented as usable) but are ignored at runtime. This plan wires each to its call site per the clarified decisions (all "implement/accept", no schema rejections):

1. **`validateCommand`** — the non-bugfix validate path reads `config.validateCommand` raw (`phase-loop.ts:696`). Fix: seed `effectiveValidateCommand` from `resolveWorkflowOverrides(...).validateCommand`. The `speckit-bugfix` targeted-validate path (`resolveTargetedValidate`, `phase-loop.ts:1821`) already resolves per-workflow and overwrites `effectiveValidateCommand`, so FR-002 is preserved by construction.
2. **`preValidateCommand`** — the install step reads `config.preValidateCommand` raw (`phase-loop.ts:662`). Fix: read `resolveWorkflowOverrides(...).preValidateCommand`. The existing truthiness guard (`if (cmd)`) already makes empty-string skip; `??` in the resolver already preserves empty-string vs unset.
3. **`phases.review`/`phases.remediate` agent** — both executors pass the `'implement'` literal to `resolveAgentForPhase` (`review-executor.ts:126`, `remediate-executor.ts:98`). Fix: new pure helper `resolveReviewLikeAgent(config, workflow, phase)` — prefer the `phases.<phase>` tier field-by-field, fall back to the full `implement` resolution for any field the phase tier omits. No schema change (`phases.review`/`phases.remediate` already enumerated).
4. **`ciWaitTimeoutMs`** — documented per-workflow but absent from `.strict()` `WorkflowOverrideSchema`, so the documented YAML fails parse. Fix: add the optional field to `WorkflowOverrideSchema`, add it to `ResolvedWorkflowConfig` + `resolveWorkflowOverrides` (mirroring `maxRemediations`), and wire the resolved value into the CI-wait call site (`phase-loop.ts:1333`).

Each key gets a round-trip test proving it reaches its runtime call site for the workflow it names (FR-008).

## Technical Context

- **Language/runtime**: TypeScript (ESM), Node >=22.
- **Packages touched**: `@generacy-ai/orchestrator` (call-site wiring + resolver), `@generacy-ai/config` (`WorkflowOverrideSchema`).
- **Validation**: Zod. `WorkflowOverrideSchema` is `.strict()` — adding `ciWaitTimeoutMs` is what makes the documented YAML parse.
- **No new dependencies. No new public exports crossing a package boundary** except the widened `WorkflowOverride` type (additive optional field).
- **Test runner**: Vitest, existing suites under `packages/orchestrator/src/worker/__tests__/` and `packages/config/src/__tests__/`.

## Project Structure

```
packages/config/src/
  template-schema.ts                 # MOD: + ciWaitTimeoutMs on WorkflowOverrideSchema; refresh comments
  __tests__/template-schema.test.ts  # MOD: assert ciWaitTimeoutMs accepted; unknown key still rejected

packages/orchestrator/src/worker/
  config.ts                          # MOD: ResolvedWorkflowConfig.ciWaitTimeoutMs; resolve it;
                                     #      new resolveReviewLikeAgent(); de-stale config.ts:155 comment
  phase-loop.ts                      # MOD: line 662 preValidate resolved; line 696 validate resolved;
                                     #      line 1333 ciWaitTimeoutMs resolved per-workflow
  review-executor.ts                 # MOD: resolveReviewLikeAgent(config, wf, 'review')
  remediate-executor.ts              # MOD: resolveReviewLikeAgent(config, wf, 'remediate')
  __tests__/
    config.resolve-workflow-overrides.test.ts   # MOD/NEW: ciWaitTimeoutMs precedence
    config.resolve-review-like-agent.test.ts     # NEW: phase-tier win + implement fallback matrix
    phase-loop.validate-command.test.ts          # NEW: SC-001 per-workflow validateCommand reaches spawn
    phase-loop.prevalidate-command.test.ts       # NEW: SC-002 resolved install + empty-string skip
    phase-loop.ci-wait-timeout.test.ts           # NEW/MOD: SC-004 resolved ciWaitTimeoutMs at wait call

.changeset/1160-config-keys-apply.md             # NEW
```

## Constitution Check

No `.specify/memory/constitution.md` in the repo → constitution check skipped.

## Key Design Decisions

- **FR-001/FR-002 (one-line seed)**: `resolveTargetedValidate` already resolves per-workflow and its `effectiveCommand` overwrites `effectiveValidateCommand` for bugfix. So the only defect is the non-bugfix seed at `phase-loop.ts:696`. Change the seed to the resolved value; the bugfix branch is untouched, keeping targeted narrowing on top of the resolved command.
- **FR-003/FR-004 (resolver read + existing truthiness)**: `resolveWorkflowOverrides(...).preValidateCommand` uses `??`, so an explicit `""` survives to the call site, where `if (config.preValidateCommand)` (changed to the resolved value) already skips on empty. Distinguishing empty (skip) from unset (fallback) needs no new branch.
- **FR-005 (field-by-field fallback, not coarse switch)**: `resolveAgentForPhase('review')` walks only `phases.review → workflowEntry.default → agents.default` — it never consults `phases.implement`, so calling it directly would change today's behavior (implement agent) whenever `phases.review` is unset. New `resolveReviewLikeAgent` prefers `phases.<phase>` field-by-field and falls back to the full `implement` resolution per field, so an operator setting only `phases.review.model` keeps implement's provider/effort. Remediate never inherits `phases.review` (Q3=A) — it resolves `phases.remediate` over implement.
- **FR-006 (mirror `maxRemediations`)**: `ciWaitTimeoutMs` becomes `wf?.ciWaitTimeoutMs ?? config.ciWaitTimeoutMs` (no repo tier, matching `maxRemediations`). Cluster env `WORKER_CI_WAIT_TIMEOUT_MS` still feeds `config.ciWaitTimeoutMs` as the base. The stale "Per-workflow-overridable" comment at `config.ts:155` becomes accurate.

## Next Step

`/speckit:tasks` to generate the dependency-ordered task list.

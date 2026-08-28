# Implementation Plan: P3 Integration — Gateway-Enabled Local & Cloud Clusters Run the Mixed-Route Dogfood

**Feature**: Validate gateway model routing end-to-end on published cluster templates (local scaffold + cloud deploy), reconcile the gateway compose stanza across all four template sources, and record P3 as complete.
**Branch**: `1204-context-integration-issue`
**Status**: Complete

## Summary

This is a **validation and reconciliation** issue, not a feature build (Clarification Q1).
The implement phase produces documents, not services:

1. **`runbook.md`** — a step-by-step operator procedure covering: prerequisite gate
   (upstream contracts merged), local cluster scaffold with `--llm-gateway`, cloud staging
   deploy with `llmGatewayEnabled=true`, one fresh disposable speckit-bugfix dogfood issue
   per cluster (Q2), log-evidence collection, the four-way stanza diff, and the
   `cockpit auto` mixed-route observation (US4, validation-only per Q4).
2. **`results.md`** — the findings/results report template, filled in by the operator as
   runs complete: per-cluster outcomes against the route-discrimination criteria (Q5),
   the four-way diff report with each divergence classified *intentional / fixed here /
   filed against owning repo*, and links to every filed issue.
3. **Optional small diff helper** — a committed script that extracts and diffs the
   `llm-gateway` stanza from the four sources (Q1 allows "a trivial committed helper").
4. **Code changes only if** a divergence is traced to this repo's scaffolder — then fixed
   in `packages/generacy/src/cli/commands/cluster/scaffolder.ts` with a changeset.

### Blocking prerequisite (verified 2026-08-28)

All four upstream contracts are **still open**:

| Contract | Issue | State |
|----------|-------|-------|
| Scaffolder `--llm-gateway` flag | generacy-ai/generacy#1202 | OPEN |
| cluster-base `setup-claude-gateway-config.sh` | generacy-ai/cluster-base#90 | OPEN |
| cloud-deploy `llmGatewayEnabled` mirror | generacy-ai/generacy-cloud#919 | OPEN |
| cockpit auto route rule (P4, referenced only) | generacy-ai/agency#510 | OPEN |

The spec's assumption holds: this issue **blocks on** missing contracts rather than
re-implementing them. The runbook therefore opens with a hard prerequisite gate (verify
#1202, #90, #919 merged and published) and the tasks phase must not schedule execution
steps before that gate passes. Writing the runbook, results template, criteria contract,
and diff helper is **not** blocked — only executing the runs is.

## Technical Context

- **Language/format**: Markdown artifacts under `specs/1204-context-integration-issue/`;
  optional POSIX-shell (or small TS) diff helper. No new runtime packages.
- **Validation workload**: the #1203 mixed-route speckit-bugfix recipe — one fresh
  disposable issue per cluster run, with the mixed-route `orchestrator.agents` block
  committed and pushed on the *target repo's* working branch (per-repo overrides load from
  the target checkout, `claude-cli-worker.ts:751` → `tryLoadOrchestratorSettings`).
- **Gateway model selection constraint** (Q2): filter candidate gateway models by
  `context_length` first — 32k-context models (featherless Qwen3-Coder variants) pass
  smoke tests but cannot open `phase-loop.ts` (~35k tokens). Require ≥128k context.
- **Route semantics** (P1, merged): model strings containing `/` → gateway route (second
  `CLAUDE_CONFIG_DIR`); all others (`claude-opus`, …) → subscription route.
- **Log validation** (Q5): criteria-based, no log-artifact baseline. Per cluster:
  gateway-route models appear in the Bifrost access log, subscription-route models are
  absent from it, zero gateway error lines. #1203's recorded metrics are qualitative
  reference only (Bifrost `logs.db` retains 7 days; no durable artifact exists).
- **Reconciliation canon** (Q3): tetrad dev compose
  `.devcontainer/generacy/docker-compose.yml:180-218` (in
  `/workspaces/tetrad-development`). Divergence is presumptively a port bug; deliberate
  adaptations (token generation, env plumbing) are recorded as intentional, not "fixed".
  Canonical traits: Bifrost image pinned `v2.0.0`, `sk-bf-` token prefix, named
  `llm-gateway-data:/app/data` volume, **no** `source_of_truth`, `list_models: false`,
  tracked token-free `config.json` mounted `:ro`, `.env.local` optional env_file,
  wget healthcheck with 45s start_period, cluster network only (no host port).
- **Four diff sources**:
  1. Scaffolder output — `packages/generacy/src/cli/commands/cluster/scaffolder.ts`
     emitted compose (post-#1202)
  2. Tetrad dev compose (canon) — `tetrad-development/.devcontainer/generacy/docker-compose.yml`
  3. cluster-base compose — `generacy-ai/cluster-base` (post-#90)
  4. cloud-deploy compose template — `generacy-ai/generacy-cloud` (post-#919)
- **US4 / cockpit auto** (Q4): validation-only. Record observed behavior of today's
  `auto.md` playbook (passes configured models straight to Agent spawns, no route
  awareness at `auto.md:262`) against a mixed `cockpit.auto.agents` block; append repro
  to agency#510, or file fresh if the failure differs from #510's prediction.
- **FR-007**: design-doc status flip to "P3 complete" happens in
  `tetrad-development/docs/llm-gateway-model-routing-plan.md` — a cross-repo edit,
  scripted as a runbook closeout step for the operator.

## Project Structure

```
specs/1204-context-integration-issue/
├── spec.md                  # existing (read-only)
├── clarifications.md        # existing
├── plan.md                  # this file
├── research.md              # decisions + rationale
├── data-model.md            # document/report schemas
├── quickstart.md            # how to use the runbook
├── stack.md                 # tech summary (overwritten by /plan)
├── contracts/
│   └── route-discrimination-criteria.md   # pass/fail contract for FR-002/SC-003
├── runbook.md               # ← implement phase: operator procedure
├── results.md               # ← implement phase: results report (template, then filled)
└── scripts/
    └── diff-gateway-stanza.sh             # ← implement phase: optional four-way diff helper
```

Only if a scaffolder divergence is found and traced here:

```
packages/generacy/src/cli/commands/cluster/scaffolder.ts   # targeted fix
.changeset/<slug>.md                                       # required (patch)
```

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo — no constitution gates apply.
Repo-level standing constraints honored instead:

- Changeset gate: markdown/spec-only changes touch no `packages/*/src/` file → no
  changeset needed; a scaffolder fix would require one (`patch` — defect fix).
- Scaffolder compose must keep mirroring the cluster-base devcontainer compose
  (CLAUDE.md package map) — the four-way reconciliation *is* the enforcement of this.
- Spec-stage commits exclude repo-root agent-context files; this plan touches none.

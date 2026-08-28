# Research: P3 Integration — Mixed-Route Dogfood on Published Templates

## Decision log

### D1: Deliverable is a runbook + results report, not automation (Q1)

**Decision**: Implement phase commits `runbook.md`, `results.md` (template → filled),
and at most a trivial stanza-diff helper. The operator executes the runs.

**Rationale**: Every FR is a *run* the in-repo worker cannot perform — scaffolding needs
published packages plus the cluster-base image; the cloud leg needs a staging VM with
`.env.local` provider keys; a worker container cannot bring up a sibling docker-compose
cluster. P3's phasing principle is "port a proven implementation instead of iterating".

**Alternatives rejected**:
- *Automation-first scripts* — throwaway orchestration machinery contrary to
  port-don't-invent; the scripts would only ever run once.
- *Agent-executed local leg* — overstates what the worker container can reach.

### D2: Fresh disposable speckit-bugfix issue per cluster run (Q2)

**Decision**: One new disposable issue for the local run, one for the cloud run,
following #1203's issue template (its body + results comment — there is no standalone
recipe document).

**Rationale**: #1203 ran against #1211, which is consumed. Re-running against it would
reset real issue history and collide with the one-active-cluster-per-repo constraint
while the tetrad cluster still monitors generacy. The mixed-route `orchestrator.agents`
block must be committed on the *target repo's* working branch (per-repo overrides load
from the target checkout — `claude-cli-worker.ts:751` → `tryLoadOrchestratorSettings`),
which is safe on a disposable target and pollution on generacy `develop`.

**Gateway model selection**: filter by `context_length` **first**. Featherless
Qwen3-Coder variants cap at 32,768 tokens; `phase-loop.ts` alone is ~35k. A 32k model
passes smoke tests, then fails to open real files mid-run. Require ≥128k context.

### D3: Tetrad dev compose is canon for the four-way reconciliation (Q3)

**Decision**: All templates converge to
`tetrad-development/.devcontainer/generacy/docker-compose.yml:180-218`. A divergence is
presumptively a port bug; deliberate adaptations are *recorded as intentional* in the
diff report, not fixed.

**Rationale**: The stanza encodes hard-won behaviors discovered during P2 dogfooding:
- `maximhq/bifrost:v2.0.0` pinned — config schema moves between majors.
- Named `llm-gateway-data:/app/data` volume — Bifrost needs a writable APP_DIR and the
  named volume inherits uid 1000 / gid 0; a host bind would not.
- **No** `source_of_truth: config.json` — v2.0.0 crash-loops ("FOREIGN KEY constraint
  failed") whenever the virtual key's env ref is unresolved, i.e. any cluster that
  hasn't set the token yet.
- Tracked token-free `config.json` mounted `:ro` — holds only `env.<VAR>` references,
  merged into config.db on every boot; removals do not propagate (split reconciliation).
- `.env.local` (`required: false`) carries provider keys + `GENERACY_LLM_GATEWAY_TOKEN`
  (`sk-bf-` prefix); the committed `.env` carries no gateway secrets.
- wget healthcheck with `start_period: 45s` (migrations + model-catalog sync ~10s).
- Cluster network only, no host port (management UI shares 8080).

The scaffolder becomes the forward source of truth only *after* this reconciliation
makes it a faithful superset.

**Alternatives rejected**: scaffolder-as-canon (premature — not yet validated);
case-by-case adjudication (reintroduces the drift the plan doc calls a known hazard).

### D4: US4 is validation-only; fixes belong to agency#510 (Q4)

**Decision**: Record the observed behavior of today's `cockpit auto` playbook against a
mixed `cockpit.auto.agents` block; append repro details to agency#510 (or file fresh if
the failure differs). No cockpit code changes in this branch.

**Rationale**: The fix is already specified and owned by P4 — agency#510 defines the
route rule (omit cross-route subagent models with one pre-flight warning; loader exposes
route per role) and the code lives in the agency repo
(`packages/claude-plugin-cockpit/commands/auto.md`, `packages/cockpit/src/config/loader.ts`),
so "contained to this repo" cannot hold. Expected failure mode: `auto.md:262` passes
configured models straight to Agent spawns with no route awareness.

### D5: Criteria-based log validation; no artifact baseline (Q5)

**Decision**: FR-002 is satisfied per-cluster by three checks — gateway-route models
appear in the Bifrost access log, subscription-route models are absent from it, zero
gateway error lines. "Matches the dev run" = "satisfies the same criteria".

**Rationale**: #1203's evidence was criteria-shaped (exactly one launch on the
featherless model, four on `claude-fable-5`, gateway phases in the access log,
subscription phases absent, zero errors). Raw gateway logs live in Bifrost's `logs.db`
with `log_retention_days: 7` — no durable artifact exists to byte-diff. A fresh dev-run
baseline would burn a full serial cluster run just to manufacture what the criteria
already encode. #1203's metrics (10 requests, 5.3–11.5s latency, 0 errors) stay as a
qualitative sanity reference in `results.md`.

### D6: Runbook front-loads a prerequisite gate (verified 2026-08-28)

**Decision**: The runbook's step 0 verifies #1202 (generacy), #90 (cluster-base), and
#919 (generacy-cloud) are merged *and published* (npm package / image tags) before any
run step. As of this plan, **all three are OPEN** — authoring artifacts proceeds now;
executing runs blocks until the gate passes.

**Rationale**: Spec assumption: "if a contract is missing, this issue blocks on it
rather than re-implementing it." The current repo confirms the gap — the only
`llm-gateway` references in `packages/generacy/src` are the doctor check (#1200); the
scaffolder (`cli/commands/cluster/scaffolder.ts`) has no gateway stanza yet.

## Key sources

- Design doc: `tetrad-development/docs/llm-gateway-model-routing-plan.md` (P1 merged
  2026-08-26; tracking generacy#1197)
- Canon stanza: `tetrad-development/.devcontainer/generacy/docker-compose.yml:180-218`
- P2 recipe + findings: generacy-ai/generacy#1203 (closed; ran against #1211)
- Upstream contracts: generacy#1202, cluster-base#90, generacy-cloud#919 (all OPEN)
- P4 cockpit rule: agency#510 (OPEN)
- Doctor gateway check (P1, merged): `packages/generacy/src/cli/commands/doctor/checks/llm-gateway.ts`

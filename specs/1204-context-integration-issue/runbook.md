# Runbook: P3 Integration — Mixed-Route Dogfood on Published Templates

**Feature**: `1204-context-integration-issue` | **Epic**: generacy-ai/generacy#1197 (P3)
**Executed by**: operator (not the in-repo worker — see `quickstart.md`)
**Records into**: `results.md` (fill each step's "evidence to capture" as you go)

This is an ordered procedure. Do not skip ahead: **step 0 is a hard gate** and every run
step (1–6) depends on it. Each step declares preconditions, commands, expected outcome,
evidence to capture, and the abort/file path on failure.

Route semantics (P1, merged): a resolved model string containing `/` (`provider/model`)
takes the **gateway route**; every other string (`claude-*`) takes the **subscription
route**. "Mixed-route" means one dogfood run exercises both.

---

## Step 0 — Prerequisite hard gate (FR: gating; blocks all run steps)

**Preconditions**: none — this is the first thing you do.

**Commands**:

```bash
# All three run-blocking contracts must be MERGED and PUBLISHED.
gh issue view 1202 --repo generacy-ai/generacy      --json state,title
gh issue view 90   --repo generacy-ai/cluster-base  --json state,title
gh issue view 919  --repo generacy-ai/generacy-cloud --json state,title

# Then confirm the artifacts are actually published (not just merged):
npm view @generacy-ai/generacy version                 # must include the #1202 scaffolder flag
# cluster-base image tag carrying #90 (:preview from develop, :stable from main):
#   docker pull ghcr.io/generacy-ai/cluster-base:preview   (or :stable)
# generacy-cloud deploy ref carrying #919 (record the commit/tag the staging deploy uses)
```

**Expected outcome**: all three issues `CLOSED`/merged **and** the published package
version, image tag, and cloud deploy ref that carry them are identified.

**Evidence to capture** → `results.md § prerequisiteVersions`:
`generacyNpm` (version), `clusterBaseImage` (tag + digest), `cloudDeployRef` (commit/tag).

**Abort/file path**: if **any** contract is still OPEN or unpublished, **STOP** — do not
proceed to step 1. This issue *blocks on* the missing contract (spec Assumptions); it does
not re-implement it. Record the blocking ref in `results.md` and wait.

> Snapshot at authoring time (2026-08-28): #1202, #90, #919 (and P4's #510) were **all
> OPEN**. The runbook was authored against this gate; execution is deferred until it passes.

---

## Step 1 — Local cluster leg (US1 / FR-001) — SC-001

**Preconditions**: step 0 passed. A provider API key for a gateway model with
**`context_length` ≥ 128k** (32k models — e.g. featherless Qwen3-Coder variants — pass
smoke tests then fail to open real files like `phase-loop.ts` ≈ 35k tokens, Q2). A
disposable target repo for the dogfood issue.

**Commands**:

```bash
# Scaffold from the PUBLISHED package + cluster-base image — NOT the tetrad dev cluster.
generacy launch --llm-gateway

# Put gateway secrets in .env.local (gitignored; the committed .env carries none):
#   <PROVIDER>_API_KEY=...
#   GENERACY_LLM_GATEWAY_TOKEN=sk-bf-...        # sk-bf- prefix is required
cat >> .env.local <<'EOF'
GENERACY_LLM_GATEWAY_TOKEN=sk-bf-REDACTED
EOF

# Create a FRESH disposable speckit-bugfix dogfood issue per the #1203 template
# (its issue body + results comment; there is no standalone recipe doc).
# Commit + push the mixed-route orchestrator.agents block on the TARGET repo's working
# branch — per-repo overrides load from the target checkout
# (claude-cli-worker.ts:751 → tryLoadOrchestratorSettings), so it must live there, not on
# generacy develop. The block must mix a gateway-route model (contains `/`, ≥128k ctx)
# with a subscription-route model (e.g. claude-fable-5).
```

**Expected outcome**: the gateway (`llm-gateway` / Bifrost) service starts; the dogfood
issue is driven to terminal state `completed:validate`.

**Evidence to capture** → `results.md § runs[local]`: `dogfoodIssue`, `gatewayModel`
(+ recorded `context_length`), `subscriptionModel`, `terminalState`.

**Abort/file path**: gateway service missing → prerequisite gate false (#1202 not in the
published version) — return to step 0. Model can't read large files → wrong
`context_length`, reselect ≥128k. Overrides ignored → block not committed/pushed on the
*target* branch. A non-`completed:validate` outcome is acceptable **iff** root cause is
identified and filed (SC-005) — record the filed ref.

---

## Step 2 — Local evidence (US1 / FR-002) — SC-003

**Preconditions**: step 1 run complete. Capture **promptly** — Bifrost `logs.db` retention
is 7 days.

**Commands**:

```bash
# Worker logs: every phase launch with its resolved model string.
# Bifrost access log for the run window (in-container logs.db / access log).
# Evaluate against contracts/route-discrimination-criteria.md:
#   C1 gateway-hit       — every `/`-model phase appears in the access log
#   C2 subscription-absent — no `claude-*` model name appears in the access log
#   C3 zero-errors       — zero error-level lines in the gateway log for the window
```

**Expected outcome**: C1 ∧ C2 ∧ C3 all pass. Qualitative sanity vs #1203 (10 requests,
5.3–11.5s latency, 0 errors; ~1 gateway launch, ~4 subscription) — gross deviation
warrants a note even on pass.

**Evidence to capture** → `results.md § runs[local].criteria`: per-check `pass` /
`fail(check, evidence, filedRef)`; access-log lines matched to worker-log launches.

**Abort/file path**: any check fails → record `fail(...)`, attribute root cause, file
against the owning repo (scaffolder → **this** repo; cluster-base script →
generacy-ai/cluster-base). Filed + attributed still satisfies acceptance (SC-005).

---

## Step 3 — Cloud cluster leg (US2 / FR-003) — SC-002

**Preconditions**: step 0 passed. A staging cloud VM. A **second, distinct** fresh
disposable speckit-bugfix issue (do not reuse step 1's).

**Commands**:

```bash
# Deploy a staging cloud cluster with the gateway enabled.
#   llmGatewayEnabled=true
# Place the provider key + GENERACY_LLM_GATEWAY_TOKEN in .env.local ON THE VM.
# Create the second disposable issue; commit + push the same mixed-route
# orchestrator.agents recipe on its target repo's working branch. Drive to terminal state.
```

**Expected outcome**: the staging cluster reaches `completed:validate` on the recipe.

**Evidence to capture** → `results.md § runs[cloud]`: same fields as step 1.

**Abort/file path**: same as step 1; a non-terminal outcome is acceptable iff attributed
and filed (SC-005).

---

## Step 4 — Cloud evidence + filing (US2 / FR-004) — SC-003 / SC-005

**Preconditions**: step 3 run complete. Capture promptly (7-day retention).

**Commands**: evaluate the cloud run against the same C1–C3 criteria (step 2).

**Expected outcome**: C1 ∧ C2 ∧ C3 pass, matching the local/dev behaviour.

**Evidence to capture** → `results.md § runs[cloud].criteria` and `§ filedIssues`.

**Abort/file path**: **any divergence from local/dev behaviour is filed against
generacy-ai/generacy-cloud** with the evidence attached; record the ref in
`results.md § runs[cloud].divergences` and `§ filedIssues`.

---

## Step 5 — Four-way stanza diff (US3 / FR-005) — SC-004

**Preconditions**: the four sources are reachable in sibling checkouts. Canon is the
tetrad dev compose `.devcontainer/generacy/docker-compose.yml:180-218`.

**Commands**:

```bash
specs/1204-context-integration-issue/scripts/diff-gateway-stanza.sh
# Sources diffed against canon (tetrad dev compose):
#   1. scaffolder output   packages/generacy/src/cli/commands/cluster/scaffolder.ts (post-#1202)
#   2. tetrad dev compose  = CANON
#   3. cluster-base compose (post-#90)
#   4. cloud-deploy template (post-#919)
```

**Expected outcome**: every hunk classified — no hunk left unclassified (SC-004 invariant).

**Evidence to capture** → `results.md § stanzaDiff` (DiffReport): per hunk, `source`,
`hunk`, `classification` ∈ { `intentional` (with reason) | `fixed-here` (scaffolder PR
ref) | `filed` (owning-repo issue ref) }. Deliberate adaptations (token generation, env
plumbing) are `intentional`; an unexplained divergence is presumptively a port bug.

**Abort/file path**: a divergence that traces to **this repo's scaffolder** → go to step
5a (fix here). A divergence owned elsewhere → `filed` against that repo.

### Step 5a — Scaffolder fix (conditional; only if step 5 traces a divergence here)

```bash
# Edit packages/generacy/src/cli/commands/cluster/scaffolder.ts so its emitted
# llm-gateway stanza converges to canon, then add a NEWLY-created changeset (patch —
# defect fix; the gate greps --diff-filter=A because this touches packages/*/src/):
#   .changeset/1204-scaffolder-gateway-stanza.md   (patch, package @generacy-ai/generacy)
```

If no scaffolder divergence is found, skip 5a and record "no in-repo divergence" in
`results.md § stanzaDiff`.

---

## Step 6 — cockpit auto observation (US4 / FR-006) — validation-only (Q4)

**Preconditions**: a mixed `cockpit.auto.agents` block (gateway-route + subscription-route
models). **No cockpit code changes in this branch** — the fix is owned by P4 (agency#510),
whose code lives in the agency repo.

**Commands**:

```bash
# Configure the mixed cockpit.auto.agents block and observe today's `cockpit auto` playbook
# dispatch the dogfood issue(s). Record the observed dispatch behaviour.
```

**Expected outcome (predicted)**: `auto.md` passes configured models straight to Agent
spawns with **no route awareness** (auto.md:262, in the **agency** repo) — i.e. it does not
omit cross-route subagent models.

**Evidence to capture** → `results.md § cockpitAutoObservation`: `configUsed`,
`observedBehavior`, `filedRef`.

**Abort/file path**: append the repro to **agency#510**; file fresh only if the failure
differs from #510's prediction. Record the ref.

---

## Step 7 — Closeout (FR-007)

**Preconditions**: steps 1–6 complete; `results.md` fields populated.

**Commands**:

```bash
# Cross-repo edit (scripted here as an operator step): flip the design-doc status.
# File: tetrad-development/docs/llm-gateway-model-routing-plan.md
#   set the P3 status line to "P3 complete" and paste the findings summary.
$EDITOR /workspaces/tetrad-development/docs/llm-gateway-model-routing-plan.md

# Finalize results.md: both ClusterRunResults present, DiffReport zero unclassified hunks,
# cockpitAutoObservation has a filedRef (or explicit "matches #510 prediction"), and the
# design-doc flip is linked. Commit the filled results.md.
```

**Expected outcome**: design doc reads "P3 complete"; `results.md` passes its § Validation
rules (data-model.md) — no field left incomplete.

**Evidence to capture** → `results.md § filedIssues` complete (SC-005: 100% of failures
attributed and filed); link to the design-doc commit.

**Abort/file path**: if `results.md` is still incomplete (missing run, unclassified hunk,
no cockpit filedRef, or unlinked design-doc flip), do not declare P3 complete.

---

## FR coverage map

| FR | Step |
|----|------|
| FR-001 | 1 |
| FR-002 | 2 |
| FR-003 | 3 |
| FR-004 | 4 |
| FR-005 | 5 (+ 5a conditional) |
| FR-006 | 6 |
| FR-007 | 7 |

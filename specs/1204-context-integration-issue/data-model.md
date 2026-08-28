# Data Model: P3 Integration Artifacts

The deliverables are documents, so the "data model" is the required structure of each
document and the validation states they carry.

## Entities

### Runbook (`runbook.md`)

Ordered operator procedure. Required sections:

| Section | Content | Gate |
|---------|---------|------|
| 0. Prerequisite gate | Verify #1202 / #90 / #919 merged and published (npm version, image tag). Record versions used. | Hard block — no run steps until pass |
| 1. Local cluster leg | Scaffold with `--llm-gateway`, provider key + `sk-bf-` token into `.env.local`, create disposable dogfood issue, commit mixed-route `orchestrator.agents` on target branch, drive to terminal state | FR-001 |
| 2. Local evidence | Collect worker logs + Bifrost access log; evaluate route-discrimination criteria (contract) | FR-002 |
| 3. Cloud cluster leg | Staging deploy `llmGatewayEnabled=true`, `.env.local` on VM, fresh disposable issue, same recipe | FR-003 |
| 4. Cloud evidence + filing | Same criteria; file divergences against generacy-ai/generacy-cloud | FR-004 |
| 5. Four-way stanza diff | Run diff helper across the four sources; classify each hunk | FR-005 |
| 6. cockpit auto observation | Mixed `cockpit.auto.agents` block; record observed dispatch behavior; append to agency#510 | FR-006 |
| 7. Closeout | Flip design doc to "P3 complete" (tetrad-development); finalize `results.md` | FR-007 |

Each step declares: preconditions, commands, expected outcome, evidence to capture,
and the abort/file path on failure.

### Results report (`results.md`)

Committed as a template with empty result fields; filled by the operator.

```
ResultsReport
├── prerequisiteVersions: { generacyNpm, clusterBaseImage, cloudDeployRef }
├── runs: ClusterRunResult[2]        # local, cloud
├── stanzaDiff: DiffReport
├── cockpitAutoObservation: { configUsed, observedBehavior, filedRef }
└── filedIssues: IssueRef[]          # SC-005: every failure attributed
```

### ClusterRunResult

| Field | Type | Notes |
|-------|------|-------|
| cluster | `local \| cloud` | |
| dogfoodIssue | IssueRef | fresh disposable issue (Q2) |
| gatewayModel | string | must contain `/`; context_length ≥128k recorded |
| subscriptionModel | string | e.g. `claude-fable-5` |
| terminalState | string | target: `completed:validate` (SC-001/SC-002) |
| criteria | CriteriaResult | see contract |
| divergences | IssueRef[] | empty, or filed refs |

### CriteriaResult (contract: `contracts/route-discrimination-criteria.md`)

| Check | Pass condition |
|-------|----------------|
| C1 gateway-hit | Every gateway-route phase launch appears in the Bifrost access log |
| C2 subscription-absent | No subscription-route model name appears in the Bifrost access log |
| C3 zero-errors | Zero error lines in the gateway log for the run window |

All three must pass per cluster. States: `pass` / `fail(check, evidence, filedRef)`.

### DiffReport (FR-005)

One entry per hunk per source pair (canon = tetrad dev compose):

| Field | Values |
|-------|--------|
| source | `scaffolder \| cluster-base \| cloud-deploy` |
| hunk | stanza excerpt |
| classification | `intentional` (recorded, with reason) \| `fixed-here` (scaffolder PR ref) \| `filed` (owning-repo issue ref) |

Invariant (SC-004): zero hunks left unclassified.

### IssueRef

`owner/repo#N` — canonical form throughout (matches dependency-marker conventions).

## Relationships

```
runbook.md  ──executes──▶  results.md
results.md  ──embeds───▶  ClusterRunResult ×2 ──evaluated-by──▶ CriteriaResult (contract)
results.md  ──embeds───▶  DiffReport ──references──▶ 4 template sources
results.md  ──links────▶  filed IssueRefs (SC-005 closure)
```

## Validation rules

- A run that does not reach `completed:validate` still satisfies acceptance **iff** root
  cause is identified and a filed IssueRef exists (spec assumption).
- `results.md` is incomplete until: both ClusterRunResults present, DiffReport has zero
  unclassified hunks, cockpitAutoObservation has a filedRef or explicit "matches #510
  prediction" note, and the design-doc flip is linked.

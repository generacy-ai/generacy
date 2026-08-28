# Results Report: P3 Integration — Mixed-Route Dogfood on Published Templates

**Feature**: `1204-context-integration-issue` | **Epic**: generacy-ai/generacy#1197 (P3)
**Status**: TEMPLATE — filled in by the operator as `runbook.md` steps complete.

> This document is committed as a template with empty result fields. Fill each `<…>`
> placeholder from the corresponding runbook step's "evidence to capture" line. See
> § Validation rules for when this report counts as complete.

---

## Prerequisite versions (runbook step 0)

| Field | Value |
|-------|-------|
| `generacyNpm` | `<@generacy-ai/generacy version carrying #1202>` |
| `clusterBaseImage` | `<ghcr.io/generacy-ai/cluster-base tag + digest carrying #90>` |
| `cloudDeployRef` | `<generacy-cloud deploy commit/tag carrying #919>` |

> Authoring-time gate snapshot (2026-08-28): #1202, #90, #919 (and P4 #510) all **OPEN** —
> runs deferred until this gate passes.

---

## Runs

### runs[local] — ClusterRunResult (runbook steps 1–2) — SC-001 / SC-003

| Field | Value |
|-------|-------|
| `cluster` | `local` |
| `dogfoodIssue` | `<owner/repo#N — fresh disposable, Q2>` |
| `gatewayModel` | `<provider/model — must contain `/`; context_length = <N> (≥128k)>` |
| `subscriptionModel` | `<e.g. claude-fable-5>` |
| `terminalState` | `<target: completed:validate>` |
| `divergences` | `<empty, or filed IssueRefs>` |

**criteria** — CriteriaResult (contract `contracts/route-discrimination-criteria.md`):

| Check | Result | Evidence |
|-------|--------|----------|
| C1 gateway-hit | `<pass \| fail>` | `<access-log lines matched to worker-log launches>` |
| C2 subscription-absent | `<pass \| fail>` | `<grep of access log for subscription names → empty>` |
| C3 zero-errors | `<pass \| fail>` | `<error-line count = 0>` |

Overall: `<pass iff C1 ∧ C2 ∧ C3 | fail(check, evidence, filedRef)>`

### runs[cloud] — ClusterRunResult (runbook steps 3–4) — SC-002 / SC-003

| Field | Value |
|-------|-------|
| `cluster` | `cloud` |
| `dogfoodIssue` | `<owner/repo#N — second fresh disposable>` |
| `gatewayModel` | `<provider/model; context_length = <N> (≥128k)>` |
| `subscriptionModel` | `<e.g. claude-fable-5>` |
| `terminalState` | `<target: completed:validate>` |
| `divergences` | `<empty, or IssueRefs filed vs generacy-ai/generacy-cloud>` |

**criteria** — CriteriaResult:

| Check | Result | Evidence |
|-------|--------|----------|
| C1 gateway-hit | `<pass \| fail>` | `<…>` |
| C2 subscription-absent | `<pass \| fail>` | `<…>` |
| C3 zero-errors | `<pass \| fail>` | `<…>` |

Overall: `<pass iff C1 ∧ C2 ∧ C3 | fail(check, evidence, filedRef)>`

---

## Stanza diff — DiffReport (runbook step 5 / FR-005) — SC-004

Canon = tetrad dev compose `.devcontainer/generacy/docker-compose.yml:180-218`.
One row per hunk per source pair. **Invariant: zero hunks left unclassified.**

| source | hunk | classification |
|--------|------|----------------|
| `<scaffolder \| cluster-base \| cloud-deploy>` | `<stanza excerpt>` | `<intentional (reason) \| fixed-here (scaffolder PR ref) \| filed (owning-repo issue ref)>` |

> If the helper reports no divergence attributable to this repo's scaffolder, record:
> **"no in-repo divergence"** here (runbook step 5a skipped, task T012 not fired).

---

## cockpit auto observation (runbook step 6 / FR-006) — validation-only (Q4)

| Field | Value |
|-------|-------|
| `configUsed` | `<mixed cockpit.auto.agents block>` |
| `observedBehavior` | `<observed dispatch; predicted: passes models straight to Agent spawns, no route awareness (auto.md:262, agency repo)>` |
| `filedRef` | `<agency#510 comment ref, or fresh issue if failure differs, or "matches #510 prediction">` |

---

## Filed issues (SC-005 — 100% of failures attributed)

| ref | for |
|-----|-----|
| `<owner/repo#N>` | `<what it captures>` |

---

## Closeout (runbook step 7 / FR-007)

- Design-doc flip → "P3 complete": `<link to tetrad-development commit editing
  docs/llm-gateway-model-routing-plan.md>`

---

## Qualitative reference (non-normative, from #1203)

Dev-run metrics: **10 requests, 5.3–11.5s latency, 0 errors**; exactly one launch on the
featherless model and four on `claude-fable-5`. Use as a sanity check — an order-of-
magnitude latency deviation or unexpected launch counts warrants a note even when C1–C3 pass.

---

## Completion targets

- **SC-001 / SC-002**: both runs reach `completed:validate` (or a non-terminal outcome with
  root cause identified and a filed ref).
- **SC-003**: gateway-route models hit the gateway; subscription-route models bypass it (C1–C3).
- **SC-004**: zero unexplained diffs across the four sources.
- **SC-005**: 100% of failures attributed and filed.

## Validation rules (data-model.md § Validation rules)

`results.md` is **incomplete** until ALL of:

1. both `runs[local]` and `runs[cloud]` ClusterRunResults present;
2. DiffReport has **zero** unclassified hunks;
3. `cockpitAutoObservation` has a `filedRef` or an explicit "matches #510 prediction" note;
4. the design-doc flip (step 7) is linked.

A run that does not reach `completed:validate` still satisfies acceptance **iff** its root
cause is identified and a filed IssueRef exists.

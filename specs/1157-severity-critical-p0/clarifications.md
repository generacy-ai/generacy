# Clarifications: Red CI must not silently complete the workflow

## Batch 1 — 2026-08-21

### Q1: Recoverable-state mechanism
**Context**: FR-002 says the `not-passed` path must enter a recoverable, operator-visible state, but the Summary/Assumptions leave open whether that is a *pause with a gate* (symmetric with the existing `timeout` → `waiting-for:ci` pause) or a `failed:validate`-class *escalation*. The two produce different label sets, different resume mappings, and different cockpit surfaces. This decision drives the entire FR-002/FR-003 implementation.
**Question**: Should a `not-passed` CI verdict pause the workflow with a `waiting-for:*` gate (recoverable, mirrors the timeout pause), or raise a `failed:validate`-class escalation label?
**Options**:
- A: Pause with a `waiting-for:*` gate + `agent:paused` (symmetric with the existing timeout pause; recoverable).
- B: Raise a `failed:validate`-class escalation (non-gate; requires `/cockpit:resume`-style re-arm).
- C: Pause with a gate normally, but escalate to `failed:*` only after a bounded number of red-CI re-checks.

**Answer**: *Pending*

### Q2: Gate label identity (red-CI vs timeout)
**Context**: The existing `timeout` outcome already pauses with `waiting-for:ci` (`phase-loop.ts:1300-1325`). If `not-passed` reuses the same label, an operator (and cockpit) cannot distinguish "CI never finished" from "CI finished red" — and both resume through the same `GATE_MAPPING['ci']` path. A distinct label (e.g. `waiting-for:ci-failed`) separates the two states at the cost of a new label + gate-mapping entry.
**Question**: Should the `not-passed` pause reuse the existing `waiting-for:ci` label, or introduce a distinct label to separate red-CI from the timeout case?
**Options**:
- A: Reuse `waiting-for:ci` (minimal surface; timeout and red-CI look identical, disambiguated only by the reason comment).
- B: Introduce a distinct label (e.g. `waiting-for:ci-failed` / `failed:ci`) so red-CI is separable from timeout in labels and cockpit.

**Answer**: *Pending*

### Q3: Resume semantics after a red-CI pause
**Context**: FR-002 requires recoverability, but the spec does not define what clears the gate or what phase the workflow re-enters. After an operator fixes the red CI (e.g. lint) and pushes a new commit, the natural recovery is to re-evaluate CI on the new head SHA — which re-running `validate` would do (it re-marks ready and re-waits CI). Alternatively resume could skip straight to the `on-ci-green` gate / completion.
**Question**: When the red-CI gate is satisfied (operator adds the `completed:*` label), should the workflow re-run `validate` (re-poll CI on the new head SHA) or resume directly to the post-validate approval gate / completion?
**Options**:
- A: Re-run `validate` — re-marks ready, re-waits CI on the new SHA, re-evaluates the merge gate (safest; confirms CI is actually green now).
- B: Resume directly to the post-validate `implementation-review` gate / completion (assumes the operator vouched CI is green; skips re-check).

**Answer**: *Pending*

### Q4: Head-SHA fast-fail landing state (US2/FR-005)
**Context**: When `getCurrentCommitSha()` fails, FR-005 requires a fast fail instead of a 15-min poll of the `'unknown'` sentinel. The Assumptions say it should surface as "an operator-visible pause (same class as the red-CI pause)". But an unresolvable head SHA is an infrastructure anomaly, arguably distinct from a red-CI result, and may warrant its own reason/label.
**Question**: Should the missing-head-SHA fast-fail land in the *same* pause state as red CI (Q1/Q2 outcome), or a distinct state that names the SHA-resolution failure specifically?
**Options**:
- A: Same pause state as red CI (reuse the Q1/Q2 gate + label), differentiated only by the reason comment/log.
- B: A distinct label/reason that names the head-SHA resolution failure as an infra anomaly.

**Answer**: *Pending*

### Q5: FR-007 fallback-path treatment (guard vs document)
**Context**: The token-limited `actions/runs` fallback (`gh-cli.ts:1709-1739`) only enumerates GitHub-Actions runs, so third-party required checks are invisible and can yield a false `green`. FR-007 offers "guard against or clearly document". A guard is a real behavior change (never declare `green` from the fallback → force pause/timeout); documentation is passive and keeps today's behavior.
**Question**: For FR-007, should the fallback path actively *guard* (never return `green` when using the `actions/runs` fallback, downgrading to `pending`/`not-passed`), or ship *documentation only* (comment at the readout site + operator docs, no behavior change)?
**Options**:
- A: Active guard — the `actions/runs` fallback never yields `green` (fail-closed), forcing a pause/timeout when third-party checks may be invisible.
- B: Documentation only — annotate the readout site + operator docs; behavior unchanged.
- C: Conservative middle — guard only when the token is known to lack `checks:read` (fallback was actually used), document otherwise.

**Answer**: *Pending*

# Contract: Route-Discrimination Criteria (FR-002 / SC-003)

Per Clarification Q5, log validation is criteria-based — no log-artifact baseline.
Each cluster run (local and cloud) is evaluated independently against all three checks.

## Inputs

- **Worker logs** for the dogfood run: every phase launch with its resolved model string.
- **Bifrost access log** for the run window (in-container `logs.db` / access log;
  retention is 7 days — capture evidence promptly).

## Checks

| ID | Check | Pass condition | Evidence to capture |
|----|-------|----------------|---------------------|
| C1 | Gateway routes hit the gateway | Every phase whose resolved model contains `/` (`provider/model`) has a corresponding request in the Bifrost access log | Access-log lines matched to worker-log launches |
| C2 | Subscription routes bypass the gateway | No phase whose resolved model is subscription-shaped (`claude-*`, no `/`) appears in the Bifrost access log | Grep of access log for subscription model names → empty |
| C3 | Zero gateway errors | No error-level lines in the gateway log during the run window | Error-line count = 0 |

**Overall result**: pass iff C1 ∧ C2 ∧ C3.

## Failure handling

- Any failed check ⇒ record `fail(check, evidence)` in `results.md`, attribute root
  cause, and file against the owning repo (scaffolder → this repo; cloud template →
  generacy-ai/generacy-cloud; cluster-base script → generacy-ai/cluster-base).
- A failed check does not block acceptance if attributed and filed (SC-005).

## Qualitative reference (non-normative)

#1203 dev-run metrics — 10 requests, 5.3–11.5s latency, 0 errors; exactly one launch on
the featherless model and four on `claude-fable-5`. Gross deviation (e.g. order-of-
magnitude latency, unexpected launch counts) warrants a note even when C1–C3 pass.

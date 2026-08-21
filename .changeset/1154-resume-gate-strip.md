---
"@generacy-ai/orchestrator": patch
---

Resume label-strip no longer discards human-gate answers (#1154).

`LabelManager.onResumeStart()` runs before the phase loop on every `continue`
and stripped `completed:<X>` for every co-present `waiting-for:<X>` gate.
Pre-epic gates survived because their resume phase is past the gate, but the
two new epic gates (`remediation-limit` and the on-ci-green
`implementation-review`) re-evaluate at the resumed phase and depend on the
surviving `completed:<X>` label — so the operator's answer was silently
discarded and the workflow re-parked, making the gates un-answerable.

Fix (internal bug fix across `label-manager.ts`, `phase-resolver.ts`, and
`phase-loop.ts`; no new public exports, no new label vocabulary — `waiting-for:ci`
/ `completed:ci` already ship from #1133):

- Guard the completed-strip loop in `onResumeStart()` with
  `!isHumanGateCompletion(...)` so every `completed:<X>` for a human-gate
  suffix survives the resume strip; stale `waiting-for:*` and `agent:paused`
  removals are unchanged.
- Add `'ci': { phase: 'validate', resumeFrom: 'validate' }` to `GATE_MAPPING`,
  which auto-includes `ci` in the derived `HUMAN_GATE_SUFFIXES` and gives
  `completed:ci` a defined resume phase.
- Marker-dedupe the "Remediation limit reached" gate-body comment on the
  `<!-- generacy-remediation-limit -->` marker so a re-parked cap does not
  re-post it every resume cycle.
- Best-effort defensive clear of a lingering `completed:remediation-limit` on
  any clean pass through `review`.

Both fixes sit behind the epic's existing feature flags
(`reviewPhaseEnabled` / `WORKER_REVIEW_PHASE_ENABLED`; `ciMergeGateEnabled` /
`WORKER_CI_MERGE_GATE_ENABLED`) — a flag-off cluster is unaffected.

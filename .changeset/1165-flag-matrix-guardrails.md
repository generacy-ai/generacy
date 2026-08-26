---
"@generacy-ai/orchestrator": patch
---

Close four flag-matrix guardrail corners for the review/remediate epic (#1165, `workflow:speckit-bugfix`).

Corner 4 (`worker/types.ts`): `getPhaseSequence` now filters `review` out of the fallback sequence for an unknown/custom workflow regardless of `reviewPhaseEnabled`, so only known workflows can opt into the `review` phase. Corner 1 (`worker/phase-loop.ts`): on the default (`reviewPhaseEnabled` OFF) path a failing `validate` gets exactly one bounded remediate attempt before escalating, keeping the legacy path self-healing without the full engine-native review→remediate loop. Corners 2 and 3 are doc/test-only (legacy `blocked:stuck-feedback-loop` bound reconcile; `speckit-bugfix` `on-ci-green` gate pin) and add no runtime behavior. Both epic flags remain default `false`, so a flags-OFF cluster is byte-identical to before.

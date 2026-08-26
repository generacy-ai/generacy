---
'@generacy-ai/orchestrator': patch
---

Route a failing `validate` phase into the engine-native review → remediate →
validate loop instead of the legacy one-shot `validate-fix-handler` side path
(`workflow:speckit-bugfix`). On a validate red with `reviewPhaseEnabled`, the
phase loop checks the failure-fingerprint backstop first (escalating with
`failed:validate-repeated` at the repeat threshold), otherwise synthesizes a
`changes-required` review artifact and backtracks into `review`, dispatching the
thin remediate adapter at exactly one site — the remediate seam. `failed:validate`
is no longer applied on the routed path (the loop owns escalation), and the
`resumeReason === 'base-advance'` precondition is removed. With
`reviewPhaseEnabled = false` behavior is byte-identical to before. No new public
exports and no new label vocabulary.

---
"@generacy-ai/generacy": patch
---

Make deploy `runActivation` pure w.r.t. `GENERACY_PROJECT_ID` (#1190).

`runActivation` no longer reads `process.env['GENERACY_PROJECT_ID']` directly;
it accepts an optional `projectId` on `ActivateOptions` and the single ambient
read now lives at the `deploy` command composition root (`index.ts`). This
makes the activation-URL branch deterministically testable independent of the
ambient environment. The generated URL is byte-identical to before (projectId
is appended only when truthy). No public export change.

---
"@generacy-ai/orchestrator": patch
---

Fire boot-resume on wizard-provisioned clusters, not just the env-key branch (#834).

The #824 boot-resume fix only ran in `createServer()`'s existing-API-key branch, but
wizard-provisioned clusters boot with `config.relay.apiKey` empty (the key is persisted
to `/var/lib/generacy/cluster-api-key` and reloaded during activation), so they always
take the `activateInBackground` path — which handled only the `PostActivationRetryService`
retry case and never constructed `BootResumeService`. Net effect: on every dev cluster
the VS Code tunnel and code-server stayed down after a `stop`/`start`. The shared
"check post-activation state → retry (`needsRetry`) or resume (`activated &&
postActivationComplete`)" logic is now hoisted into `runPostActivationBranch`, which both
the synchronous existing-key branch and `activateInBackground` call, so the two startup
paths can no longer drift. A regression test drives the `activateInBackground` path with
`activated && postActivationComplete` state and asserts the resume branch fires.

---
"@generacy-ai/orchestrator": patch
"@generacy-ai/control-plane": patch
---

Fix fresh wizard clusters never cloning their repo: the post-activation retry replayed `bootstrap-complete` before `GH_TOKEN` was sealed, burning the one-shot clone watcher (#937).

On a brand-new wizard-provisioned cluster the state is `activated &&
!postActivationComplete` the instant activation completes — so
`PostActivationRetryService` fired immediately, ~2 minutes before the user
finished entering credentials, replaying the `bootstrap-complete` lifecycle
action. The control-plane wrote the post-activation sentinel unconditionally,
the one-shot clone watcher fired with no token and (correctly) refused, then
exited — and nothing was left to consume the credentials when they landed.
This regressed once #838 made the dispatch block reachable on wizard clusters,
re-opening the race #739 had closed via the `bootstrap-complete` door it left
ungated.

- `@generacy-ai/orchestrator`: `checkPostActivationState()` now only sets
  `needsRetry` when the wizard credentials file exists **and** carries a
  non-empty `GH_TOKEN` (mirroring the guard `entrypoint-post-activation.sh`
  applies). On a fresh pre-credentials cluster the retry defers; genuine
  restart-recovery with creds already sealed still fires.
- `@generacy-ai/control-plane`: defense-in-depth — the `bootstrap-complete`
  lifecycle handler now gates its sentinel write on `hasGitHubToken`, exactly
  like the sibling `prepare-workspace` handler, so a token-less replay can never
  fire the one-shot clone.

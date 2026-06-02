---
"@generacy-ai/control-plane": patch
---

fix(control-plane): defer the post-activation sentinel until the GitHub token is sealed

`prepare-workspace` wrote the post-activation sentinel unconditionally, even
when `writeWizardEnvFile` had not yet produced a `GH_TOKEN`. Because the
post-activation watcher is one-shot, this fired the deferred repo clone before
the GitHub token existed — the clone of a private repo authenticated with
nothing, produced no workspace, and never re-ran when the token landed via
`bootstrap-complete`. `writeWizardEnvFile` now reports `hasGitHubToken`, and
`prepare-workspace` only writes the sentinel once the token is present
(otherwise it defers to `bootstrap-complete`, which fires with the full
credential set).

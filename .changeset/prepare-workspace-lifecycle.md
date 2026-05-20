---
"@generacy-ai/control-plane": minor
---

Add `prepare-workspace` lifecycle action: a subset of `bootstrap-complete` that unseals whatever wizard credentials are currently stored and writes the post-activation sentinel, but **does not** start code-server or VS Code Tunnel. Intended for use by the wizard's GitHubAppInstall step so the cluster's workspace clone runs in parallel with the remaining wizard steps (peer-repos, app-config), making the app-config manifest available by the time the user reaches that wizard step. `bootstrap-complete` remains the action fired by ReadyStep at the end of the wizard.

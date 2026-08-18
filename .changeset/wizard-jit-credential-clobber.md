---
'@generacy-ai/generacy': patch
---

`setup auth` and `setup workspace` no longer clobber the JIT git credential helper on wizard-mode clusters. Both commands previously configured static credentials from the activation-time `GH_TOKEN` (a 1-hour GitHub App installation token) — `setup auth` wrote `credential.helper store` + `~/.git-credentials`, and `setup workspace` ran `gh auth setup-git`, replacing the `git-credential-generacy` helper wired by cluster-base's setup-credentials.sh. Workers (which run no git-helper-guard) then lost all git auth an hour after activation. When wizard mode is active and the JIT helper is present in git config, both commands now leave credential configuration untouched.

---
"@generacy-ai/generacy": patch
---

Propagate `repos.primaryBranch` from the cloud LaunchConfig into the scaffolded `.generacy/.env` file. Previously the Zod schema silently stripped the field, so `generacy launch` and `generacy deploy` always wrote a `.env` without `REPO_BRANCH=`. The orchestrator container then fell back to `${REPO_BRANCH:-main}` and `git clone --branch main` aborted for any project whose default branch isn't `main`.

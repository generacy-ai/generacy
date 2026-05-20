# @generacy-ai/generacy

## 0.1.4

### Patch Changes

- e645ad7: Propagate `repos.primaryBranch` from the cloud LaunchConfig into the scaffolded `.generacy/.env` file. Previously the Zod schema silently stripped the field, so `generacy launch` and `generacy deploy` always wrote a `.env` without `REPO_BRANCH=`. The orchestrator container then fell back to `${REPO_BRANCH:-main}` and `git clone --branch main` aborted for any project whose default branch isn't `main`.

## 0.1.3

### Patch Changes

- Updated dependencies [6779a85]
  - @generacy-ai/activation-client@0.1.1
  - @generacy-ai/config@0.1.1
  - @generacy-ai/orchestrator@0.1.1
  - @generacy-ai/workflow-engine@0.1.1

## 0.1.2

### Patch Changes

- da4825e: Initial `stable` dist-tag release. Publishes current main under the `stable` channel so the orchestrator's `npm install @generacy-ai/<pkg>@stable` resolves.

## 0.1.1

### Patch Changes

- 28428ae: Initial `stable` dist-tag release. Publishes current main under the `stable` channel so the orchestrator's `npm install @generacy-ai/<pkg>@stable` resolves.

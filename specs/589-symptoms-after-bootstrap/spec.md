# Feature Specification: ## Symptoms

After the bootstrap wizard's "Install GitHub App" step completes successfully and credentials land on the cluster, the post-activation script still fails with:

\`\`\`
[setup-credentials] WARNING: GH_TOKEN not set — git operations requiring auth will fail
[post-activation] Cloning project repo: christrudelpw/onboarding-test-4 (branch: main)
fatal:

**Branch**: `589-symptoms-after-bootstrap` | **Date**: 2026-05-12 | **Status**: Draft

## Summary

## Symptoms

After the bootstrap wizard's "Install GitHub App" step completes successfully and credentials land on the cluster, the post-activation script still fails with:

\`\`\`
[setup-credentials] WARNING: GH_TOKEN not set — git operations requiring auth will fail
[post-activation] Cloning project repo: christrudelpw/onboarding-test-4 (branch: main)
fatal: ...
\`\`\`

The post-activation script then exits non-zero (\`post-activation exited 128\` in the orchestrator log).

## Root cause

The bootstrap wizard's credential flow:

1. User installs the GitHub App via the wizard
2. Cloud forwards the credential through the relay → cluster's control-plane
3. Control-plane's [\`handlePutCredential\`](packages/control-plane/src/routes/credentials.ts) writes:
   - Encrypted blob to \`/var/lib/generacy/credentials.dat\` (sealed via cluster-local backend)
   - Metadata stub to \`/workspaces/.agency/credentials.yaml\` (\`type: github-app, status: active\`)
4. Bootstrap-complete fires → \`/tmp/generacy-bootstrap-complete\` sentinel written
5. \`post-activation-watcher.sh\` detects sentinel → spawns \`entrypoint-post-activation.sh\`
6. That script runs [\`setup-credentials.sh\`](https://github.com/generacy-ai/cluster-base/blob/develop/.devcontainer/generacy/scripts/setup-credentials.sh), which checks \`${GH_TOKEN:-}\`

**Nothing in steps 2-5 exports the GitHub token as a process env var.** It's sealed in the cluster-local credstore, accessible only via the credhelper-daemon, but \`setup-credentials.sh\` is a bash script that doesn't go through credhelper. From its perspective, the credentials may as well not exist.

Verified on a live cluster:

\`\`\`
$ docker exec onboarding-test-4-orchestrator-1 env | grep -i 'gh_token\|github_token'
# (empty)

$ docker exec onboarding-test-4-orchestrator-1 cat /workspaces/.agency/credentials.yaml
credentials:
  github-main-org:
    type: github-app
    backend: cluster-local
    status: active
\`\`\`

The credential is *known* to the cluster but unreachable from bash.

## Fix options

### A. Control-plane writes a transient env file on bootstrap-complete

The [\`bootstrap-complete\` handler](packages/control-plane/src/routes/lifecycle.ts#L97-L118) already knows it's about to wake the post-activation watcher. Before writing the sentinel, it can unseal the cluster-local credentials it just received and write them to a node-owned file:

\`\`\`bash
# /var/lib/generacy/wizard-credentials.env (mode 0600, owned by node)
GH_TOKEN=ghs_...
ANTHROPIC_API_KEY=sk-ant-...
\`\`\`

Then update [\`entrypoint-post-activation.sh\`](https://github.com/generacy-ai/cluster-base/blob/develop/.devcontainer/generacy/scripts/entrypoint-post-activation.sh) to source that file before calling \`setup-credentials.sh\`:

\`\`\`bash
WIZARD_CREDS=/var/lib/generacy/wizard-credentials.env
if [ -f "$WIZARD_CREDS" ]; then
  set -a; source "$WIZARD_CREDS"; set +a
fi
bash /usr/local/bin/setup-credentials.sh
\`\`\`

Pros: minimal change. Pre-existing credentials.dat continues to be the long-term store; the env file is just a one-shot bridge to bash scripts. Can be deleted by the post-activation script after consumption.

Cons: secrets briefly on-disk in plaintext. Mitigations: \`tmpfs\` mount for the env file path, or delete after first read.

### B. setup-credentials.sh calls a generacy CLI

\`generacy credentials get <id>\` would print the unsealed value. setup-credentials.sh becomes:

\`\`\`bash
GH_TOKEN="${GH_TOKEN:-$(generacy credentials get github-main-org --field=token 2>/dev/null)}"
\`\`\`

Pros: no on-disk plaintext. Single command per credential, idempotent.

Cons: requires a new CLI subcommand (\`generacy credentials get\`) that doesn't exist yet. More plumbing.

### C. Mount credhelper socket and use it from bash

The credhelper-daemon already runs and exposes a unix socket. setup-credentials.sh could use \`curl --unix-socket\` to fetch creds. But the credhelper API is session-based (intended for per-worker process credential bundles), so this is awkward for a one-shot bash script.

Recommend **A** for v1 — fastest path to unblocking the post-activation flow. **B** is the right long-term answer (no disk plaintext, single source of truth, composable with other scripts), file as a follow-up.

## Test plan
- [ ] After fix: wizard completes → post-activation runs → \`git clone\` succeeds (assuming the repo exists and \`REPO_URL\` is well-formed — see related issue for the URL normalization gap)
- [ ] The transient env file is deleted after first successful read
- [ ] On second cluster start (post-activation already ran once), the flow is a no-op — no stale env file remains

## Related
- generacy-ai/cluster-base#26 (\`code\` CLI / vscode-cli volume — adjacent to this same wizard-credential delivery seam)
- generacy-ai/generacy-cloud (to be filed) — \`REPO_URL\` is being sent as \`owner/repo\` shorthand; even if \`GH_TOKEN\` were set, \`git clone\` would still fail
- #572 (cluster ↔ cloud contract consolidation — wizard credentials delivery belongs here)

## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*

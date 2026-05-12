# Feature Specification: VS Code tunnel name exceeds 20-char limit

VS Code Desktop tunnel flow fails on fresh clusters because cluster UUID (36 chars) exceeds Microsoft's 20-character tunnel name limit.

**Branch**: `608-symptoms-even-after-604` | **Date**: 2026-05-12 | **Status**: Draft

## Summary

`loadOptionsFromEnv()` in `vscode-tunnel-manager.ts` passes the raw `GENERACY_CLUSTER_ID` (a 36-char UUID) as the tunnel name to `code tunnel --name`. Microsoft's tunnel service rejects names longer than 20 characters on first registration, causing exit code 1. Fix: derive a deterministic 20-char name (`g-` prefix + first 18 hex chars of the hyphen-stripped UUID).

## Symptoms

Even after #604/#606/#34 shipped, the VS Code Desktop tunnel flow still fails on fresh clusters. The dialog now correctly displays the error (per #606's secondary fix) — but the underlying \`code tunnel\` invocation exits with code 1.

Raw output from \`code tunnel\` captured via the dialog's "Show raw output":

\`\`\`
* Visual Studio Code Server
* By using the software, you agree to ...
[2026-05-12 21:45:29] info Using GitHub for authentication, run \`code tunnel user login --provider <provider>\` option to change this.
To grant access to the server, please log into https://github.com/login/device and use code 7217-B42C
[2026-05-12 21:45:53] info Names cannot be longer than 20 characters. Please try a different name. is an invalid name
[2026-05-12 21:45:53] error invalid name: Names cannot be longer than 20 characters. Please try a different name.
\`\`\`

## Root cause

[\`packages/control-plane/src/services/vscode-tunnel-manager.ts:loadOptionsFromEnv\`](packages/control-plane/src/services/vscode-tunnel-manager.ts) uses \`GENERACY_CLUSTER_ID\` as the tunnel name:

\`\`\`typescript
return {
  binPath: env['VSCODE_CLI_BIN'] ?? DEFAULT_VSCODE_CLI_BIN,
  tunnelName,   // ← env['GENERACY_CLUSTER_ID']
};
\`\`\`

Cluster IDs are UUIDs — 36 characters. Microsoft's tunnel name limit is **20 characters** (verified empirically; also documented as the validation rule in their CLI). When \`code tunnel --name 9e5c8a0d-755e-40b3-b0c3-43e849f0bb90 ...\` runs:

1. CLI prompts for device code → manager parses → emits \`authorization_pending\` (works)
2. User authenticates at github.com/login/device (works)
3. CLI tries to register the tunnel name with Microsoft's tunneling service → rejected with "invalid name: too long" → CLI exits code 1
4. Manager's exit handler (per #606's secondary fix) emits \`error\` event with stdout details
5. Dialog displays the error

## Fix

Two coordinated changes — cluster derives a short name, dialog uses the same derived name in the deep link.

### Cluster side (generacy)

In [\`packages/control-plane/src/services/vscode-tunnel-manager.ts\`](packages/control-plane/src/services/vscode-tunnel-manager.ts), derive a ≤20-char tunnel name from the cluster ID:

\`\`\`typescript
function deriveTunnelName(clusterId: string): string {
  // UUIDs have hyphens; strip them and take a prefix.
  // "g-" prefix makes the name recognizable as Generacy-managed.
  const compact = clusterId.replace(/-/g, '');
  return \`g-\${compact.slice(0, 18)}\`;  // 2 + 18 = 20 chars
}

export function loadOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): VsCodeTunnelManagerOptions {
  const clusterId = env['GENERACY_CLUSTER_ID'];
  if (!clusterId) throw new Error('GENERACY_CLUSTER_ID is required for VS Code tunnel');
  return {
    binPath: env['VSCODE_CLI_BIN'] ?? DEFAULT_VSCODE_CLI_BIN,
    tunnelName: deriveTunnelName(clusterId),
  };
}
\`\`\`

For a cluster ID \`9e5c8a0d-755e-40b3-b0c3-43e849f0bb90\`, this yields \`g-9e5c8a0d755e40b3b0\` — 20 chars exactly, still unique (collision space is 2^72).

### Web side (generacy-cloud — file companion issue)

[\`packages/web/src/components/clusters/VSCodeDesktopDialog.tsx:32\`](https://github.com/generacy-ai/generacy-cloud/blob/main/packages/web/src/components/clusters/VSCodeDesktopDialog.tsx#L32) constructs the deep link from the raw cluster ID:

\`\`\`typescript
const deepLink = \`vscode://vscode-remote/tunnel+\${clusterId}/\`;
\`\`\`

This will fail after the cluster-side fix because the actual tunnel name is now derived. Two options:

**(a) Cluster reports the tunnel name back via relay event** (recommended — already partially implemented). The \`cluster.vscode-tunnel\` event payload already includes \`tunnelName\` ([\`vscode-tunnel-manager.ts\`](packages/control-plane/src/services/vscode-tunnel-manager.ts)). Cloud's message-handler persists \`tunnelName\` to Firestore on \`connected\`. The dialog reads it from the cluster doc and uses it for the deep link.

**(b) Web replicates the derivation function.** Same \`deriveTunnelName()\` in shared web code. Simpler but creates coupling — if we change the derivation, both sides have to update in lockstep.

I'd ship (a). The cluster is the source of truth for what name actually got registered; the web should consume rather than recompute.

## Test plan
- [ ] After fix, fresh cluster boot → user clicks Start Tunnel → device code appears → user authorizes → CLI registers tunnel with the short name successfully → \`connected\` event fires → dialog shows "Open in VS Code Desktop" with the deep link
- [ ] Deep link \`vscode://vscode-remote/tunnel+g-<short>/\` opens VS Code Desktop and connects to the cluster's \`/workspaces/<project>\` directory
- [ ] Verify the derived name is stable across cluster restarts (same cluster ID → same derived name) — same vscode.dev URL works repeatedly
- [ ] Unit test: \`deriveTunnelName('9e5c8a0d-755e-40b3-b0c3-43e849f0bb90') === 'g-9e5c8a0d755e40b3b0'\` (deterministic 20-char output)

## Why my manual debugging "succeeded" with the full cluster ID

While investigating, I ran \`code tunnel --name <full-uuid>\` directly via \`docker exec\` and it appeared to work. The state at \`~/.vscode/cli/code_tunnel.json\` ended up with the full UUID. This is misleading: Microsoft's validation appears to enforce the 20-char limit on **first-time registration** but tolerate the longer name in subsequent invocations once \`code_tunnel.json\` already has the registration cached. The user's fresh container hits the first-time path; my repeated manual tests after the user's failed run benefited from the cached state. Confusing, but doesn't change the fix.

## Related
- #604 (re-emit on idempotent start — still needed for the auto-start race)
- #606 (CONNECTED_PATTERN + exit-during-pending error event — without #606, this bug would have looked like an infinite spinner instead of a visible error)
- generacy-ai/cluster-base#34 (volume path — still relevant for cross-restart auth persistence)
- #572 (cluster ↔ cloud contract umbrella)

## User Stories

### US1: Developer opens VS Code Desktop tunnel on fresh cluster

**As a** developer using Generacy,
**I want** the VS Code Desktop tunnel to start successfully on a fresh cluster,
**So that** I can open my workspace in VS Code Desktop via the deep link.

**Acceptance Criteria**:
- [ ] `code tunnel --name <derived>` succeeds with a 20-char-or-less name
- [ ] `connected` relay event fires with the derived `tunnelName`
- [ ] Deep link `vscode://vscode-remote/tunnel+<derived>/` opens VS Code Desktop correctly
- [ ] Derived name is deterministic: same cluster ID always produces same tunnel name

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add `deriveTunnelName(clusterId)` that strips hyphens, prefixes `g-`, takes first 18 hex chars (total 20) | P1 | `g-` prefix identifies Generacy-managed tunnels |
| FR-002 | `loadOptionsFromEnv()` calls `deriveTunnelName()` instead of passing raw cluster ID | P1 | Single call site change |
| FR-003 | Export `deriveTunnelName` for unit testing | P2 | Pure function, easy to test |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Tunnel name length | <= 20 chars | Unit test assertion |
| SC-002 | Derivation determinism | Same input -> same output | Unit test with known UUID |
| SC-003 | Fresh cluster tunnel success | `connected` event fires | Manual test on fresh cluster |

## Assumptions

- Microsoft's tunnel name limit is 20 characters (verified empirically)
- 18 hex chars (72 bits) provide sufficient collision resistance across clusters
- The `cluster.vscode-tunnel` relay event already includes `tunnelName` in its payload (confirmed in source)

## Out of Scope

- Web-side deep link fix (companion issue in generacy-cloud — option (a): read `tunnelName` from relay event)
- Replicating `deriveTunnelName()` in web code (option (b) — rejected in favor of (a))

---

*Generated by speckit*

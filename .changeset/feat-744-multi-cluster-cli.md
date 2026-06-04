---
"@generacy-ai/control-plane": minor
"@generacy-ai/orchestrator": minor
"@generacy-ai/cluster-relay": minor
"@generacy-ai/generacy": minor
---

feat: per-cluster tunnel name + identity for multi-cluster support (#744)

Adds cluster/CLI/orchestrator-side support for multiple, user-named clusters
per project.

- `deriveTunnelName` is now keyed on the per-cluster UUID (not the projectId),
  so each cluster in a project gets a distinct, ≤20-char, lowercase,
  letter-initial tunnel name. The constraint is documented next to the helper.
- `generacy launch --name <name>` (and the scaffolder) accept an optional human
  cluster name; when omitted, a default `<sanitized-project>-local-<n>` is
  generated. The name is fixed at creation and persisted into the scaffolded
  cluster identity.
- The orchestrator cluster identity now carries the cluster UUID and display
  name, surfacing the name in registration so the cloud can show it, while the
  short derived tunnel name stays decoupled from the display name.
- Deleting/stopping a cluster now unregisters/turns off its dev tunnel so the
  name is freed for reuse.

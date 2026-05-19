---
"@generacy-ai/activation-client": patch
"@generacy-ai/config": patch
"@generacy-ai/control-plane": patch
"@generacy-ai/credhelper": patch
"@generacy-ai/credhelper-daemon": patch
"@generacy-ai/generacy-plugin-claude-code": patch
"@generacy-ai/generacy-plugin-cloud-build": patch
"@generacy-ai/generacy-plugin-copilot": patch
"@generacy-ai/generacy-plugin-github-actions": patch
"@generacy-ai/generacy-plugin-github-issues": patch
"@generacy-ai/generacy-plugin-jira": patch
"@generacy-ai/knowledge-store": patch
"@generacy-ai/orchestrator": patch
"@generacy-ai/workflow-engine": patch
---

Bulk patch bump to populate the `stable` npm dist-tag for the 14 packages that were left at 0.1.0 by the previous changeset cycle (which only listed `@generacy-ai/generacy` and `@generacy-ai/cluster-relay`).

After this changeset is consumed by changesets/action and the resulting version-packages PR merges to main, all 16 public `@generacy-ai/*` packages in this repo will be on `stable` on npm.

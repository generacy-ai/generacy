# Clarifications: Publish Speckit Commands as Claude Code Marketplace Plugin

## Batch 1 — 2026-03-05

### Q1: Command Namespacing Impact
**Context**: Claude Code namespaces plugin commands by plugin name (e.g., `agency-spec-kit:specify` instead of `/specify`). The entire codebase — orchestrator workflows, CLAUDE.md references, automation scripts, and the speckit commands themselves — uses bare names like `/specify`, `/clarify`, `/plan`, `/implement`. Changing these would require widespread updates and break existing automation.
**Question**: How should command namespacing be handled — should we configure the plugin to avoid namespacing, use short aliases, or accept the namespaced names and update all references?
- A: Configure plugin to register commands without namespace prefix (if supported)
- B: Accept namespaced names (e.g., `/agency-spec-kit:specify`) and update all references across the codebase
- C: Register both namespaced and bare names so existing references continue to work

**Answer**: C — Register both namespaced and bare names so existing references (orchestrator `PHASE_TO_COMMAND`, CLAUDE.md, automation scripts) continue to work without changes.

---

### Q2: Agency MCP Server in Plugin vs Build
**Context**: Speckit commands depend on Agency MCP tools (`check_prereqs`, `manage_clarifications`, `manage_clarification_labels`, etc.). Currently `generacy setup build` configures the Agency MCP server in `~/.claude.json` separately from the command files. The plugin manifest format supports `mcpServers`, which could bundle MCP config with the plugin.
**Question**: Should the Agency MCP server configuration be included in the plugin manifest (so installing the plugin auto-configures MCP), or remain a separate step in `generacy setup build`?
- A: Include in plugin manifest — plugin install handles everything
- B: Keep separate — MCP config stays in `generacy setup build` since it depends on local agency repo paths
- C: Include in plugin manifest for marketplace installs, keep separate for fallback file-copy installs

**Answer**: C — Include MCP config in plugin manifest for marketplace installs, keep separate for fallback file-copy installs.

---

### Q3: Marketplace Repository Creation
**Context**: The #310 research decided on creating `generacy-ai/claude-plugins` as a separate marketplace repo. This repo doesn't appear to exist yet. Creating it, setting permissions, and structuring it is a prerequisite for all other work.
**Question**: Should this issue include creating the `generacy-ai/claude-plugins` repository, or does it already exist / will it be created separately?
- A: Create the repo as part of this issue's implementation
- B: The repo already exists (provide URL)
- C: Someone else will create the repo; this issue just publishes to it

**Answer**: N/A — No new repo needed. The marketplace should live in the agency repo alongside the plugin source (`agency/packages/claude-plugin-agency-spec-kit/`). This avoids the overhead of a separate repo entirely.

---

### Q4: Command Sync Workflow
**Context**: Commands live in the agency repo (`packages/claude-plugin-agency-spec-kit/commands/`) but the marketplace is a separate repo (`generacy-ai/claude-plugins`). When commands are updated in agency, they need to reach the marketplace. Without a defined process, commands will drift out of sync.
**Question**: How should command files be kept in sync between the agency repo and the marketplace repo?
- A: Manual copy — developer copies files when commands change (low frequency, acceptable overhead)
- B: CI/CD pipeline — auto-publish to marketplace repo on changes to agency command files
- C: Git submodule — marketplace repo references agency repo as a submodule
- D: Move command source of truth to the marketplace repo (agency repo references them instead)

**Answer**: N/A — Since the marketplace and plugin source are in the same repo, there is no sync problem. Commands are always in sync by definition.

---

### Q5: Version Pinning Location
**Context**: The spec requires version pinning with a `--latest` flag override. The pinned version needs to be stored somewhere that `generacy setup build` and cluster-template entrypoints can reference. Options include the marketplace manifest itself, a config file in this repo, or the cluster-templates repo.
**Question**: Where should the pinned plugin version be stored?
- A: In this repo (e.g., `generacy.config.json` or `package.json`)
- B: In the marketplace repo's manifest (version field on the plugin entry)
- C: In the cluster-templates repo's entrypoint config
- D: In `~/.claude/settings.json` after first install (let Claude Code manage it)

**Answer**: A — Pin version in this repo (e.g., `package.json` or `autodev.json`), since `generacy setup build` is the consumer.

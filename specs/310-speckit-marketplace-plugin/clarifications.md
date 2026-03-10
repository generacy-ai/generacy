# Clarifications: Publish Speckit Commands as Claude Code Marketplace Plugin

## Batch 1 — 2026-03-05

### Q1: Claude Code Plugin System Existence
**Context**: The entire feature assumes `claude plugin install` exists as a first-class mechanism in Claude Code. If this doesn't exist yet, the scope changes dramatically.
**Question**: Does Claude Code currently have a plugin marketplace/install system (`claude plugin install`), or does this feature require building a custom distribution mechanism?
- A: Claude Code has an existing plugin install system we can publish to
- B: We need to build a lightweight custom distribution mechanism
- C: We should research and prototype both approaches before deciding

**Answer**: A — Claude Code has an existing `claude plugin install` / `claude plugin marketplace` system. We confirmed it works in the worker container (`claude plugin marketplace add`, `claude plugin install <name>@<marketplace>`).

---

### Q2: Marketplace Visibility and Access
**Context**: This determines hosting infrastructure, authentication requirements, and whether we need to handle private repo access tokens during installation.
**Question**: Should the marketplace/plugin repository be public or private?
- A: Public — open source, anyone can install
- B: Private — restricted to team members with GitHub access
- C: Start private, plan to make public later

**Answer**: B — Start private, restricted to team members with GitHub access. The agency repo is private, and this is for Generacy's internal workflow initially.

---

### Q3: Conflict Resolution Strategy
**Context**: During migration, developers may have both file-copy commands and marketplace-installed commands causing confusing behavior.
**Question**: When transitioning from file-copy to marketplace installation, should `generacy setup build` actively remove old file-copy commands, or leave both?
- A: Clean up old file-copy commands during marketplace install
- B: Leave both, document that marketplace takes precedence
- C: Add a migration command that handles the transition explicitly

**Answer**: A — Clean up old file-copy commands during marketplace install. Having both creates unpredictable behavior. `generacy setup build` should detect marketplace-installed versions and skip file-copy, or remove stale file-copy commands when transitioning.

---

### Q4: Version Pinning vs Latest
**Context**: If `generacy setup build` always installs latest, teams could get inconsistent behavior. If it pins a version, there needs to be an update mechanism.
**Question**: Should `generacy setup build` and cluster-template entrypoints install a pinned version or always pull latest?
- A: Always install latest version
- B: Pin version in a config file
- C: Pin by default, with a `--latest` flag to override

**Answer**: C — Pin version by default (in a config file), with a `--latest` flag to override. This ensures consistency across team environments while allowing explicit upgrades.

---

### Q5: Offline/Fallback Behavior
**Context**: The current file-copy approach works offline. If the marketplace is unreachable, `generacy setup build` could fail entirely.
**Question**: If the marketplace is unreachable during `generacy setup build`, what should happen?
- A: Fall back to file-copy from agency repo if available, error otherwise
- B: Fail with clear error message (no fallback)
- C: Cache last successful install locally and use that as fallback

**Answer**: A — Fall back to file-copy from agency repo if available, error otherwise. The current file-copy approach is a reliable offline fallback.

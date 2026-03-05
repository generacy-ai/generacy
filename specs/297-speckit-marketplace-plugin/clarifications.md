# Clarifications: Feature 297 - Speckit Marketplace Plugin

## Batch 1 — 2026-03-05

### Q1: Claude Code Plugin System Existence
**Context**: The entire feature assumes `claude plugin install` exists as a first-class mechanism in Claude Code. If this doesn't exist yet, the scope changes dramatically — we'd need to either build a custom distribution mechanism or wait for official plugin marketplace support.
**Question**: Does Claude Code currently have a plugin marketplace/install system (`claude plugin install`), or does this feature require building a custom distribution mechanism (e.g., a shell script that downloads and copies command files)?
**Options**:
- A: Claude Code has an existing plugin install system we can publish to
- B: We need to build a lightweight custom distribution mechanism (e.g., GitHub release download + copy)
- C: We should research and prototype both approaches before deciding

**Answer**: *Pending*

### Q2: Marketplace Visibility and Access
**Context**: This determines hosting infrastructure, authentication requirements, and whether we need to handle private repo access tokens during installation.
**Question**: Should the marketplace/plugin repository be public (anyone can install) or private (requires GitHub auth or token)?
**Options**:
- A: Public — open source, anyone can install
- B: Private — restricted to team members with GitHub access
- C: Start private, plan to make public later

**Answer**: *Pending*

### Q3: Conflict Resolution Strategy
**Context**: During migration, developers may have both file-copy commands (from `generacy setup build`) and marketplace-installed commands. If both exist, Claude Code may load duplicates or pick one unpredictably, causing confusing behavior.
**Question**: When transitioning from file-copy to marketplace installation, should `generacy setup build` actively remove old file-copy commands, or should it leave both and let the marketplace version take precedence?
**Options**:
- A: Clean up old file-copy commands during marketplace install
- B: Leave both, document that marketplace takes precedence
- C: Add a migration command that handles the transition explicitly

**Answer**: *Pending*

### Q4: Version Pinning vs Latest
**Context**: If `generacy setup build` always installs latest, teams could get inconsistent behavior. If it pins a version, there needs to be an update mechanism. This affects both the build script and cluster-template entrypoints.
**Question**: Should `generacy setup build` and cluster-template entrypoints install a pinned version of the plugin or always pull the latest?
**Options**:
- A: Always install latest version
- B: Pin version in a config file (e.g., package.json or a dedicated config)
- C: Pin by default, with a `--latest` flag to override

**Answer**: *Pending*

### Q5: Offline/Fallback Behavior
**Context**: The current file-copy approach works offline. If the marketplace is unreachable (network issues, GitHub outage), `generacy setup build` could fail entirely, blocking development environment setup.
**Question**: If the marketplace is unreachable during `generacy setup build`, should it fall back to file-copy from the agency repo (if available), fail with a clear error, or cache the last successful install?
**Options**:
- A: Fall back to file-copy from agency repo if available, error otherwise
- B: Fail with clear error message (no fallback)
- C: Cache last successful install locally and use that as fallback

**Answer**: *Pending*

# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-01-20 16:41

### Q1: Installation ID Discovery
**Context**: GitHub Apps require an Installation ID to generate access tokens. The plugin needs to know which installation to use, which could either be auto-discovered from the repository or provided as configuration.
**Question**: Should the plugin auto-discover the Installation ID by querying the GitHub API for the App's installations, or should it be provided explicitly in the configuration?
**Options**:
- A: Auto-discover from repository (simpler config, but requires an additional API call)
- B: Require explicit Installation ID in config (faster startup, more predictable)
- C: Support both - try config first, fall back to auto-discovery

**Answer**: A - Auto-discover the Installation ID by querying the GitHub API for the App's installations (simpler config, but requires an additional API call). [Answered by @christrudelpw on GitHub](https://github.com/generacy-ai/generacy/issues/41#issuecomment-3773918981)

### Q2: Token Refresh Strategy
**Context**: Installation access tokens expire after 1 hour. The refresh strategy affects reliability and API usage.
**Question**: When should tokens be refreshed - proactively before expiry (e.g., at 50 minutes) or reactively when a 401 error is received?
**Options**:
- A: Proactive refresh at 50 minutes (prevents any 401 errors, slightly more token generations)
- B: Reactive refresh on 401 (fewer token generations, but may cause brief interruptions)

**Answer**: A - Proactive refresh at 50 minutes (prevents any 401 errors, slightly more token generations). [Answered by @christrudelpw on GitHub](https://github.com/generacy-ai/generacy/issues/41#issuecomment-3773918981)

### Q3: Configuration Format
**Context**: GitHub App authentication requires App ID and Private Key. The private key is a multi-line PEM file that needs secure handling.
**Question**: How should the GitHub App credentials be configured?
**Options**:
- A: Environment variables (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY)
- B: Config file path for private key + env var for App ID
- C: Support multiple formats (env vars, file path, or inline in config)

**Answer**: C - Support multiple formats (env vars, file path, or inline in config). [Answered by @christrudelpw on GitHub](https://github.com/generacy-ai/generacy/issues/41#issuecomment-3773918981)

### Q4: Auth Fallback Behavior
**Context**: The plugin should maintain backward compatibility with PAT tokens. Need to define behavior when both auth methods are configured or when App auth fails.
**Question**: If both PAT and GitHub App credentials are provided, which should take precedence? And should there be automatic fallback if the preferred method fails?
**Options**:
- A: GitHub App takes precedence, no fallback (fail fast, explicit behavior)
- B: GitHub App takes precedence, fallback to PAT on failure (maximum availability)
- C: User configures precedence explicitly via config option

**Answer**: B - GitHub App takes precedence, with automatic fallback to PAT on failure (maximum availability). [Answered by @christrudelpw on GitHub](https://github.com/generacy-ai/generacy/issues/41#issuecomment-3773918981)


# Feature Specification: Add GitHub App authentication support to GitHub Issues plugin

**Branch**: `041-add-github-app-authentication` | **Date**: 2026-01-20 | **Status**: Clarified

## Summary

Add GitHub App authentication as an alternative to PAT tokens in the GitHub Issues plugin, providing higher rate limits, better security, and bot identity for automated actions.

## Description

Add support for GitHub App authentication as an alternative to PAT tokens in the `@generacy-ai/generacy-plugin-github-issues` plugin.

## Use Case

GitHub Apps provide better security and higher rate limits than PAT tokens:
- Higher rate limits (5,000 requests/hour per installation vs 5,000/hour shared across all PAT usage)
- Granular repository permissions
- Bot identity for actions (shows as `app-name[bot]`)
- No tie to a specific user account
- Better for production/enterprise use

## Acceptance Criteria

- [ ] Support GitHub App authentication via App ID + Private Key
- [ ] Auto-generate installation access tokens
- [ ] Cache tokens appropriately (they expire after 1 hour)
- [ ] Auto-refresh tokens before expiry
- [ ] Maintain backward compatibility with PAT authentication
- [ ] Document setup process for GitHub App creation

## Clarified Decisions

Based on clarification responses:

### Installation ID Discovery
**Decision**: Auto-discover from repository (Option A)
- The plugin will query the GitHub API to discover the Installation ID automatically
- Simpler configuration for users (no need to find/provide Installation ID)
- Trade-off: Requires an additional API call during initialization

### Token Refresh Strategy
**Decision**: Proactive refresh at 50 minutes (Option A)
- Tokens will be refreshed proactively before expiry (at ~50 minutes into the 60-minute lifetime)
- Prevents any 401 errors during normal operation
- Slightly more token generations but better reliability

### Configuration Format
**Decision**: Support multiple formats (Option C)
- Environment variables: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`
- File path: `GITHUB_APP_PRIVATE_KEY_PATH` pointing to PEM file
- Inline config: Direct configuration in plugin options
- Maximum flexibility for different deployment scenarios

### Auth Fallback Behavior
**Decision**: GitHub App precedence with PAT fallback (Option B)
- When both auth methods are configured, GitHub App takes precedence
- If GitHub App auth fails, automatically fall back to PAT
- Maximum availability while preferring the better auth method

## User Stories

### US1: Configure GitHub App Authentication

**As a** DevOps engineer,
**I want** to configure the plugin with GitHub App credentials,
**So that** I get higher rate limits and better security for production use.

**Acceptance Criteria**:
- [ ] Can provide App ID and Private Key via environment variables
- [ ] Can provide Private Key via file path
- [ ] Can provide credentials inline in plugin configuration
- [ ] Plugin validates credentials on initialization

### US2: Seamless Token Management

**As a** developer using the plugin,
**I want** tokens to be managed automatically,
**So that** I don't experience authentication failures during long-running operations.

**Acceptance Criteria**:
- [ ] Installation ID is auto-discovered from the repository
- [ ] Access tokens are generated automatically
- [ ] Tokens are refreshed before expiry (at 50 minutes)
- [ ] Token refresh is transparent to API consumers

### US3: Backward Compatibility

**As an** existing user with PAT configuration,
**I want** my current setup to continue working,
**So that** I can migrate to GitHub App auth at my own pace.

**Acceptance Criteria**:
- [ ] Existing PAT configuration continues to work unchanged
- [ ] When both are configured, GitHub App is preferred
- [ ] Automatic fallback to PAT if GitHub App auth fails
- [ ] Clear logging indicates which auth method is active

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Accept GitHub App credentials via multiple formats | P1 | Env vars, file path, inline config |
| FR-002 | Generate JWT from App ID + Private Key | P1 | Required for GitHub App API |
| FR-003 | Auto-discover Installation ID from repository | P1 | Query `/app/installations` endpoint |
| FR-004 | Generate Installation Access Token | P1 | POST to `/app/installations/{id}/access_tokens` |
| FR-005 | Cache tokens with expiry tracking | P1 | Track `expires_at` from response |
| FR-006 | Proactive token refresh at 50 minutes | P1 | Prevent auth failures |
| FR-007 | Fall back to PAT if App auth fails | P2 | When both configured |
| FR-008 | Log active authentication method | P2 | For debugging/transparency |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Auth failures due to token expiry | 0 | No 401 errors from expired tokens |
| SC-002 | Backward compatibility | 100% | All existing PAT tests pass |
| SC-003 | Configuration flexibility | 3 formats | Env, file, inline all work |

## Assumptions

- Users have already created a GitHub App with appropriate permissions
- Private key PEM files are accessible to the plugin process
- The GitHub App is installed on the target repository

## Out of Scope

- GitHub App creation wizard/automation
- OAuth web flow for GitHub Apps
- Fine-grained permission configuration UI
- Multi-organization Installation ID management

---

*Generated by speckit*

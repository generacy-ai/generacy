# Implementation Plan: GitHub App Authentication Support

**Feature**: Add GitHub App authentication as an alternative to PAT tokens
**Branch**: `041-add-github-app-authentication`
**Status**: Complete

## Summary

Extend the `@generacy-ai/generacy-plugin-github-issues` package to support GitHub App authentication alongside existing PAT token auth. This provides higher rate limits (5,000 req/hr per installation), bot identity, and better security for production use.

## Technical Context

- **Language**: TypeScript 5.7
- **Runtime**: Node.js 20+
- **Package**: `@generacy-ai/generacy-plugin-github-issues`
- **Dependencies**:
  - `@octokit/rest` (existing) - GitHub REST API client
  - `@octokit/auth-app` (new) - GitHub App authentication
  - `zod` (existing) - Schema validation

## Project Structure

```
packages/github-issues/
├── src/
│   ├── auth/
│   │   ├── index.ts              # Auth module exports
│   │   ├── types.ts              # Auth configuration types
│   │   ├── github-app.ts         # GitHub App auth implementation
│   │   ├── token-cache.ts        # Token caching with expiry
│   │   └── auth-factory.ts       # Auth strategy factory
│   ├── client.ts                 # Modified to use auth factory
│   ├── types/
│   │   └── config.ts             # Extended config types
│   └── utils/
│       └── errors.ts             # New auth-specific errors
└── tests/
    └── unit/
        └── auth/
            ├── github-app.test.ts
            ├── token-cache.test.ts
            └── auth-factory.test.ts
```

## Architecture

### Authentication Strategy Pattern

```
┌─────────────────────────────────────────────────────────────┐
│                     GitHubClient                             │
├─────────────────────────────────────────────────────────────┤
│                    AuthFactory                               │
│  ┌─────────────────┐        ┌─────────────────────┐        │
│  │   PAT Auth      │   OR   │  GitHub App Auth    │        │
│  │  (existing)     │        │  ┌───────────────┐  │        │
│  └─────────────────┘        │  │ TokenCache    │  │        │
│                             │  │ (50min TTL)   │  │        │
│                             │  └───────────────┘  │        │
│                             └─────────────────────┘        │
└─────────────────────────────────────────────────────────────┘
```

### Token Lifecycle

```
1. Initialization
   ├── Read App ID + Private Key (env/file/inline)
   ├── Generate JWT (for app-level API calls)
   └── Auto-discover Installation ID from repository

2. First Request
   ├── Generate Installation Access Token
   ├── Cache token with expires_at
   └── Return token to Octokit

3. Token Refresh (at 50 minutes)
   ├── Timer triggers refresh
   ├── Generate new Installation Access Token
   └── Update cache seamlessly
```

## Implementation Phases

### Phase 1: Core Auth Module
- Create auth types and interfaces
- Implement GitHub App JWT generation
- Implement Installation ID auto-discovery
- Implement token cache with expiry tracking

### Phase 2: Integration
- Create auth factory for strategy selection
- Modify GitHubClient to use auth factory
- Extend configuration types
- Add validation for new config options

### Phase 3: Proactive Refresh
- Implement 50-minute refresh timer
- Handle refresh failures gracefully
- Implement PAT fallback when both configured

### Phase 4: Testing & Documentation
- Unit tests for auth module
- Integration tests for token lifecycle
- Update quickstart documentation

## Key Technical Decisions

1. **Use @octokit/auth-app**: Official Octokit auth library handles JWT generation and token management
2. **In-memory token cache**: Simple Map-based cache with TTL tracking
3. **50-minute refresh threshold**: Proactive refresh 10 minutes before 1-hour expiry
4. **Strategy pattern**: Clean separation between PAT and App auth
5. **Backward compatible config**: Extend existing `GitHubIssuesConfig` interface

## Dependencies

Add to `package.json`:
```json
{
  "dependencies": {
    "@octokit/auth-app": "^7.1.1"
  }
}
```

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Token refresh race condition | Use mutex/lock during refresh |
| Installation ID discovery failure | Clear error message with troubleshooting |
| Private key format issues | Support both PKCS#1 and PKCS#8 formats |
| Network failure during refresh | Retry with exponential backoff |

## Success Criteria

- [ ] GitHub App auth works with env vars, file path, and inline config
- [ ] Installation ID auto-discovered without user input
- [ ] Zero 401 errors from token expiry during normal operation
- [ ] Existing PAT tests continue to pass
- [ ] Fallback to PAT works when App auth fails

## Next Steps

Run `/speckit:tasks` to generate the task breakdown.

# Research: GitHub App Authentication

## Technology Decisions

### 1. Authentication Library: @octokit/auth-app

**Decision**: Use `@octokit/auth-app` for GitHub App authentication

**Rationale**:
- Official Octokit library maintained by GitHub
- Handles JWT generation, installation token fetching, and token caching
- Type-safe with full TypeScript support
- Already compatible with `@octokit/rest` used in the plugin

**Alternatives Considered**:
- **Manual JWT generation**: More control but requires maintaining crypto code
- **jsonwebtoken + manual API calls**: Extra dependency and more code to maintain
- **@octokit/auth-token**: Too basic, doesn't support App auth

### 2. Token Caching Strategy

**Decision**: Use @octokit/auth-app's built-in caching with custom refresh timer

**Rationale**:
- `@octokit/auth-app` handles token caching internally
- We add a 50-minute proactive refresh timer for extra reliability
- Avoids race conditions from multiple concurrent token requests

**Implementation Pattern**:
```typescript
import { createAppAuth } from '@octokit/auth-app';

const auth = createAppAuth({
  appId: APP_ID,
  privateKey: PRIVATE_KEY,
  installationId: INSTALLATION_ID, // or use installationId fetching
});

// Get installation token (cached automatically)
const installationAuth = await auth({ type: 'installation' });
```

### 3. Installation ID Discovery

**Decision**: Auto-discover using `/app/installations` endpoint with repo filter

**Rationale**:
- Simplifies user configuration (no need to find Installation ID)
- Single API call during initialization
- Works for both user and organization repositories

**API Flow**:
```
1. Generate JWT with App credentials
2. GET /app/installations
3. Filter by repository owner/name
4. Cache Installation ID for session
```

### 4. Configuration Format

**Decision**: Support three input formats for maximum flexibility

| Format | Use Case | Example |
|--------|----------|---------|
| Environment Variables | CI/CD, Docker | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` |
| File Path | Local dev, mounted secrets | `privateKeyPath: '/secrets/app.pem'` |
| Inline Config | Programmatic use | `privateKey: '-----BEGIN...'` |

### 5. Auth Strategy Selection

**Decision**: GitHub App takes precedence when both configured, with PAT fallback

**Logic**:
```
1. If GitHub App credentials present → Use App auth
2. If App auth fails AND PAT configured → Fall back to PAT
3. If only PAT configured → Use PAT auth
4. If nothing configured → Throw configuration error
```

## Implementation Patterns

### Strategy Pattern for Auth

```typescript
interface AuthStrategy {
  getToken(): Promise<string>;
  verify(): Promise<{ login: string; id: number }>;
}

class PATAuthStrategy implements AuthStrategy { ... }
class GitHubAppAuthStrategy implements AuthStrategy { ... }

function createAuthStrategy(config: AuthConfig): AuthStrategy {
  if (hasAppCredentials(config)) {
    return new GitHubAppAuthStrategy(config);
  }
  return new PATAuthStrategy(config);
}
```

### Proactive Token Refresh

```typescript
class TokenRefreshManager {
  private refreshTimer: NodeJS.Timeout | null = null;

  scheduleRefresh(expiresAt: Date): void {
    const refreshTime = expiresAt.getTime() - 10 * 60 * 1000; // 10 min before
    const delay = refreshTime - Date.now();

    this.refreshTimer = setTimeout(() => this.refresh(), delay);
  }

  private async refresh(): Promise<void> {
    // Generate new token and update cache
  }
}
```

## Key Sources

1. **GitHub App Authentication Docs**: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app
2. **@octokit/auth-app**: https://github.com/octokit/auth-app.js
3. **Installation Access Tokens**: https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token

## API Endpoints Used

| Endpoint | Purpose | Auth Required |
|----------|---------|---------------|
| `GET /app/installations` | List installations | JWT |
| `GET /app/installations/{id}` | Get installation details | JWT |
| `POST /app/installations/{id}/access_tokens` | Generate installation token | JWT |
| `GET /installation/repositories` | List accessible repos | Installation Token |

## Security Considerations

1. **Private Key Storage**: Never log or expose private key content
2. **Token Logging**: Mask tokens in logs (show only last 4 chars)
3. **Environment Variables**: Prefer `GITHUB_APP_PRIVATE_KEY_PATH` over inline key
4. **Memory**: Clear private key from memory after JWT generation if possible

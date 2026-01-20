# Quickstart: GitHub App Authentication

## Prerequisites

1. A GitHub App created in your organization or user account
2. The GitHub App installed on the target repository
3. The App's private key (PEM file)

## Creating a GitHub App

1. Go to **Settings > Developer settings > GitHub Apps**
2. Click **New GitHub App**
3. Configure:
   - **Name**: `your-org-generacy-bot` (must be unique)
   - **Homepage URL**: Your organization URL
   - **Webhook**: Uncheck "Active" (not needed for API-only use)
   - **Permissions**:
     - Repository: Issues (Read & Write)
     - Repository: Pull requests (Read & Write)
     - Repository: Contents (Read)
4. Click **Create GitHub App**
5. Note the **App ID** shown on the app page
6. Generate a **Private Key** and save the `.pem` file

## Installing the App

1. On the App settings page, click **Install App**
2. Select the repository or organization
3. Choose "All repositories" or "Only select repositories"
4. Confirm installation

## Configuration

### Option 1: Environment Variables (Recommended for CI/CD)

```bash
export GITHUB_APP_ID=123456
export GITHUB_APP_PRIVATE_KEY_PATH=/path/to/private-key.pem
# OR inline (not recommended for production)
export GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
...
-----END RSA PRIVATE KEY-----"
```

```typescript
import { createClient } from '@generacy-ai/generacy-plugin-github-issues';

const client = createClient({
  owner: 'your-org',
  repo: 'your-repo',
  // Credentials loaded from environment automatically
});
```

### Option 2: File Path

```typescript
import { createClient } from '@generacy-ai/generacy-plugin-github-issues';

const client = createClient({
  owner: 'your-org',
  repo: 'your-repo',
  app: {
    appId: 123456,
    privateKeyPath: '/path/to/private-key.pem',
  },
});
```

### Option 3: Inline Configuration

```typescript
import { createClient } from '@generacy-ai/generacy-plugin-github-issues';
import { readFileSync } from 'fs';

const client = createClient({
  owner: 'your-org',
  repo: 'your-repo',
  app: {
    appId: 123456,
    privateKey: readFileSync('/path/to/private-key.pem', 'utf-8'),
  },
});
```

### Mixed Configuration (App + PAT Fallback)

```typescript
const client = createClient({
  owner: 'your-org',
  repo: 'your-repo',
  app: {
    appId: 123456,
    privateKeyPath: '/path/to/private-key.pem',
  },
  token: process.env.GITHUB_TOKEN, // Fallback PAT
});
```

## Verifying Authentication

```typescript
const client = createClient({ /* config */ });

// Verify auth works
const auth = await client.verifyAuth();
console.log(`Authenticated as: ${auth.login}`);
// Output: "Authenticated as: your-app-name[bot]"

// Check rate limit (should show higher limits with App auth)
const rateLimit = await client.getRateLimit();
console.log(`Rate limit: ${rateLimit.remaining}/${rateLimit.limit}`);
```

## Troubleshooting

### "Installation not found"

- Verify the App is installed on the repository
- Check the App has the required permissions
- Ensure `owner` and `repo` match exactly (case-sensitive)

### "Bad credentials" / "JWT expired"

- Check the App ID is correct
- Verify the private key hasn't been regenerated
- Ensure the system clock is accurate (JWT validation is time-sensitive)

### "Private key format error"

- Ensure the key file is in PEM format
- Check for extra whitespace or missing newlines
- Both PKCS#1 and PKCS#8 formats are supported

### Rate Limit Not Higher

- Confirm you're using App auth (check `verifyAuth()` shows `[bot]`)
- Installation tokens have per-repository rate limits
- Shared installations may have lower effective limits

## Security Best Practices

1. **Never commit private keys** - Use environment variables or mounted secrets
2. **Rotate keys periodically** - Generate new keys and update deployments
3. **Minimal permissions** - Only grant the permissions your app needs
4. **Audit installations** - Regularly review where the app is installed

---
sidebar_position: 3
---

# Authentication

Generacy requires credentials for GitHub and Anthropic to function. This page walks you through creating and storing each credential.

## Credentials Overview

| Credential | Purpose | Required For | Where to Get It |
|------------|---------|-------------|-----------------|
| **GitHub PAT** | Repository access, creating PRs, managing issues | All levels | [github.com/settings/tokens](https://github.com/settings/tokens/new) |
| **Anthropic API Key** | AI agent capabilities via Anthropic API | All levels (API plan) | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| **Claude OAuth Token** | AI agent capabilities via Claude Max/Pro subscription | All levels (subscription) | Extracted from macOS Keychain — see [Claude Subscription Auth](./claude-subscription-auth.md) |
| **OAuth sign-in** | Web dashboard access at generacy.ai | Level 2+ | [generacy.ai](https://generacy.ai) |

## GitHub Personal Access Token (PAT)

Generacy uses a GitHub PAT to read repositories, create branches, and open pull requests on your behalf.

### Create a classic PAT

1. Go to [github.com/settings/tokens/new](https://github.com/settings/tokens/new)
2. Give the token a descriptive name (e.g., `generacy-dev`)
3. Set an expiration (90 days recommended — you can regenerate later)
4. Select the following scopes:
   - **`repo`** — full control of private repositories (read/write access to code, PRs, issues)
   - **`workflow`** — update GitHub Actions workflows
5. Click **Generate token**
6. Copy the token immediately — you won't be able to see it again

:::caution
If your token is missing the `repo` or `workflow` scopes, `generacy doctor` will warn you. You can update scopes at any time from [github.com/settings/tokens](https://github.com/settings/tokens).
:::

### Alternative: Fine-grained PAT

GitHub also supports [fine-grained personal access tokens](https://github.com/settings/personal-access-tokens/new) with more granular permissions. If you prefer fine-grained tokens, grant **Read and Write** access to:

- **Contents** — read/write repository files
- **Pull requests** — create and manage PRs
- **Metadata** — read repository metadata (automatically included)
- **Workflows** — trigger and manage GitHub Actions

Scope the token to the specific repositories Generacy will manage.

### Alternative: GitHub CLI

If you have the [GitHub CLI](https://cli.github.com/) installed, Generacy can use its credentials as a fallback:

```bash
gh auth login
```

Generacy checks for credentials in this order:
1. `GITHUB_TOKEN` environment variable
2. `gh auth token` (GitHub CLI)

For production use, an explicit `GITHUB_TOKEN` in your env file is recommended.

## Anthropic / Claude Credentials

Generacy supports two ways to authenticate Claude agents. Use whichever matches your plan.

### Option A — Anthropic API Key (recommended for teams)

Use an API key if you have an [Anthropic API account](https://console.anthropic.com) with a billing plan.

1. Go to [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
2. Sign in or create an Anthropic account
3. Click **Create Key**
4. Give the key a name (e.g., `generacy-dev`)
5. Copy the key immediately — it won't be shown again
6. Set it in your `.env.local`:
   ```env
   ANTHROPIC_API_KEY=sk-ant-api03-...
   ```

:::tip
Make sure your Anthropic account has available credits or an active billing plan. API calls will fail if your account has no credit balance.
:::

### Option B — Claude Max / Pro Subscription (local cluster only)

If you have a Claude Max or Pro subscription you can use your OAuth bearer token instead — no separate API credits required.

Set `ANTHROPIC_AUTH_TOKEN` (leave `ANTHROPIC_API_KEY` empty):

```env title=".devcontainer/generacy/.env.local"
ANTHROPIC_API_KEY=
ANTHROPIC_AUTH_TOKEN=sk-ant-oat01-...
```

OAuth tokens are short-lived and stored in the macOS Keychain, so there is an extra extraction step. See the full walk-through in [Using Claude Subscription Credits](./claude-subscription-auth.md).

## OAuth Sign-In (Level 2+)

For Level 2 and above, you'll access the Generacy web dashboard to manage review gates, approval workflows, and team settings.

1. Navigate to [generacy.ai](https://generacy.ai) in your browser
2. Click **Sign In**
3. Authenticate with your GitHub account via OAuth
4. Authorize the Generacy application when prompted

<!-- Screenshot placeholder: OAuth sign-in flow -->

OAuth sign-in is not required for Level 1 (Agency Only). You can skip this step if you're starting with Level 1.

## Store Credentials Securely

After running `generacy init` (covered in [Project Setup](./project-setup.md)), your project will have a `.generacy/generacy.env.template` file. Copy it and fill in your credentials:

```bash
cp .generacy/generacy.env.template .generacy/generacy.env
```

Open `.generacy/generacy.env` and set your tokens:

```bash
# GitHub Personal Access Token (PAT) with repo permissions
# Minimum scopes: repo, workflow
GITHUB_TOKEN=ghp_your_token_here

# Anthropic API key for Claude Code agent (Option A — API plan)
# Leave blank if using ANTHROPIC_AUTH_TOKEN below
ANTHROPIC_API_KEY=sk-ant-your_key_here

# OAuth bearer token for Claude Max/Pro subscription (Option B — subscription)
# See: getting-started/claude-subscription-auth
ANTHROPIC_AUTH_TOKEN=
```

:::danger Never commit credentials
The `.generacy/generacy.env` file is automatically gitignored. **Do not** commit it to version control or share it in public channels. If you accidentally expose a token, revoke it immediately and generate a new one.
:::

## Verify Your Credentials

After storing your credentials, you can verify them with:

```bash
generacy doctor
```

The doctor command checks that your `GITHUB_TOKEN` is valid and has the required scopes, and that your `ANTHROPIC_API_KEY` can authenticate with the Anthropic API. See [Verify Setup](./verify-setup.md) for full details.

## Next Steps

With your credentials configured, proceed to [Project Setup](./project-setup.md) to initialize Generacy in your project.

If you are using a Claude Max or Pro subscription rather than an API key, continue to [Using Claude Subscription Credits](./claude-subscription-auth.md).

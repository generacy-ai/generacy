# Quickstart: @generacy-ai/generacy-plugin-github-issues

## Installation

```bash
npm install @generacy-ai/generacy-plugin-github-issues
```

## Basic Usage

### Initialize the Plugin

```typescript
import { GitHubIssuesPlugin } from '@generacy-ai/generacy-plugin-github-issues';

const github = new GitHubIssuesPlugin({
  owner: 'your-org',
  repo: 'your-repo',
  token: process.env.GITHUB_TOKEN!,
});
```

### Issue Operations

```typescript
// Create an issue
const issue = await github.createIssue({
  title: 'Bug: Login fails on mobile',
  body: '## Description\n\nUsers cannot log in on mobile devices.',
  labels: ['bug', 'mobile'],
});

// Get an issue
const existing = await github.getIssue(42);

// Update an issue
await github.updateIssue(42, {
  title: 'Bug: Login fails on mobile Safari',
  labels: ['bug', 'mobile', 'safari'],
});

// Close an issue
await github.closeIssue(42);

// Search issues
const bugs = await github.searchIssues('is:open label:bug');

// List issues with filter
const myIssues = await github.listIssues({
  state: 'open',
  assignee: 'me',
  labels: ['priority:high'],
});
```

### Label Management

```typescript
// Add labels
await github.addLabels(42, ['needs-review', 'documentation']);

// Remove labels
await github.removeLabels(42, ['wip']);
```

### Comments

```typescript
// Add a comment
const comment = await github.addComment(42, 'Build completed successfully! ');

// List comments
const comments = await github.listComments(42);
```

### Pull Request Linking

```typescript
// Link a PR to an issue
await github.linkPullRequest(42, 123);

// Get linked PRs
const linkedPRs = await github.getLinkedPRs(42);
```

## Webhook Handling

### Process Webhook Events

```typescript
import { GitHubIssuesPlugin, WebhookEvent } from '@generacy-ai/generacy-plugin-github-issues';

const github = new GitHubIssuesPlugin({
  owner: 'your-org',
  repo: 'your-repo',
  token: process.env.GITHUB_TOKEN!,
  agentAccount: 'my-bot',
  triggerLabels: ['autodev:ready'],
});

// Process a webhook event
const event: WebhookEvent = {
  name: 'issues',
  payload: { action: 'assigned', issue: { number: 42 }, assignee: { login: 'my-bot' } },
};

const action = await github.handleWebhook(event);

if (action) {
  switch (action.type) {
    case 'queue_for_processing':
      console.log(`Queue issue #${action.issueNumber} for processing`);
      break;
    case 'start_workflow':
      console.log(`Start workflow for issue #${action.issueNumber}`);
      break;
    case 'resume_workflow':
      console.log(`Resume workflow for issue #${action.issueNumber}`);
      break;
  }
}
```

### With Fastify Server

```typescript
import Fastify from 'fastify';
import { createHmac } from 'crypto';

const app = Fastify();

app.post('/webhook', async (request, reply) => {
  // Verify signature
  const signature = request.headers['x-hub-signature-256'];
  const payload = JSON.stringify(request.body);
  const expected = `sha256=${createHmac('sha256', process.env.WEBHOOK_SECRET!)
    .update(payload)
    .digest('hex')}`;

  if (signature !== expected) {
    return reply.status(401).send('Invalid signature');
  }

  // Handle event
  const event = {
    name: request.headers['x-github-event'] as string,
    payload: request.body,
    deliveryId: request.headers['x-github-delivery'] as string,
  };

  const action = await github.handleWebhook(event);

  if (action?.type !== 'no_action') {
    // Process the action (e.g., add to queue)
  }

  return reply.status(200).send('OK');
});
```

## Configuration Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `owner` | `string` | Yes | Repository owner |
| `repo` | `string` | Yes | Repository name |
| `token` | `string` | Yes | GitHub PAT or installation token |
| `webhookSecret` | `string` | No | Secret for webhook signature verification |
| `agentAccount` | `string` | No | Bot account username for assignment detection |
| `triggerLabels` | `string[]` | No | Labels that trigger workflows |
| `baseUrl` | `string` | No | Custom API URL for GitHub Enterprise |

## Environment Variables

```bash
# Required
GITHUB_TOKEN=ghp_xxxxxxxxxxxx

# Optional
GITHUB_WEBHOOK_SECRET=your-webhook-secret
GITHUB_AGENT_ACCOUNT=your-bot-username
```

## Error Handling

```typescript
import {
  GitHubAuthError,
  GitHubRateLimitError,
  GitHubNotFoundError,
  GitHubValidationError,
} from '@generacy-ai/generacy-plugin-github-issues';

try {
  await github.getIssue(99999);
} catch (error) {
  if (error instanceof GitHubNotFoundError) {
    console.log('Issue not found');
  } else if (error instanceof GitHubRateLimitError) {
    console.log(`Rate limited. Retry after: ${error.resetTime}`);
  } else if (error instanceof GitHubAuthError) {
    console.log('Invalid token');
  }
}
```

## Troubleshooting

### "Bad credentials" Error

Your token may be invalid or expired. Generate a new PAT with the required scopes:
- `repo` - Full repository access
- `write:discussion` - Comment on issues

### Rate Limiting

The plugin handles rate limiting automatically with exponential backoff. If you're frequently hitting limits:
- Use a GitHub App for higher limits
- Cache responses where possible
- Reduce polling frequency

### Webhook Events Not Received

1. Verify the webhook URL is accessible from the internet
2. Check the webhook secret matches your configuration
3. Ensure the events you need are selected in repository settings

---

*Generated by speckit*

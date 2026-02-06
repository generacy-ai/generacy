# Quickstart: @generacy-ai/generacy-plugin-jira

## Installation

```bash
pnpm add @generacy-ai/generacy-plugin-jira
```

## Configuration

Create a Jira API token at [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens).

```typescript
import { createPlugin, type JiraConfig } from '@generacy-ai/generacy-plugin-jira';

const config: JiraConfig = {
  host: 'your-company.atlassian.net',
  email: 'your-email@company.com',
  apiToken: process.env.JIRA_API_TOKEN!,
  projectKey: 'PROJ', // Optional default project
};

const jira = createPlugin(config);
```

## Basic Usage

### Create an Issue

```typescript
const issue = await jira.createIssue({
  projectKey: 'PROJ',
  summary: 'Implement new feature',
  description: 'As a user, I want to...',
  issueType: 'Story',
  labels: ['frontend', 'priority-high'],
});

console.log(`Created: ${issue.key}`); // PROJ-123
```

### Get an Issue

```typescript
const issue = await jira.getIssue('PROJ-123');

console.log(issue.summary);
console.log(issue.status.name);
console.log(issue.assignee?.displayName ?? 'Unassigned');
```

### Update an Issue

```typescript
await jira.updateIssue('PROJ-123', {
  summary: 'Updated summary',
  labels: ['frontend', 'priority-medium'],
});
```

### Transition an Issue

```typescript
// Get available transitions
const transitions = await jira.getTransitions('PROJ-123');
console.log(transitions.map(t => ({ id: t.id, name: t.name })));

// Transition to "In Progress"
const inProgressTransition = transitions.find(t => t.name === 'Start Progress');
if (inProgressTransition) {
  await jira.transitionIssue('PROJ-123', inProgressTransition.id);
}
```

## Search with JQL

### Simple Search

```typescript
const issues = await jira.searchIssues('project = PROJ AND status = "In Progress"');

for (const issue of issues) {
  console.log(`${issue.key}: ${issue.summary}`);
}
```

### Async Iterator (Memory Efficient)

```typescript
// For large result sets, use the async iterator
for await (const issue of jira.searchIssuesIterator('project = PROJ')) {
  console.log(issue.key);

  // Can break early without fetching all pages
  if (issue.key === 'PROJ-100') break;
}
```

## Comments

### Add a Comment

```typescript
// Plain text (auto-converted to ADF)
await jira.addComment('PROJ-123', 'This is ready for review.');

// With ADF for rich formatting
await jira.addComment('PROJ-123', {
  version: 1,
  type: 'doc',
  content: [{
    type: 'paragraph',
    content: [
      { type: 'text', text: 'Build ' },
      { type: 'text', text: 'passed', marks: [{ type: 'strong' }] },
      { type: 'text', text: '!' }
    ]
  }]
});
```

### List Comments

```typescript
const comments = await jira.listComments('PROJ-123');
for (const comment of comments) {
  console.log(`${comment.author.displayName}: ${adfToText(comment.body)}`);
}
```

## Custom Fields

### Get Custom Fields

```typescript
const fields = await jira.getCustomFields();
const storyPoints = fields.find(f => f.name === 'Story Points');

console.log(storyPoints?.id); // customfield_10001
```

### Set Custom Field Value

```typescript
await jira.setCustomField('PROJ-123', 'customfield_10001', 5);
```

### Create Issue with Custom Fields

```typescript
const issue = await jira.createIssue({
  projectKey: 'PROJ',
  summary: 'New feature',
  issueType: 'Story',
  customFields: {
    customfield_10001: 3, // Story Points
    customfield_10002: 'high', // Priority level
  },
});
```

## Sprint Operations

### Get Active Sprint

```typescript
const sprint = await jira.getActiveSprint(123); // Board ID
console.log(`Current sprint: ${sprint.name}`);
console.log(`Ends: ${sprint.endDate}`);
```

### Add Issue to Sprint

```typescript
await jira.addToSprint('PROJ-123', sprint.id);
```

## Webhooks

### Handle Webhook Events

```typescript
import express from 'express';

const app = express();

app.post('/webhooks/jira', express.json(), async (req, res) => {
  try {
    const action = await jira.handleWebhook(req.body);

    switch (action.type) {
      case 'issue_created':
        console.log(`New issue: ${action.issue.key}`);
        break;
      case 'issue_transitioned':
        console.log(`${action.issue.key} moved to ${action.newStatus}`);
        break;
      case 'comment_added':
        console.log(`Comment on ${action.issue.key}`);
        break;
      case 'ignore':
        // Not relevant to our workflow
        break;
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Error');
  }
});
```

### Optional Signature Verification

```typescript
import { verifyWebhookSignature } from '@generacy-ai/generacy-plugin-jira';

app.post('/webhooks/jira', express.json(), async (req, res) => {
  // Verify shared secret
  const secret = req.query.secret as string;
  if (!verifyWebhookSignature(secret, config.webhookSecret)) {
    return res.status(401).send('Unauthorized');
  }

  // Process event...
});
```

## Error Handling

```typescript
import {
  JiraAuthError,
  JiraNotFoundError,
  JiraValidationError,
  JiraRateLimitError,
  JiraTransitionError,
} from '@generacy-ai/generacy-plugin-jira';

try {
  await jira.getIssue('INVALID-999');
} catch (error) {
  if (error instanceof JiraNotFoundError) {
    console.log('Issue not found');
  } else if (error instanceof JiraAuthError) {
    console.log('Check your API token');
  } else if (error instanceof JiraRateLimitError) {
    console.log(`Rate limited. Retry after: ${error.resetAt}`);
  } else if (error instanceof JiraValidationError) {
    console.log('Validation failed:', error.details);
  } else if (error instanceof JiraTransitionError) {
    console.log('Invalid transition. Available:', error.availableTransitions);
  }
}
```

## Environment Variables

Recommended environment variables:

```bash
JIRA_HOST=company.atlassian.net
JIRA_EMAIL=automation@company.com
JIRA_API_TOKEN=your-api-token
JIRA_PROJECT=PROJ
JIRA_WEBHOOK_SECRET=your-webhook-secret
```

```typescript
const config: JiraConfig = {
  host: process.env.JIRA_HOST!,
  email: process.env.JIRA_EMAIL!,
  apiToken: process.env.JIRA_API_TOKEN!,
  projectKey: process.env.JIRA_PROJECT,
  webhookSecret: process.env.JIRA_WEBHOOK_SECRET,
};
```

## Troubleshooting

### "Unauthorized" Errors

1. Verify your API token is valid at [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Check the email matches the token owner
3. Ensure your account has project access

### "Issue Not Found" Errors

1. Verify the issue key format (e.g., `PROJ-123`)
2. Check your account has "Browse Projects" permission
3. Ensure the issue exists and isn't deleted

### Rate Limiting

The plugin automatically includes rate limit info in errors:

```typescript
try {
  await jira.searchIssues('project = PROJ');
} catch (error) {
  if (error instanceof JiraRateLimitError) {
    const retryAfter = error.resetAt
      ? error.resetAt.getTime() - Date.now()
      : 60000;
    await sleep(retryAfter);
    // Retry...
  }
}
```

### JQL Syntax Errors

```typescript
try {
  await jira.searchIssues('invalid jql here');
} catch (error) {
  if (error instanceof JiraValidationError) {
    console.log('JQL Error:', error.message);
  }
}
```

## Next Steps

- Review the [Data Model](./data-model.md) for all types
- Check [Research](./research.md) for API details
- See the full [API Reference](#) for all methods

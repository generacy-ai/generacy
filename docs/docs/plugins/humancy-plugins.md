---
sidebar_position: 3
---

# Humancy Plugins

Humancy plugins add review gates, custom actions, and workflow steps for human oversight.

## Overview

Humancy plugins provide:

- **Custom Actions** - Workflow step implementations
- **Gate Types** - Custom review gate logic
- **Notification Channels** - Custom notification delivery
- **Approval Integrations** - External approval systems

## Quick Start

### 1. Create the Plugin

```bash
mkdir humancy-plugin-example
cd humancy-plugin-example
npm init -y
npm install @generacy-ai/humancy --save-peer
npm install typescript --save-dev
```

### 2. Define the Manifest

```json title="manifest.json"
{
  "name": "example-humancy-plugin",
  "version": "1.0.0",
  "type": "humancy",
  "description": "Example Humancy plugin",
  "actions": [
    {
      "name": "security-scan",
      "description": "Run security vulnerability scan",
      "schema": {
        "type": "object",
        "properties": {
          "severity": {
            "type": "string",
            "enum": ["low", "medium", "high", "critical"],
            "default": "medium"
          }
        }
      }
    }
  ],
  "gateTypes": [
    {
      "name": "security-review",
      "description": "Security team review gate"
    }
  ],
  "notifications": [
    {
      "name": "pagerduty",
      "description": "PagerDuty notifications"
    }
  ]
}
```

### 3. Implement the Plugin

```typescript title="src/index.ts"
import {
  HumancyPlugin,
  Action,
  ActionResult,
  GateType,
  GateContext,
  NotificationChannel,
} from '@generacy-ai/humancy';

export default class ExamplePlugin implements HumancyPlugin {
  name = 'example-humancy-plugin';
  version = '1.0.0';

  actions: Action[] = [
    {
      name: 'security-scan',
      description: 'Run security vulnerability scan',
      handler: this.securityScan.bind(this),
    },
  ];

  gateTypes: GateType[] = [
    {
      name: 'security-review',
      description: 'Security team review gate',
      evaluator: this.evaluateSecurityGate.bind(this),
    },
  ];

  notifications: NotificationChannel[] = [
    {
      name: 'pagerduty',
      send: this.sendPagerDuty.bind(this),
    },
  ];

  async initialize(): Promise<void> {
    // Setup
  }

  async securityScan(params: {
    severity?: string;
  }): Promise<ActionResult> {
    const minSeverity = params.severity || 'medium';

    // Run security scan
    const vulnerabilities = await this.runScan();

    // Filter by severity
    const filtered = vulnerabilities.filter(
      (v) => this.severityLevel(v.severity) >= this.severityLevel(minSeverity)
    );

    return {
      success: filtered.length === 0,
      data: {
        total: vulnerabilities.length,
        filtered: filtered.length,
        vulnerabilities: filtered,
      },
    };
  }

  async evaluateSecurityGate(context: GateContext): Promise<boolean> {
    // Custom gate evaluation logic
    const { workflowData, approvals } = context;

    // Require security team approval for high-severity issues
    if (workflowData.securityLevel === 'high') {
      return approvals.some((a) => a.reviewer.includes('@security'));
    }

    return approvals.length >= 1;
  }

  async sendPagerDuty(notification: {
    title: string;
    message: string;
    severity: string;
  }): Promise<void> {
    // Send to PagerDuty API
    await fetch('https://events.pagerduty.com/v2/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        routing_key: process.env.PAGERDUTY_KEY,
        event_action: 'trigger',
        payload: {
          summary: notification.title,
          source: 'Generacy',
          severity: notification.severity,
          custom_details: { message: notification.message },
        },
      }),
    });
  }

  private async runScan(): Promise<Vulnerability[]> {
    // Implementation
    return [];
  }

  private severityLevel(severity: string): number {
    const levels: Record<string, number> = {
      low: 1,
      medium: 2,
      high: 3,
      critical: 4,
    };
    return levels[severity] || 0;
  }
}

interface Vulnerability {
  id: string;
  severity: string;
  description: string;
}
```

## Action Development

### Action Types

```typescript
// Simple action
{
  name: 'run-linter',
  handler: async (params) => {
    const result = await runLinter(params.config);
    return { success: result.errors === 0, data: result };
  },
}

// Long-running action
{
  name: 'deploy',
  handler: async (params, context) => {
    const deployment = await startDeployment(params);

    // Report progress
    await context.progress('Deploying...', 25);
    await waitForHealthCheck(deployment);
    await context.progress('Health check passed', 75);
    await finalizeDeployment(deployment);

    return { success: true, data: { deploymentId: deployment.id } };
  },
}

// Action with gate integration
{
  name: 'run-tests-with-gate',
  handler: async (params, context) => {
    const results = await runTests();

    if (results.failed > 0) {
      // Create a gate for failed test review
      await context.createGate({
        title: 'Review Failed Tests',
        description: `${results.failed} tests failed`,
        data: { results },
      });
    }

    return { success: true, data: results };
  },
}
```

## Custom Gate Types

### Gate Evaluator

```typescript
gateTypes: GateType[] = [
  {
    name: 'senior-review',
    description: 'Requires senior engineer approval',
    evaluator: async (context) => {
      const seniorReviewers = ['alice@company.com', 'bob@company.com'];
      return context.approvals.some((a) =>
        seniorReviewers.includes(a.reviewer)
      );
    },
  },
  {
    name: 'multi-team-review',
    description: 'Requires approval from multiple teams',
    evaluator: async (context) => {
      const teams = ['@frontend', '@backend', '@security'];
      const approvedTeams = new Set(
        context.approvals.flatMap((a) => a.teams || [])
      );
      return teams.every((t) => approvedTeams.has(t));
    },
  },
  {
    name: 'time-based',
    description: 'Auto-approves after delay',
    evaluator: async (context) => {
      const gateAge = Date.now() - context.createdAt.getTime();
      const delay = context.config.delay || 3600000; // 1 hour default

      if (gateAge > delay) {
        return true; // Auto-approve
      }

      return context.approvals.length >= 1;
    },
  },
];
```

## Notification Channels

### Custom Channel

```typescript
notifications: NotificationChannel[] = [
  {
    name: 'teams',
    send: async (notification) => {
      await fetch(process.env.TEAMS_WEBHOOK_URL, {
        method: 'POST',
        body: JSON.stringify({
          '@type': 'MessageCard',
          summary: notification.title,
          sections: [
            {
              activityTitle: notification.title,
              text: notification.message,
            },
          ],
        }),
      });
    },
  },
  {
    name: 'sms',
    send: async (notification, config) => {
      await twilioClient.messages.create({
        to: config.phone,
        from: process.env.TWILIO_NUMBER,
        body: `${notification.title}: ${notification.message}`,
      });
    },
  },
];
```

## Workflow Integration

### Using in Workflows

```yaml title=".humancy/workflows/secure-deploy.yml"
name: Secure Deployment
triggers:
  - command: "/deploy"

steps:
  - id: security-scan
    type: action
    action: example-humancy-plugin:security-scan
    config:
      severity: high

  - id: security-review
    type: review-gate
    gateType: example-humancy-plugin:security-review
    title: "Security Review Required"
    requires: [security-scan]
    condition: ${{ steps.security-scan.data.filtered > 0 }}

  - id: deploy
    type: action
    action: deploy
```

## Testing

### Unit Tests

```typescript
import { describe, it, expect, vi } from 'vitest';
import ExamplePlugin from './index';

describe('ExamplePlugin', () => {
  const plugin = new ExamplePlugin();

  describe('securityScan', () => {
    it('should return success when no vulnerabilities', async () => {
      vi.spyOn(plugin, 'runScan').mockResolvedValue([]);

      const result = await plugin.securityScan({ severity: 'high' });

      expect(result.success).toBe(true);
      expect(result.data.filtered).toBe(0);
    });
  });

  describe('evaluateSecurityGate', () => {
    it('should require security approval for high severity', async () => {
      const context = {
        workflowData: { securityLevel: 'high' },
        approvals: [{ reviewer: 'dev@company.com' }],
      };

      const result = await plugin.evaluateSecurityGate(context);
      expect(result).toBe(false);
    });
  });
});
```

## Next Steps

- [Generacy Plugins](/docs/plugins/generacy-plugins) - Orchestration plugins
- [Manifest Reference](/docs/plugins/manifest-reference) - Complete manifest docs

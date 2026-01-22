import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as vscode from 'vscode';
import { getDashboardHtml } from '../webview';
import type { OrgDashboardData } from '../../../../api/endpoints/orgs';

// Mock vscode module
vi.mock('vscode', () => ({
  Uri: {
    joinPath: vi.fn((_base: unknown, ...segments: string[]) => ({
      fsPath: `/mock/path/${segments.join('/')}`,
      toString: () => `file:///mock/path/${segments.join('/')}`,
    })),
  },
}));

describe('Organization Dashboard Webview', () => {
  const mockWebview = {
    asWebviewUri: vi.fn((uri: vscode.Uri) => uri),
    cspSource: 'mock-csp-source',
    html: '',
    onDidReceiveMessage: vi.fn(),
    postMessage: vi.fn(),
    options: {},
  } as unknown as vscode.Webview;

  const mockExtensionUri = {
    fsPath: '/mock/extension',
    scheme: 'file',
    authority: '',
    path: '/mock/extension',
    query: '',
    fragment: '',
    with: vi.fn(),
    toString: () => 'file:///mock/extension',
    toJSON: () => ({}),
  } as unknown as vscode.Uri;

  const mockDashboardData: OrgDashboardData = {
    organization: {
      id: 'org-123',
      name: 'Test Organization',
      slug: 'test-org',
      tier: 'team',
      seats: 5,
      maxConcurrentAgents: 10,
      createdAt: '2024-01-01T00:00:00.000Z',
    },
    members: [
      {
        userId: 'user-1',
        user: {
          id: 'user-1',
          email: 'owner@example.com',
          name: 'Org Owner',
          avatarUrl: 'https://example.com/avatar1.png',
          githubUsername: 'owner',
          createdAt: '2024-01-01T00:00:00.000Z',
        },
        role: 'owner',
        joinedAt: '2024-01-01T00:00:00.000Z',
      },
      {
        userId: 'user-2',
        user: {
          id: 'user-2',
          email: 'member@example.com',
          name: 'Team Member',
          createdAt: '2024-01-15T00:00:00.000Z',
        },
        role: 'member',
        joinedAt: '2024-01-15T00:00:00.000Z',
      },
    ],
    usage: {
      periodStart: '2024-01-01T00:00:00.000Z',
      periodEnd: '2024-01-31T23:59:59.999Z',
      agentHoursUsed: 45.5,
      agentHoursLimit: 500,
      currentConcurrentAgents: 3,
    },
    billing: {
      plan: 'Team',
      pricePerSeat: 99,
      billingCycle: 'monthly',
      nextBillingDate: '2024-02-01T00:00:00.000Z',
      amountDue: 495,
      currency: 'USD',
      isActive: true,
      paymentMethod: 'Visa ending in 4242',
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getDashboardHtml', () => {
    it('should generate valid HTML', () => {
      const html = getDashboardHtml(mockWebview, mockExtensionUri, mockDashboardData);

      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<html lang="en">');
      expect(html).toContain('</html>');
    });

    it('should include organization name in header', () => {
      const html = getDashboardHtml(mockWebview, mockExtensionUri, mockDashboardData);

      expect(html).toContain('Test Organization');
    });

    it('should display tier badge', () => {
      const html = getDashboardHtml(mockWebview, mockExtensionUri, mockDashboardData);

      expect(html).toContain('tier-team');
      expect(html).toContain('Team');
    });

    it('should include CSP meta tag with nonce', () => {
      const html = getDashboardHtml(mockWebview, mockExtensionUri, mockDashboardData);

      expect(html).toContain('Content-Security-Policy');
      expect(html).toMatch(/nonce-[A-Za-z0-9]+/);
    });

    it('should display organization stats', () => {
      const html = getDashboardHtml(mockWebview, mockExtensionUri, mockDashboardData);

      expect(html).toContain('Seats');
      expect(html).toContain('5');
      expect(html).toContain('Concurrent Agents');
      expect(html).toContain('10');
    });

    it('should display usage metrics', () => {
      const html = getDashboardHtml(mockWebview, mockExtensionUri, mockDashboardData);

      expect(html).toContain('Usage Metrics');
      expect(html).toContain('Agent Hours');
      expect(html).toContain('45.5');
      expect(html).toContain('500');
    });

    it('should display members list', () => {
      const html = getDashboardHtml(mockWebview, mockExtensionUri, mockDashboardData);

      expect(html).toContain('Members (2)');
      expect(html).toContain('Org Owner');
      expect(html).toContain('owner@example.com');
      expect(html).toContain('Team Member');
      expect(html).toContain('member@example.com');
    });

    it('should display role badges', () => {
      const html = getDashboardHtml(mockWebview, mockExtensionUri, mockDashboardData);

      expect(html).toContain('role-owner');
      expect(html).toContain('role-member');
      expect(html).toContain('Owner');
      expect(html).toContain('Member');
    });

    it('should display billing information', () => {
      const html = getDashboardHtml(mockWebview, mockExtensionUri, mockDashboardData);

      expect(html).toContain('Billing Summary');
      expect(html).toContain('Team');
      expect(html).toContain('Monthly');
      expect(html).toContain('Visa ending in 4242');
    });

    it('should include upgrade CTA for non-enterprise tiers', () => {
      const html = getDashboardHtml(mockWebview, mockExtensionUri, mockDashboardData);

      expect(html).toContain('Upgrade to Enterprise');
    });

    it('should not include upgrade CTA for enterprise tier', () => {
      const enterpriseData: OrgDashboardData = {
        ...mockDashboardData,
        organization: {
          ...mockDashboardData.organization,
          tier: 'enterprise',
        },
      };

      const html = getDashboardHtml(mockWebview, mockExtensionUri, enterpriseData);

      expect(html).not.toContain('Upgrade to');
    });

    it('should include quick actions', () => {
      const html = getDashboardHtml(mockWebview, mockExtensionUri, mockDashboardData);

      expect(html).toContain('Quick Actions');
      expect(html).toContain('Settings');
      expect(html).toContain('Integrations');
      expect(html).toContain('Documentation');
      expect(html).toContain('Support');
    });

    it('should include JavaScript for interactivity', () => {
      const html = getDashboardHtml(mockWebview, mockExtensionUri, mockDashboardData);

      expect(html).toContain('acquireVsCodeApi');
      expect(html).toContain('function refresh()');
      expect(html).toContain('function upgrade(');
      expect(html).toContain('function manageBilling()');
      expect(html).toContain('function inviteMember()');
    });

    it('should escape HTML in user-provided content', () => {
      const xssData: OrgDashboardData = {
        ...mockDashboardData,
        organization: {
          ...mockDashboardData.organization,
          name: '<script>alert("xss")</script>',
        },
      };

      const html = getDashboardHtml(mockWebview, mockExtensionUri, xssData);

      expect(html).not.toContain('<script>alert("xss")</script>');
      expect(html).toContain('&lt;script&gt;');
    });

    it('should handle members without avatar URL', () => {
      const html = getDashboardHtml(mockWebview, mockExtensionUri, mockDashboardData);

      // Team Member has no avatar, should show initials
      expect(html).toContain('avatar-placeholder');
      expect(html).toContain('TM'); // Initials for "Team Member"
    });

    it('should display features for the tier', () => {
      const html = getDashboardHtml(mockWebview, mockExtensionUri, mockDashboardData);

      expect(html).toContain('Included Features');
      expect(html).toContain('All integrations');
      expect(html).toContain('SSO');
      expect(html).toContain('Priority support');
    });

    it('should show warning for high usage', () => {
      const highUsageData: OrgDashboardData = {
        ...mockDashboardData,
        usage: {
          ...mockDashboardData.usage,
          agentHoursUsed: 450, // 90% of 500
        },
      };

      const html = getDashboardHtml(mockWebview, mockExtensionUri, highUsageData);

      expect(html).toContain('usage-warning');
      expect(html).toContain("You've used 90% of your agent hours");
    });
  });
});

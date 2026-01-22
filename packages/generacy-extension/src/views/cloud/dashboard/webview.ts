/**
 * Organization Dashboard Webview Content Generator
 * Generates the HTML content for the organization dashboard webview.
 */
import * as vscode from 'vscode';
import type { OrgDashboardData } from '../../../api/endpoints/orgs';
import { getTierDisplayName, getTierLimits, getTierPricing } from '../../../api/endpoints/orgs';

// ============================================================================
// HTML Generation
// ============================================================================

/**
 * Generate the complete dashboard HTML
 */
export function getDashboardHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  data: OrgDashboardData
): string {
  const nonce = getNonce();
  const { organization, members, usage, billing } = data;
  const tierLimits = getTierLimits(organization.tier);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>${escapeHtmlForTitle(organization.name)} - Dashboard</title>
  <style nonce="${nonce}">
    ${getStyles()}
  </style>
</head>
<body>
  <div class="dashboard">
    ${getHeader(organization)}
    <div class="content">
      <div class="main-content">
        ${getOverviewSection(organization, tierLimits)}
        ${getUsageSection(usage, tierLimits)}
        ${getMembersSection(members)}
      </div>
      <div class="sidebar">
        ${getBillingSection(billing, organization)}
        ${getQuickActionsSection(organization)}
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    ${getScript()}
  </script>
</body>
</html>`;
}

/**
 * Generate nonce for CSP
 */
function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

// ============================================================================
// Section Generators
// ============================================================================

function getHeader(organization: OrgDashboardData['organization']): string {
  const tierDisplay = getTierDisplayName(organization.tier);
  return `
    <header class="header">
      <div class="header-left">
        <h1>${escapeHtml(organization.name)}</h1>
        <span class="tier-badge tier-${organization.tier}">${tierDisplay}</span>
      </div>
      <div class="header-right">
        <button class="btn btn-secondary" onclick="refresh()">
          <span class="icon">&#x21bb;</span> Refresh
        </button>
      </div>
    </header>
  `;
}

function getOverviewSection(
  organization: OrgDashboardData['organization'],
  tierLimits: ReturnType<typeof getTierLimits>
): string {
  return `
    <section class="card">
      <h2>Organization Overview</h2>
      <div class="stats-grid">
        <div class="stat-item">
          <div class="stat-label">Seats</div>
          <div class="stat-value">${organization.seats}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Concurrent Agents</div>
          <div class="stat-value">${organization.maxConcurrentAgents}</div>
          <div class="stat-limit">${formatLimit(tierLimits.concurrentAgents)} max</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Agent Hours/Month</div>
          <div class="stat-value">${formatLimit(tierLimits.agentHoursPerMonth)}</div>
        </div>
      </div>
      <div class="features-list">
        <h3>Included Features</h3>
        <ul>
          ${tierLimits.features.map(f => `<li class="feature-item"><span class="check">&#x2713;</span> ${escapeHtml(f)}</li>`).join('')}
        </ul>
      </div>
    </section>
  `;
}

function getUsageSection(
  usage: OrgDashboardData['usage'],
  tierLimits: ReturnType<typeof getTierLimits>
): string {
  const usagePercent = usage.agentHoursLimit > 0
    ? Math.min(100, (usage.agentHoursUsed / usage.agentHoursLimit) * 100)
    : 0;
  const usageClass = usagePercent > 90 ? 'critical' : usagePercent > 75 ? 'warning' : 'normal';
  const concurrentPercent = tierLimits.concurrentAgents > 0
    ? Math.min(100, (usage.currentConcurrentAgents / tierLimits.concurrentAgents) * 100)
    : 0;

  const periodStart = new Date(usage.periodStart).toLocaleDateString();
  const periodEnd = new Date(usage.periodEnd).toLocaleDateString();

  return `
    <section class="card">
      <h2>Usage Metrics</h2>
      <p class="period-text">Billing period: ${periodStart} - ${periodEnd}</p>

      <div class="usage-item">
        <div class="usage-header">
          <span>Agent Hours</span>
          <span class="usage-numbers">${usage.agentHoursUsed.toFixed(1)} / ${usage.agentHoursLimit} hours</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill ${usageClass}" style="width: ${usagePercent}%"></div>
        </div>
        ${usagePercent > 75 ? `<p class="usage-warning">You've used ${usagePercent.toFixed(0)}% of your agent hours</p>` : ''}
      </div>

      <div class="usage-item">
        <div class="usage-header">
          <span>Concurrent Agents</span>
          <span class="usage-numbers">${usage.currentConcurrentAgents} / ${formatLimit(tierLimits.concurrentAgents)}</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${concurrentPercent}%"></div>
        </div>
      </div>
    </section>
  `;
}

function getMembersSection(members: OrgDashboardData['members']): string {
  const memberRows = members.map(member => {
    const roleClass = member.role === 'owner' ? 'role-owner' : member.role === 'admin' ? 'role-admin' : 'role-member';
    const joinDate = new Date(member.joinedAt).toLocaleDateString();
    return `
      <tr>
        <td>
          <div class="member-info">
            ${member.user.avatarUrl
              ? `<img class="avatar" src="${escapeHtml(member.user.avatarUrl)}" alt="">`
              : `<div class="avatar avatar-placeholder">${getInitials(member.user.name)}</div>`
            }
            <div>
              <div class="member-name">${escapeHtml(member.user.name)}</div>
              <div class="member-email">${escapeHtml(member.user.email)}</div>
            </div>
          </div>
        </td>
        <td><span class="role-badge ${roleClass}">${capitalizeFirst(member.role)}</span></td>
        <td class="text-muted">${joinDate}</td>
      </tr>
    `;
  }).join('');

  return `
    <section class="card">
      <div class="card-header">
        <h2>Members (${members.length})</h2>
        <button class="btn btn-primary btn-sm" onclick="inviteMember()">
          <span class="icon">+</span> Invite
        </button>
      </div>
      <table class="members-table">
        <thead>
          <tr>
            <th>Member</th>
            <th>Role</th>
            <th>Joined</th>
          </tr>
        </thead>
        <tbody>
          ${memberRows}
        </tbody>
      </table>
    </section>
  `;
}

function getBillingSection(
  billing: OrgDashboardData['billing'],
  organization: OrgDashboardData['organization']
): string {
  const nextBillingDate = new Date(billing.nextBillingDate).toLocaleDateString();
  const tierPricing = getTierPricing(organization.tier);

  return `
    <section class="card">
      <h2>Billing Summary</h2>
      <div class="billing-info">
        <div class="billing-row">
          <span>Current Plan</span>
          <span class="billing-value">${escapeHtml(billing.plan)}</span>
        </div>
        <div class="billing-row">
          <span>Price</span>
          <span class="billing-value">${tierPricing.description}</span>
        </div>
        <div class="billing-row">
          <span>Billing Cycle</span>
          <span class="billing-value">${capitalizeFirst(billing.billingCycle)}</span>
        </div>
        <div class="billing-row">
          <span>Next Invoice</span>
          <span class="billing-value">${nextBillingDate}</span>
        </div>
        <div class="billing-row">
          <span>Amount Due</span>
          <span class="billing-value amount">${formatCurrency(billing.amountDue, billing.currency)}</span>
        </div>
        ${billing.paymentMethod ? `
          <div class="billing-row">
            <span>Payment Method</span>
            <span class="billing-value">${escapeHtml(billing.paymentMethod)}</span>
          </div>
        ` : ''}
      </div>
      <button class="btn btn-secondary btn-full" onclick="manageBilling()">
        Manage Billing
      </button>
    </section>
  `;
}

function getQuickActionsSection(organization: OrgDashboardData['organization']): string {
  const upgradeCta = organization.tier !== 'enterprise' ? `
    <div class="upgrade-cta">
      <h3>Need more?</h3>
      <p>Upgrade your plan for more agents and features.</p>
      <button class="btn btn-primary btn-full" onclick="upgrade('${organization.tier === 'starter' ? 'team' : 'enterprise'}')">
        Upgrade to ${organization.tier === 'starter' ? 'Team' : 'Enterprise'}
      </button>
    </div>
  ` : '';

  return `
    <section class="card">
      <h2>Quick Actions</h2>
      <div class="quick-actions">
        <button class="action-btn" onclick="openLink('https://generacy.ai/settings')">
          <span class="action-icon">&#x2699;</span>
          <span>Settings</span>
        </button>
        <button class="action-btn" onclick="openLink('https://generacy.ai/integrations')">
          <span class="action-icon">&#x1F517;</span>
          <span>Integrations</span>
        </button>
        <button class="action-btn" onclick="openLink('https://generacy.ai/docs')">
          <span class="action-icon">&#x1F4D6;</span>
          <span>Documentation</span>
        </button>
        <button class="action-btn" onclick="openLink('https://generacy.ai/support')">
          <span class="action-icon">&#x2753;</span>
          <span>Support</span>
        </button>
      </div>
      ${upgradeCta}
    </section>
  `;
}

// ============================================================================
// Styles
// ============================================================================

function getStyles(): string {
  return `
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      line-height: 1.5;
    }

    .dashboard {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .header h1 {
      font-size: 24px;
      font-weight: 600;
    }

    .tier-badge {
      padding: 4px 12px;
      border-radius: 16px;
      font-size: 12px;
      font-weight: 500;
      text-transform: uppercase;
    }

    .tier-starter { background: var(--vscode-charts-blue); color: white; }
    .tier-team { background: var(--vscode-charts-purple); color: white; }
    .tier-enterprise { background: var(--vscode-charts-orange); color: white; }

    .content {
      display: grid;
      grid-template-columns: 1fr 320px;
      gap: 24px;
    }

    @media (max-width: 900px) {
      .content {
        grid-template-columns: 1fr;
      }
    }

    .card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
    }

    .card h2 {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 16px;
      color: var(--vscode-foreground);
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }

    .card-header h2 {
      margin-bottom: 0;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
      margin-bottom: 20px;
    }

    .stat-item {
      text-align: center;
      padding: 16px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 8px;
    }

    .stat-label {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }

    .stat-value {
      font-size: 28px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }

    .stat-limit {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
    }

    .features-list h3 {
      font-size: 13px;
      font-weight: 500;
      margin-bottom: 8px;
    }

    .features-list ul {
      list-style: none;
    }

    .feature-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 0;
      color: var(--vscode-foreground);
    }

    .check {
      color: var(--vscode-charts-green);
    }

    .period-text {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 16px;
    }

    .usage-item {
      margin-bottom: 20px;
    }

    .usage-item:last-child {
      margin-bottom: 0;
    }

    .usage-header {
      display: flex;
      justify-content: space-between;
      margin-bottom: 8px;
      font-size: 13px;
    }

    .usage-numbers {
      color: var(--vscode-descriptionForeground);
    }

    .progress-bar {
      height: 8px;
      background: var(--vscode-progressBar-background);
      border-radius: 4px;
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      background: var(--vscode-progressBar-background);
      border-radius: 4px;
      transition: width 0.3s ease;
    }

    .progress-fill.normal { background: var(--vscode-charts-green); }
    .progress-fill.warning { background: var(--vscode-charts-yellow); }
    .progress-fill.critical { background: var(--vscode-charts-red); }

    .usage-warning {
      font-size: 12px;
      color: var(--vscode-editorWarning-foreground);
      margin-top: 8px;
    }

    .members-table {
      width: 100%;
      border-collapse: collapse;
    }

    .members-table th,
    .members-table td {
      padding: 12px 8px;
      text-align: left;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .members-table th {
      font-size: 11px;
      font-weight: 500;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
    }

    .member-info {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      object-fit: cover;
    }

    .avatar-placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-size: 12px;
      font-weight: 600;
    }

    .member-name {
      font-weight: 500;
    }

    .member-email {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }

    .role-badge {
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
    }

    .role-owner { background: var(--vscode-charts-orange); color: white; }
    .role-admin { background: var(--vscode-charts-blue); color: white; }
    .role-member { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }

    .text-muted {
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
    }

    .billing-info {
      margin-bottom: 16px;
    }

    .billing-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 13px;
    }

    .billing-row:last-child {
      border-bottom: none;
    }

    .billing-value {
      font-weight: 500;
    }

    .billing-value.amount {
      color: var(--vscode-charts-green);
    }

    .quick-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-bottom: 20px;
    }

    .action-btn {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: 12px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.2s;
      color: var(--vscode-foreground);
    }

    .action-btn:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .action-icon {
      font-size: 20px;
    }

    .action-btn span:last-child {
      font-size: 11px;
    }

    .upgrade-cta {
      padding: 16px;
      background: linear-gradient(135deg, var(--vscode-charts-purple), var(--vscode-charts-blue));
      border-radius: 8px;
      text-align: center;
      color: white;
    }

    .upgrade-cta h3 {
      font-size: 14px;
      margin-bottom: 4px;
    }

    .upgrade-cta p {
      font-size: 12px;
      opacity: 0.9;
      margin-bottom: 12px;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 8px 16px;
      border: none;
      border-radius: 4px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
    }

    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .btn-primary:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    .btn-secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .btn-sm {
      padding: 4px 12px;
      font-size: 12px;
    }

    .btn-full {
      width: 100%;
    }

    .icon {
      font-size: 14px;
    }
  `;
}

// ============================================================================
// Script
// ============================================================================

function getScript(): string {
  return `
    const vscode = acquireVsCodeApi();

    function refresh() {
      vscode.postMessage({ type: 'refresh' });
    }

    function upgrade(targetTier) {
      vscode.postMessage({ type: 'upgrade', targetTier });
    }

    function manageBilling() {
      vscode.postMessage({ type: 'manageBilling' });
    }

    function inviteMember() {
      vscode.postMessage({ type: 'inviteMember' });
    }

    function openLink(url) {
      vscode.postMessage({ type: 'openLink', url });
    }

    // Handle messages from extension
    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.type) {
        case 'loading':
          // Could add loading overlay
          break;
        case 'error':
          // Could show error toast
          console.error('Dashboard error:', message.message);
          break;
      }
    });

    // Signal ready
    vscode.postMessage({ type: 'ready' });
  `;
}

// ============================================================================
// Utility Functions
// ============================================================================

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}

/**
 * Escape HTML for use in title element (same as escapeHtml but separate for clarity)
 */
function escapeHtmlForTitle(text: string): string {
  return escapeHtml(text);
}

function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function formatLimit(limit: number): string {
  return limit < 0 ? 'Unlimited' : limit.toString();
}

function formatCurrency(amount: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency,
  }).format(amount);
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map(part => part.charAt(0))
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

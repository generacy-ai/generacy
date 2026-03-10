/**
 * Orchestrator Dashboard Webview Content Generator
 * Generates HTML content for the orchestrator dashboard panel and sidebar summary.
 */
import * as vscode from 'vscode';
import type {
  Agent,
  AgentStats,
  ActivityEvent,
  ActivityEventType,
  AgentDisplayStatus,
  AgentConnectionStatus,
  QueueItem,
} from '../../../api/types';

// ============================================================================
// Data Types
// ============================================================================

/**
 * Queue stats for dashboard display
 */
export interface QueueStats {
  pending: number;
  waiting: number;
  running: number;
  completed: number;
  failed: number;
}

/**
 * Complete dashboard data
 */
export interface DashboardData {
  queueStats: QueueStats;
  agentStats: AgentStats;
  agents: Agent[];
  activity: ActivityEvent[];
  connected: boolean;
  /** Queue items with status 'waiting', rendered in the waiting-for-input section */
  waitingItems: QueueItem[];
}

/**
 * Sidebar summary data
 */
export interface SidebarData {
  queueStats: QueueStats;
  agentStats: AgentStats;
  connected: boolean;
}

// ============================================================================
// Dashboard HTML Generation
// ============================================================================

/**
 * Generate the complete orchestrator dashboard HTML
 */
export function getDashboardHtml(
  _webview: vscode.Webview,
  _extensionUri: vscode.Uri,
  data: DashboardData
): string {
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>Orchestration Dashboard</title>
  <style nonce="${nonce}">
    ${getDashboardStyles()}
  </style>
</head>
<body>
  <div class="dashboard">
    ${getDashboardHeader(data.connected)}
    <div class="content">
      <div class="main-content">
        ${getQueueSummarySection(data.queueStats, data.waitingItems)}
        ${getAgentSummarySection(data.agents, data.agentStats)}
      </div>
      <div class="sidebar">
        ${getActivityFeedSection(data.activity)}
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    ${getDashboardScript()}
  </script>
</body>
</html>`;
}

// ============================================================================
// Sidebar HTML Generation
// ============================================================================

/**
 * Generate compact sidebar summary HTML
 */
export function getSidebarHtml(
  _webview: vscode.Webview,
  _extensionUri: vscode.Uri,
  data: SidebarData
): string {
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>Orchestrator Summary</title>
  <style nonce="${nonce}">
    ${getSidebarStyles()}
  </style>
</head>
<body>
  <div class="sidebar-summary">
    ${getConnectionStatus(data.connected)}
    ${getSidebarQueueSummary(data.queueStats)}
    ${getSidebarAgentSummary(data.agentStats)}
    <button class="btn btn-primary btn-full" onclick="openDashboard()">Open Dashboard</button>
  </div>
  <script nonce="${nonce}">
    ${getSidebarScript()}
  </script>
</body>
</html>`;
}

// ============================================================================
// Dashboard Section Generators
// ============================================================================

function getDashboardHeader(connected: boolean): string {
  const statusDot = connected ? 'status-connected' : 'status-disconnected';
  const statusText = connected ? 'Connected' : 'Disconnected';

  return `
    <header class="header">
      <div class="header-left">
        <h1>Orchestration Dashboard</h1>
        <span class="connection-status ${statusDot}" id="connection-status">
          <span class="status-dot"></span>
          <span class="status-text">${statusText}</span>
        </span>
      </div>
      <div class="header-right">
        <button class="btn btn-secondary" onclick="refresh()">
          <span class="icon">&#x21bb;</span> Refresh
        </button>
      </div>
    </header>
  `;
}

function getQueueSummarySection(stats: QueueStats, waitingItems: QueueItem[]): string {
  const total = stats.pending + stats.waiting + stats.running + stats.completed + stats.failed;

  if (total === 0) {
    return `
      <section class="card">
        <h2>Work Queue</h2>
        ${getEmptyState('queue')}
      </section>
    `;
  }

  return `
    <section class="card">
      <h2>Work Queue</h2>
      <div class="stats-grid" id="queue-stats">
        ${getQueueStatCard('Active', stats.running, 'stat-running')}
        ${getQueueStatCard('Waiting', stats.waiting, 'stat-waiting')}
        ${getQueueStatCard('Completed', stats.completed, 'stat-completed')}
        ${getQueueStatCard('Failed', stats.failed, 'stat-failed')}
      </div>
      ${getPriorityBar(stats)}
      ${getWaitingJobsSection(waitingItems)}
    </section>
  `;
}

function getQueueStatCard(label: string, count: number, className: string): string {
  return `
    <div class="stat-item ${className}">
      <div class="stat-value" data-stat="${label.toLowerCase()}">${count}</div>
      <div class="stat-label">${label}</div>
    </div>
  `;
}

function getPriorityBar(stats: QueueStats): string {
  const active = stats.pending + stats.waiting + stats.running;
  if (active === 0) {
    return '';
  }

  const total = stats.pending + stats.waiting + stats.running + stats.completed + stats.failed;
  if (total === 0) {
    return '';
  }

  const segments = [
    { label: 'Pending', count: stats.pending, className: 'bar-pending' },
    { label: 'Waiting', count: stats.waiting, className: 'bar-waiting' },
    { label: 'Running', count: stats.running, className: 'bar-running' },
    { label: 'Completed', count: stats.completed, className: 'bar-completed' },
    { label: 'Failed', count: stats.failed, className: 'bar-failed' },
  ].filter(s => s.count > 0);

  const bars = segments
    .map(s => {
      const pct = ((s.count / total) * 100).toFixed(1);
      return `<div class="priority-segment ${s.className}" style="width: ${pct}%" title="${s.label}: ${s.count}"></div>`;
    })
    .join('');

  return `
    <div class="priority-bar-container">
      <div class="priority-bar">${bars}</div>
      <div class="priority-legend">
        ${segments.map(s => `<span class="legend-item"><span class="legend-dot ${s.className}"></span>${s.label}: ${s.count}</span>`).join('')}
      </div>
    </div>
  `;
}

function getWaitingJobsSection(items: QueueItem[]): string {
  if (items.length === 0) {
    return '';
  }

  const rows = items.map(item => {
    const waitLabel = item.waitingFor ? escapeHtml(item.waitingFor) : 'Unknown';
    const timeWaiting = item.startedAt ? formatRelativeTime(item.startedAt) : formatRelativeTime(item.queuedAt);
    const name = escapeHtml(item.workflowName);

    return `
      <div class="waiting-job-item" data-item-id="${escapeHtml(item.id)}">
        <div class="waiting-job-name">${name}</div>
        <div class="waiting-job-label">${waitLabel}</div>
        <div class="waiting-job-time">${timeWaiting}</div>
        <button class="waiting-job-view btn btn-secondary" onclick="openQueueItem('${escapeHtml(item.id)}')">View</button>
      </div>
    `;
  }).join('');

  return `
    <div class="waiting-jobs-list">
      <div class="waiting-jobs-header">
        <span class="waiting-jobs-icon">&#x26A0;</span>
        <span class="waiting-jobs-title">Waiting for Input</span>
        <span class="waiting-jobs-count">${items.length}</span>
      </div>
      ${rows}
    </div>
  `;
}

function getAgentSummarySection(agents: Agent[], stats: AgentStats): string {
  if (stats.total === 0) {
    return `
      <section class="card">
        <h2>Agent Pool</h2>
        ${getEmptyState('agents')}
      </section>
    `;
  }

  const agentCards = agents.map(agent => getAgentCard(agent)).join('');

  return `
    <section class="card">
      <div class="card-header">
        <h2>Agent Pool</h2>
        <div class="agent-counts">
          <span class="count-badge count-available">${stats.available} available</span>
          <span class="count-badge count-busy">${stats.busy} busy</span>
          <span class="count-badge count-offline">${stats.offline} offline</span>
        </div>
      </div>
      <div class="agent-grid" id="agent-grid">
        ${agentCards}
      </div>
    </section>
  `;
}

function getAgentCard(agent: Agent): string {
  const displayStatus = getDisplayStatus(agent.status);
  const statusClass = `agent-${displayStatus}`;
  const assignment = agent.status === 'busy' && agent.metadata.workflowId
    ? `<div class="agent-assignment">Working on: ${escapeHtml(agent.metadata.workflowId)}</div>`
    : '';
  const lastSeen = formatRelativeTime(agent.lastSeen);

  return `
    <div class="agent-card ${statusClass}" data-agent-id="${escapeHtml(agent.id)}" onclick="openAgent('${escapeHtml(agent.id)}')">
      <div class="agent-header">
        <span class="agent-status-dot status-${displayStatus}"></span>
        <span class="agent-name">${escapeHtml(agent.name)}</span>
        <span class="agent-type-badge">${escapeHtml(agent.type)}</span>
      </div>
      ${assignment}
      <div class="agent-meta">Last seen: ${lastSeen}</div>
    </div>
  `;
}

function getActivityFeedSection(activity: ActivityEvent[]): string {
  if (activity.length === 0) {
    return `
      <section class="card activity-card">
        <h2>Recent Activity</h2>
        ${getEmptyState('activity')}
      </section>
    `;
  }

  const items = activity.map(event => getActivityItem(event)).join('');

  return `
    <section class="card activity-card">
      <h2>Recent Activity</h2>
      <div class="activity-feed" id="activity-feed">
        ${items}
      </div>
    </section>
  `;
}

function getActivityItem(event: ActivityEvent): string {
  const icon = getActivityIcon(event.type);
  const timeAgo = formatRelativeTime(event.timestamp);
  const typeClass = getActivityTypeClass(event.type);

  return `
    <div class="activity-item ${typeClass}" data-event-id="${escapeHtml(event.id)}">
      <span class="activity-icon">${icon}</span>
      <div class="activity-content">
        <span class="activity-message">${escapeHtml(event.message)}</span>
        <span class="activity-time">${timeAgo}</span>
      </div>
    </div>
  `;
}

function getEmptyState(section: 'queue' | 'agents' | 'activity'): string {
  const messages: Record<string, { title: string; hint: string }> = {
    queue: {
      title: 'No work items in queue',
      hint: 'Add a process:speckit-feature label to a GitHub issue to get started.',
    },
    agents: {
      title: 'No agents connected',
      hint: 'See documentation to register and connect agents.',
    },
    activity: {
      title: 'No recent activity',
      hint: 'Activity will appear here as workflows run and agents connect.',
    },
  };

  const msg = messages[section] ?? { title: 'Nothing here yet', hint: '' };
  return `
    <div class="empty-state">
      <div class="empty-title">${msg.title}</div>
      <div class="empty-hint">${msg.hint}</div>
    </div>
  `;
}

// ============================================================================
// Sidebar Section Generators
// ============================================================================

function getConnectionStatus(connected: boolean): string {
  const statusClass = connected ? 'status-connected' : 'status-disconnected';
  const statusText = connected ? 'Connected' : 'Disconnected';

  return `
    <div class="connection-indicator ${statusClass}" id="connection-status">
      <span class="status-dot"></span>
      <span>${statusText}</span>
    </div>
  `;
}

function getSidebarQueueSummary(stats: QueueStats): string {
  const parts: string[] = [];
  if (stats.pending > 0) { parts.push(`${stats.pending} pending`); }
  if (stats.waiting > 0) { parts.push(`${stats.waiting} waiting`); }
  if (stats.running > 0) { parts.push(`${stats.running} running`); }
  if (stats.failed > 0) { parts.push(`${stats.failed} failed`); }

  const summary = parts.length > 0 ? parts.join(', ') : 'No active work items';

  return `
    <div class="summary-section">
      <div class="summary-label">Queue</div>
      <div class="summary-value" id="queue-summary">${summary}</div>
    </div>
  `;
}

function getSidebarAgentSummary(stats: AgentStats): string {
  const parts: string[] = [];
  if (stats.available > 0) { parts.push(`${stats.available} available`); }
  if (stats.busy > 0) { parts.push(`${stats.busy} busy`); }
  if (stats.offline > 0) { parts.push(`${stats.offline} offline`); }

  const summary = parts.length > 0 ? parts.join(', ') : 'No agents registered';

  return `
    <div class="summary-section">
      <div class="summary-label">Agents</div>
      <div class="summary-value" id="agent-summary">${summary}</div>
    </div>
  `;
}

// ============================================================================
// Dashboard Styles
// ============================================================================

function getDashboardStyles(): string {
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

    /* Header */
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

    .connection-status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      border-radius: 16px;
      font-size: 12px;
      font-weight: 500;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
    }

    .status-connected .status-dot { background: var(--vscode-charts-green); }
    .status-disconnected .status-dot { background: var(--vscode-charts-red); }
    .status-connected { color: var(--vscode-charts-green); }
    .status-disconnected { color: var(--vscode-charts-red); }

    /* Layout */
    .content {
      display: grid;
      grid-template-columns: 1fr 360px;
      gap: 24px;
    }

    @media (max-width: 900px) {
      .content {
        grid-template-columns: 1fr;
      }
    }

    /* Cards */
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

    /* Queue Stats */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 16px;
    }

    .stat-item {
      text-align: center;
      padding: 16px 12px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 8px;
      border-left: 3px solid transparent;
    }

    .stat-pending { border-left-color: var(--vscode-charts-yellow); }
    .stat-waiting { border-left-color: var(--vscode-charts-orange); }
    .stat-running { border-left-color: var(--vscode-charts-blue); }
    .stat-completed { border-left-color: var(--vscode-charts-green); }
    .stat-failed { border-left-color: var(--vscode-charts-red); }

    .stat-value {
      font-size: 28px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }

    .stat-label {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
    }

    /* Priority Distribution Bar */
    .priority-bar-container {
      margin-top: 8px;
    }

    .priority-bar {
      display: flex;
      height: 6px;
      border-radius: 3px;
      overflow: hidden;
      background: var(--vscode-editor-inactiveSelectionBackground);
    }

    .priority-segment {
      height: 100%;
      transition: width 0.3s ease;
    }

    .bar-pending { background: var(--vscode-charts-yellow); }
    .bar-waiting { background: var(--vscode-charts-orange); }
    .bar-running { background: var(--vscode-charts-blue); }
    .bar-completed { background: var(--vscode-charts-green); }
    .bar-failed { background: var(--vscode-charts-red); }

    .priority-legend {
      display: flex;
      gap: 12px;
      margin-top: 8px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .legend-item {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .legend-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
    }

    /* Waiting Jobs List */
    .waiting-jobs-list {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--vscode-panel-border);
    }

    .waiting-jobs-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
    }

    .waiting-jobs-icon {
      color: var(--vscode-charts-orange);
      font-size: 14px;
    }

    .waiting-jobs-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }

    .waiting-jobs-count {
      padding: 1px 7px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 500;
      background: var(--vscode-charts-orange);
      color: white;
    }

    .waiting-job-item {
      display: grid;
      grid-template-columns: 1fr auto auto auto;
      align-items: center;
      gap: 12px;
      padding: 10px 12px;
      margin-bottom: 4px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-left: 3px solid var(--vscode-charts-orange);
      border-radius: 4px;
    }

    .waiting-job-item:last-child {
      margin-bottom: 0;
    }

    .waiting-job-name {
      font-size: 13px;
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .waiting-job-label {
      font-size: 12px;
      color: var(--vscode-charts-orange);
      font-weight: 500;
      white-space: nowrap;
    }

    .waiting-job-time {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }

    .waiting-job-view {
      padding: 3px 10px;
      font-size: 11px;
    }

    /* Agent Cards */
    .agent-counts {
      display: flex;
      gap: 8px;
    }

    .count-badge {
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
    }

    .count-available { background: var(--vscode-charts-green); color: white; }
    .count-busy { background: var(--vscode-charts-blue); color: white; }
    .count-offline { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }

    .agent-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 12px;
    }

    .agent-card {
      padding: 12px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.2s;
    }

    .agent-card:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .agent-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }

    .agent-status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .status-available { background: var(--vscode-charts-green); }
    .status-busy { background: var(--vscode-charts-blue); }
    .status-offline { background: var(--vscode-charts-red); }

    .agent-name {
      font-weight: 500;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .agent-type-badge {
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 10px;
      font-weight: 500;
      text-transform: uppercase;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .agent-assignment {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .agent-meta {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    /* Activity Feed */
    .activity-card {
      display: flex;
      flex-direction: column;
    }

    .activity-feed {
      max-height: 500px;
      overflow-y: auto;
    }

    .activity-item {
      display: flex;
      gap: 10px;
      padding: 10px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .activity-item:last-child {
      border-bottom: none;
    }

    .activity-icon {
      flex-shrink: 0;
      width: 20px;
      text-align: center;
      font-size: 14px;
    }

    .activity-content {
      flex: 1;
      min-width: 0;
    }

    .activity-message {
      display: block;
      font-size: 13px;
      word-break: break-word;
    }

    .activity-time {
      display: block;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
    }

    .activity-workflow-started .activity-icon { color: var(--vscode-charts-blue); }
    .activity-workflow-completed .activity-icon { color: var(--vscode-charts-green); }
    .activity-workflow-failed .activity-icon { color: var(--vscode-charts-red); }
    .activity-workflow-cancelled .activity-icon { color: var(--vscode-charts-yellow); }
    .activity-agent-connected .activity-icon { color: var(--vscode-charts-green); }
    .activity-agent-disconnected .activity-icon { color: var(--vscode-charts-red); }
    .activity-queue-item-added .activity-icon { color: var(--vscode-charts-blue); }
    .activity-queue-item-removed .activity-icon { color: var(--vscode-descriptionForeground); }

    /* Empty State */
    .empty-state {
      text-align: center;
      padding: 24px 16px;
    }

    .empty-title {
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 8px;
      color: var(--vscode-foreground);
    }

    .empty-hint {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.6;
    }

    /* Buttons */
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

    .btn-full {
      width: 100%;
    }

    .icon {
      font-size: 14px;
    }
  `;
}

// ============================================================================
// Sidebar Styles
// ============================================================================

function getSidebarStyles(): string {
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

    .sidebar-summary {
      padding: 12px;
    }

    .connection-indicator {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 0;
      margin-bottom: 12px;
      font-size: 12px;
      font-weight: 500;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
    }

    .status-connected .status-dot { background: var(--vscode-charts-green); }
    .status-disconnected .status-dot { background: var(--vscode-charts-red); }
    .status-connected { color: var(--vscode-charts-green); }
    .status-disconnected { color: var(--vscode-charts-red); }

    .summary-section {
      padding: 8px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .summary-section:last-of-type {
      margin-bottom: 12px;
    }

    .summary-label {
      font-size: 11px;
      font-weight: 500;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }

    .summary-value {
      font-size: 13px;
      color: var(--vscode-foreground);
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 6px 12px;
      border: none;
      border-radius: 4px;
      font-size: 12px;
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

    .btn-full {
      width: 100%;
    }
  `;
}

// ============================================================================
// Dashboard Script
// ============================================================================

function getDashboardScript(): string {
  return `
    const vscode = acquireVsCodeApi();
    const MAX_ACTIVITY_ITEMS = 50;

    function refresh() {
      vscode.postMessage({ type: 'refresh' });
    }

    function openQueueItem(id) {
      vscode.postMessage({ type: 'openQueueItem', id: id });
    }

    function openAgent(id) {
      vscode.postMessage({ type: 'openAgent', id: id });
    }

    function openCommand(command) {
      vscode.postMessage({ type: 'openCommand', command: command });
    }

    // Handle messages from extension
    window.addEventListener('message', function(event) {
      var message = event.data;
      switch (message.type) {
        case 'update':
          // Full data refresh - reload the page content
          break;
        case 'loading':
          break;
        case 'error':
          console.error('Dashboard error:', message.message);
          break;
        case 'connectionStatus':
          updateConnectionStatus(message.connected);
          break;
        case 'sseEvent':
          handleSSEEvent(message.event);
          break;
      }
    });

    function updateConnectionStatus(connected) {
      var el = document.getElementById('connection-status');
      if (!el) return;
      var dotClass = connected ? 'status-connected' : 'status-disconnected';
      var text = connected ? 'Connected' : 'Disconnected';
      el.className = 'connection-status ' + dotClass;
      var textEl = el.querySelector('.status-text');
      if (textEl) textEl.textContent = text;
    }

    function handleSSEEvent(event) {
      if (!event) return;

      // Update activity feed
      prependActivityItem(event);

      // Update stats based on event channel
      if (event.channel === 'queue') {
        updateQueueStatFromEvent(event);
      }
    }

    function prependActivityItem(event) {
      var feed = document.getElementById('activity-feed');
      if (!feed) return;

      // Check if user is scrolled near top (within 50px)
      var wasAtTop = feed.scrollTop < 50;

      var item = document.createElement('div');
      item.className = 'activity-item ' + getActivityTypeClass(event.event);
      item.setAttribute('data-event-id', event.id || '');
      item.innerHTML =
        '<span class="activity-icon">' + getActivityIcon(event.event) + '</span>' +
        '<div class="activity-content">' +
          '<span class="activity-message">' + escapeHtml(event.data && event.data.message ? event.data.message : event.event) + '</span>' +
          '<span class="activity-time">just now</span>' +
        '</div>';

      feed.insertBefore(item, feed.firstChild);

      // Cap at MAX_ACTIVITY_ITEMS
      while (feed.children.length > MAX_ACTIVITY_ITEMS) {
        feed.removeChild(feed.lastChild);
      }

      // Auto-scroll to top only if was already near top
      if (wasAtTop) {
        feed.scrollTop = 0;
      }
    }

    function updateQueueStatFromEvent(event) {
      // SSE events for queue changes - increment/decrement stat counters
      var eventType = event.event;
      if (eventType === 'queue:item:added') {
        incrementStat('pending');
      } else if (eventType === 'queue:item:removed') {
        // Could be any status removal, decrement based on event data
        var status = event.data && event.data.status ? event.data.status : 'pending';
        decrementStat(status);
      }
    }

    function incrementStat(statName) {
      var el = document.querySelector('[data-stat="' + statName + '"]');
      if (el) {
        el.textContent = parseInt(el.textContent || '0', 10) + 1;
      }
    }

    function decrementStat(statName) {
      var el = document.querySelector('[data-stat="' + statName + '"]');
      if (el) {
        var val = parseInt(el.textContent || '0', 10);
        el.textContent = Math.max(0, val - 1);
      }
    }

    function getActivityTypeClass(eventType) {
      if (!eventType) return '';
      return 'activity-' + eventType.replace(/:/g, '-');
    }

    function getActivityIcon(eventType) {
      var icons = {
        'workflow:started': '&#x25B6;',
        'workflow:completed': '&#x2713;',
        'workflow:failed': '&#x2717;',
        'workflow:cancelled': '&#x25FC;',
        'agent:connected': '&#x2191;',
        'agent:disconnected': '&#x2193;',
        'queue:item:added': '&#x002B;',
        'queue:item:removed': '&#x2212;'
      };
      return icons[eventType] || '&#x2022;';
    }

    function escapeHtml(text) {
      if (!text) return '';
      var div = document.createElement('div');
      div.appendChild(document.createTextNode(text));
      return div.innerHTML;
    }

    // Signal ready
    vscode.postMessage({ type: 'ready' });
  `;
}

// ============================================================================
// Sidebar Script
// ============================================================================

function getSidebarScript(): string {
  return `
    const vscode = acquireVsCodeApi();

    function openDashboard() {
      vscode.postMessage({ type: 'openDashboard' });
    }

    function refresh() {
      vscode.postMessage({ type: 'refresh' });
    }

    // Handle messages from extension
    window.addEventListener('message', function(event) {
      var message = event.data;
      switch (message.type) {
        case 'update':
          updateSidebarData(message.data);
          break;
        case 'connectionStatus':
          updateConnectionStatus(message.connected);
          break;
        case 'loading':
          break;
        case 'error':
          console.error('Sidebar error:', message.message);
          break;
      }
    });

    function updateConnectionStatus(connected) {
      var el = document.getElementById('connection-status');
      if (!el) return;
      var className = connected ? 'status-connected' : 'status-disconnected';
      var text = connected ? 'Connected' : 'Disconnected';
      el.className = 'connection-indicator ' + className;
      el.querySelector('span:last-child').textContent = text;
    }

    function updateSidebarData(data) {
      if (data.queueStats) {
        var parts = [];
        if (data.queueStats.pending > 0) parts.push(data.queueStats.pending + ' pending');
        if (data.queueStats.waiting > 0) parts.push(data.queueStats.waiting + ' waiting');
        if (data.queueStats.running > 0) parts.push(data.queueStats.running + ' running');
        if (data.queueStats.failed > 0) parts.push(data.queueStats.failed + ' failed');
        var queueEl = document.getElementById('queue-summary');
        if (queueEl) queueEl.textContent = parts.length > 0 ? parts.join(', ') : 'No active work items';
      }
      if (data.agentStats) {
        var parts = [];
        if (data.agentStats.available > 0) parts.push(data.agentStats.available + ' available');
        if (data.agentStats.busy > 0) parts.push(data.agentStats.busy + ' busy');
        if (data.agentStats.offline > 0) parts.push(data.agentStats.offline + ' offline');
        var agentEl = document.getElementById('agent-summary');
        if (agentEl) agentEl.textContent = parts.length > 0 ? parts.join(', ') : 'No agents registered';
      }
    }

    // Signal ready
    vscode.postMessage({ type: 'ready' });
  `;
}

// ============================================================================
// Utility Functions
// ============================================================================

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

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (char) => map[char] ?? char);
}

function getDisplayStatus(status: AgentConnectionStatus): AgentDisplayStatus {
  switch (status) {
    case 'connected':
    case 'idle':
      return 'available';
    case 'busy':
      return 'busy';
    case 'disconnected':
      return 'offline';
  }
}

function getActivityIcon(type: ActivityEventType): string {
  const icons: Record<ActivityEventType, string> = {
    'workflow:started': '&#x25B6;',
    'workflow:completed': '&#x2713;',
    'workflow:failed': '&#x2717;',
    'workflow:cancelled': '&#x25FC;',
    'agent:connected': '&#x2191;',
    'agent:disconnected': '&#x2193;',
    'queue:item:added': '&#x002B;',
    'queue:item:removed': '&#x2212;',
  };
  return icons[type] || '&#x2022;';
}

function getActivityTypeClass(type: ActivityEventType): string {
  return `activity-${type.replace(/:/g, '-')}`;
}

function formatRelativeTime(isoTimestamp: string): string {
  const now = Date.now();
  const then = new Date(isoTimestamp).getTime();
  const diffMs = now - then;

  if (diffMs < 0) { return 'just now'; }

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) { return 'just now'; }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) { return `${minutes}m ago`; }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) { return `${hours}h ago`; }

  const days = Math.floor(hours / 24);
  if (days < 30) { return `${days}d ago`; }

  return new Date(isoTimestamp).toLocaleDateString();
}

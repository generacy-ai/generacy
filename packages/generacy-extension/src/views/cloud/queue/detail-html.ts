/**
 * Job Detail Webview HTML Generator
 *
 * Generates the CSP-safe HTML content for the JobDetailPanel webview.
 * Follows the modular section-generator pattern used by the dashboard webview.
 *
 * The webview uses postMessage for all subsequent updates — this module
 * generates the initial HTML shell with embedded client-side JavaScript
 * that handles live progress rendering, phase expand/collapse, and
 * elapsed time ticking.
 */
import type {
  QueueItem,
  QueueStatus,
  QueuePriority,
  JobProgress,
} from '../../../api/types';

// ============================================================================
// Types
// ============================================================================

/** Data required to render the job detail webview */
export interface JobDetailHtmlData {
  /** The queue item to display */
  item: QueueItem;
  /** Initial progress snapshot (null if not yet loaded) */
  progress: JobProgress | null;
  /** Set of phase IDs that should be initially expanded */
  expandedPhases: Set<string>;
  /** Whether the panel is pinned */
  isPinned: boolean;
}

// ============================================================================
// Main HTML Generator
// ============================================================================

/**
 * Generate the complete HTML for the job detail webview.
 */
export function getJobDetailHtml(data: JobDetailHtmlData): string {
  const nonce = getNonce();
  const { item, progress, expandedPhases, isPinned } = data;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>Job Progress</title>
  <style nonce="${nonce}">
    ${getStyles()}
  </style>
</head>
<body>
  ${getReconnectingBanner()}
  ${getHeaderSection(item, isPinned)}
  ${getStatusBarSection(item)}
  ${getPhaseListSection()}
  ${getPRLinkSection()}
  ${getErrorSection()}
  ${getDetailsSection(item)}
  <script nonce="${nonce}">
    ${getScript(item, progress, expandedPhases)}
  </script>
</body>
</html>`;
}

// ============================================================================
// Section Generators
// ============================================================================

function getReconnectingBanner(): string {
  return `
  <div id="reconnecting-banner" class="reconnecting-banner">
    Reconnecting to server... Updates may be delayed.
  </div>`;
}

function getHeaderSection(item: QueueItem, isPinned: boolean): string {
  const pinButtonLabel = isPinned ? 'Pinned' : 'Pin';
  const pinButtonDisabled = isPinned ? 'disabled' : '';

  return `
  <div class="header">
    <div class="header-left">
      <h1 id="workflow-name">${escapeHtml(item.workflowName)}</h1>
      <div class="subtitle" id="workflow-subtitle">
        ${item.repository ? escapeHtml(item.repository) : ''}
      </div>
    </div>
    <div class="actions">
      <button onclick="pinPanel()" ${pinButtonDisabled} id="pin-button">${pinButtonLabel}</button>
      <button onclick="refreshPanel()">Refresh</button>
    </div>
  </div>`;
}

function getStatusBarSection(item: QueueItem): string {
  const statusColor = STATUS_COLORS[item.status];
  const priorityColor = PRIORITY_COLORS[item.priority];

  return `
  <div class="status-bar" id="status-bar">
    <span class="badge" id="status-badge" style="background-color: ${statusColor};">${item.status.toUpperCase()}</span>
    <span class="badge" id="priority-badge" style="background-color: ${priorityColor};">${item.priority.toUpperCase()}</span>
    <span id="phase-progress"></span>
    <span class="elapsed" id="elapsed-time"></span>
  </div>`;
}

function getPhaseListSection(): string {
  return `
  <div id="phase-list" class="phase-list">
    <div class="loading" id="loading-indicator">Loading progress data...</div>
  </div>`;
}

function getPRLinkSection(): string {
  return `
  <div id="pr-link-section" class="pr-link" style="display: none;">
    Pull Request: <a id="pr-link" href="#" onclick="openPR(event)">View PR</a>
  </div>`;
}

function getErrorSection(): string {
  return `
  <div id="error-section" class="error-section" style="display: none;">
    <div class="error-title">Error Details</div>
    <div class="error-message" id="error-message"></div>
  </div>`;
}

function getDetailsSection(item: QueueItem): string {
  const assigneeField = item.assigneeId
    ? `<div class="field">
      <span class="field-label">Assigned Agent</span>
      <span class="field-value">
        <span class="agent-link" onclick="openAgent('${escapeHtml(item.assigneeId)}')">${escapeHtml(item.assigneeId)}</span>
      </span>
    </div>`
    : '';

  return `
  <div class="section" id="details-section">
    <div class="section-title">Details</div>
    <div class="field">
      <span class="field-label">Workflow ID</span>
      <span class="field-value"><code id="workflow-id">${escapeHtml(item.workflowId)}</code></span>
    </div>
    <div class="field">
      <span class="field-label">Queue Item ID</span>
      <span class="field-value"><code id="item-id">${escapeHtml(item.id)}</code></span>
    </div>
    ${assigneeField}
  </div>`;
}

// ============================================================================
// Color Constants
// ============================================================================

const STATUS_COLORS: Record<QueueStatus, string> = {
  pending: '#f0ad4e',
  running: '#5bc0de',
  completed: '#5cb85c',
  failed: '#d9534f',
  cancelled: '#777',
};

const PRIORITY_COLORS: Record<QueuePriority, string> = {
  low: '#777',
  normal: '#5bc0de',
  high: '#f0ad4e',
  urgent: '#d9534f',
};

// ============================================================================
// Styles
// ============================================================================

function getStyles(): string {
  return `
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      padding: 20px;
      line-height: 1.6;
      margin: 0;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .header-left h1 {
      margin: 0;
      font-size: 1.4em;
    }
    .header-left .subtitle {
      margin: 4px 0 0;
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
    }
    .actions {
      display: flex;
      gap: 8px;
    }
    .actions button {
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 4px 12px;
      font-size: 12px;
      cursor: pointer;
      border-radius: 4px;
    }
    .actions button:hover:not(:disabled) {
      background-color: var(--vscode-button-secondaryHoverBackground);
    }
    .actions button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-weight: 500;
      text-transform: uppercase;
      font-size: 0.85em;
      color: white;
    }
    .status-bar {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 20px;
      padding: 8px 12px;
      background-color: var(--vscode-textCodeBlock-background);
      border-radius: 4px;
    }
    .status-bar .elapsed {
      color: var(--vscode-descriptionForeground);
    }
    .reconnecting-banner {
      display: none;
      padding: 8px 12px;
      margin-bottom: 16px;
      background-color: var(--vscode-inputValidation-warningBackground);
      border: 1px solid var(--vscode-inputValidation-warningBorder);
      border-radius: 4px;
      font-size: 0.9em;
    }
    .reconnecting-banner.visible {
      display: block;
    }
    .phase-list {
      margin-bottom: 24px;
    }
    .phase {
      margin-bottom: 4px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      overflow: hidden;
    }
    .phase-header {
      display: flex;
      align-items: center;
      padding: 8px 12px;
      cursor: pointer;
      user-select: none;
      gap: 8px;
    }
    .phase-header:hover {
      background-color: var(--vscode-list-hoverBackground);
    }
    .phase-icon {
      flex-shrink: 0;
      width: 18px;
      text-align: center;
    }
    .phase-name {
      flex: 1;
      font-weight: 500;
    }
    .phase-duration {
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
    }
    .phase-chevron {
      color: var(--vscode-descriptionForeground);
      font-size: 0.8em;
      transition: transform 0.15s;
    }
    .phase.expanded .phase-chevron {
      transform: rotate(90deg);
    }
    .phase-steps {
      display: none;
      border-top: 1px solid var(--vscode-panel-border);
      padding: 4px 0;
    }
    .phase.expanded .phase-steps {
      display: block;
    }
    .step {
      display: flex;
      align-items: center;
      padding: 4px 12px 4px 40px;
      gap: 8px;
      font-size: 0.9em;
    }
    .step-icon {
      flex-shrink: 0;
      width: 16px;
      text-align: center;
    }
    .step-name {
      flex: 1;
    }
    .step-duration {
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
    }
    .step-output {
      color: var(--vscode-descriptionForeground);
      font-size: 0.85em;
      padding: 2px 12px 4px 68px;
    }
    .step-error {
      color: var(--vscode-inputValidation-errorForeground);
      font-size: 0.85em;
      padding: 2px 12px 4px 68px;
      background-color: var(--vscode-inputValidation-errorBackground);
    }
    .section {
      margin-bottom: 24px;
    }
    .section-title {
      font-weight: 600;
      font-size: 1.1em;
      margin-bottom: 12px;
      color: var(--vscode-textLink-foreground);
    }
    .field {
      display: flex;
      margin-bottom: 8px;
    }
    .field-label {
      font-weight: 500;
      min-width: 140px;
      color: var(--vscode-descriptionForeground);
    }
    .field-value {
      flex: 1;
    }
    code {
      font-family: var(--vscode-editor-font-family);
      background-color: var(--vscode-textCodeBlock-background);
      padding: 2px 6px;
      border-radius: 3px;
    }
    .error-section {
      background-color: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      border-radius: 4px;
      padding: 12px;
      margin-top: 16px;
    }
    .error-title {
      color: var(--vscode-inputValidation-errorForeground);
      font-weight: 600;
      margin-bottom: 8px;
    }
    .error-message {
      font-family: var(--vscode-editor-font-family);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .pr-link {
      margin-top: 16px;
      padding: 12px;
      background-color: var(--vscode-textCodeBlock-background);
      border-radius: 4px;
    }
    .pr-link a {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      text-decoration: underline;
    }
    .pr-link a:hover {
      color: var(--vscode-textLink-activeForeground);
    }
    .agent-link {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      text-decoration: underline;
    }
    .agent-link:hover {
      color: var(--vscode-textLink-activeForeground);
    }
    .loading {
      text-align: center;
      padding: 40px;
      color: var(--vscode-descriptionForeground);
    }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    .spinner {
      display: inline-block;
      animation: spin 1s linear infinite;
    }`;
}

// ============================================================================
// Client-Side Script
// ============================================================================

function getScript(
  item: QueueItem,
  progress: JobProgress | null,
  expandedPhases: Set<string>
): string {
  // Serialize only the fields needed by the client-side JS
  const itemState = JSON.stringify({
    status: item.status,
    startedAt: item.startedAt,
    completedAt: item.completedAt,
  });
  const progressState = progress ? JSON.stringify(progress) : 'null';
  const expandedState = JSON.stringify(Array.from(expandedPhases));

  return `
    const vscode = acquireVsCodeApi();

    // ======================================================================
    // State
    // ======================================================================
    let currentItem = ${itemState};
    let currentProgress = ${progressState};
    let expandedPhases = new Set(${expandedState});
    let elapsedTimer = null;

    // Track user's manual expand/collapse overrides so progressUpdate
    // doesn't clobber them. Keys are phase IDs, values are the desired state.
    let userToggledPhases = new Map();

    // ======================================================================
    // Status icon helpers
    // ======================================================================
    const statusIcons = {
      pending: '\\u2B1C',
      running: '\\uD83D\\uDD04',
      completed: '\\u2705',
      failed: '\\u274C',
      skipped: '\\u23ED',
    };

    function getStatusIcon(status) {
      return statusIcons[status] || '\\u2B1C';
    }

    // ======================================================================
    // Duration formatting
    // ======================================================================
    function formatDurationMs(ms) {
      if (ms == null || ms < 0) return '';
      if (ms < 1000) return ms + 'ms';
      const sec = Math.floor(ms / 1000);
      if (sec < 60) return sec + 's';
      const min = Math.floor(sec / 60);
      const remSec = sec % 60;
      if (min < 60) return min + 'm ' + remSec + 's';
      const hr = Math.floor(min / 60);
      return hr + 'h ' + (min % 60) + 'm';
    }

    function formatElapsed(startStr, endStr) {
      if (!startStr) return '';
      const start = new Date(startStr).getTime();
      const end = endStr ? new Date(endStr).getTime() : Date.now();
      return formatDurationMs(end - start);
    }

    // ======================================================================
    // Rendering
    // ======================================================================
    function renderPhaseList(progress) {
      const container = document.getElementById('phase-list');
      if (!progress || !progress.phases || progress.phases.length === 0) {
        container.innerHTML = '<div class="loading">No progress data available.</div>';
        return;
      }

      let html = '';
      for (const phase of progress.phases) {
        const isExpanded = expandedPhases.has(phase.id);
        const icon = getStatusIcon(phase.status);
        const duration = phase.durationMs != null
          ? formatDurationMs(phase.durationMs)
          : (phase.status === 'running' && phase.startedAt ? formatElapsed(phase.startedAt) : '');

        html += '<div class="phase' + (isExpanded ? ' expanded' : '') + '" data-phase-id="' + escapeAttr(phase.id) + '">';
        html += '<div class="phase-header" onclick="togglePhase(\\'' + escapeAttr(phase.id) + '\\')">';
        html += '<span class="phase-chevron">\\u25B6</span>';
        html += '<span class="phase-icon">' + icon + '</span>';
        html += '<span class="phase-name">' + escapeStr(phase.name) + '</span>';
        html += '<span class="phase-duration">' + duration + '</span>';
        html += '</div>';

        html += '<div class="phase-steps">';
        if (phase.steps && phase.steps.length > 0) {
          for (const step of phase.steps) {
            const stepIcon = getStatusIcon(step.status);
            const stepDuration = step.durationMs != null
              ? formatDurationMs(step.durationMs)
              : (step.status === 'running' && step.startedAt ? formatElapsed(step.startedAt) : '');

            html += '<div class="step" data-step-id="' + escapeAttr(step.id) + '">';
            html += '<span class="step-icon">' + stepIcon + '</span>';
            html += '<span class="step-name">' + escapeStr(step.name) + '</span>';
            html += '<span class="step-duration">' + stepDuration + '</span>';
            html += '</div>';

            if (step.output) {
              html += '<div class="step-output">' + escapeStr(step.output) + '</div>';
            }
            if (step.error) {
              html += '<div class="step-error">' + escapeStr(step.error) + '</div>';
            }
          }
        } else {
          html += '<div class="step"><span style="color: var(--vscode-descriptionForeground)">No steps</span></div>';
        }
        html += '</div>';
        html += '</div>';
      }

      container.innerHTML = html;
    }

    function updateStatusBar(item, progress) {
      const statusBadge = document.getElementById('status-badge');
      const phaseProgress = document.getElementById('phase-progress');
      const elapsedTime = document.getElementById('elapsed-time');

      if (statusBadge) {
        const colors = {
          pending: '#f0ad4e', running: '#5bc0de', completed: '#5cb85c',
          failed: '#d9534f', cancelled: '#777'
        };
        statusBadge.style.backgroundColor = colors[item.status] || '#777';
        statusBadge.textContent = item.status.toUpperCase();
      }

      if (phaseProgress && progress) {
        let text = '';
        if (item.status === 'completed') {
          // Static: show completion summary
          text = progress.completedPhases + '/' + progress.totalPhases + ' phases completed';
          if (progress.skippedPhases > 0) {
            text += ' (' + progress.skippedPhases + ' skipped)';
          }
        } else if (item.status === 'failed' || item.status === 'cancelled') {
          // Static: show where it stopped
          const failedPhase = progress.phases.find(function(p) { return p.status === 'failed'; });
          if (failedPhase) {
            text = 'Failed at ' + failedPhase.name;
          } else {
            text = progress.completedPhases + '/' + progress.totalPhases + ' phases completed';
          }
          if (progress.skippedPhases > 0) {
            text += ' (' + progress.skippedPhases + ' skipped)';
          }
        } else {
          // Live: show current progress
          const current = progress.currentPhaseIndex + 1;
          const total = progress.totalPhases;
          const currentPhase = progress.phases[progress.currentPhaseIndex];
          text = 'Phase ' + current + '/' + total;
          if (progress.skippedPhases > 0) {
            text += ' (' + progress.skippedPhases + ' skipped)';
          }
          if (currentPhase) {
            text += ' \\u00B7 ' + currentPhase.name;
          }
        }
        phaseProgress.textContent = text;
      } else if (phaseProgress) {
        phaseProgress.textContent = '';
      }

      if (elapsedTime) {
        const elapsed = formatElapsed(item.startedAt, item.completedAt);
        if (!elapsed) {
          elapsedTime.textContent = '';
        } else if (item.completedAt) {
          elapsedTime.textContent = 'Duration: ' + elapsed;
        } else {
          elapsedTime.textContent = 'Elapsed: ' + elapsed;
        }
      }
    }

    function updatePRLink(progress) {
      const section = document.getElementById('pr-link-section');
      const link = document.getElementById('pr-link');
      if (progress && progress.pullRequestUrl) {
        section.style.display = 'block';
        link.setAttribute('data-url', progress.pullRequestUrl);
        link.textContent = progress.pullRequestUrl;
      } else {
        section.style.display = 'none';
      }
    }

    function updateErrorSection(item) {
      const section = document.getElementById('error-section');
      const message = document.getElementById('error-message');
      if (item.error) {
        section.style.display = 'block';
        message.textContent = item.error;
      } else {
        section.style.display = 'none';
      }
    }

    function renderAll(item, progress) {
      currentItem = item;
      currentProgress = progress;

      updateStatusBar(item, progress);
      renderPhaseList(progress);
      updatePRLink(progress);
      updateErrorSection(item);
      updateElapsedTimer();
    }

    // ======================================================================
    // Elapsed time ticker
    // ======================================================================
    function updateElapsedTimer() {
      if (elapsedTimer) {
        clearInterval(elapsedTimer);
        elapsedTimer = null;
      }

      // Only tick for running jobs
      if (currentItem.status !== 'running') return;

      elapsedTimer = setInterval(function() {
        // Update header elapsed
        const elapsedTime = document.getElementById('elapsed-time');
        if (elapsedTime && currentItem.startedAt) {
          elapsedTime.textContent = 'Elapsed: ' + formatElapsed(currentItem.startedAt);
        }

        // Update running phase/step durations
        if (currentProgress && currentProgress.phases) {
          for (const phase of currentProgress.phases) {
            if (phase.status === 'running' && phase.startedAt) {
              const el = document.querySelector('[data-phase-id="' + phase.id + '"] .phase-duration');
              if (el) el.textContent = formatElapsed(phase.startedAt);
            }
            if (phase.steps) {
              for (const step of phase.steps) {
                if (step.status === 'running' && step.startedAt) {
                  const el = document.querySelector('[data-step-id="' + step.id + '"] .step-duration');
                  if (el) el.textContent = formatElapsed(step.startedAt);
                }
              }
            }
          }
        }
      }, 1000);
    }

    // ======================================================================
    // HTML escaping
    // ======================================================================
    function escapeStr(s) {
      if (!s) return '';
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function escapeAttr(s) {
      if (!s) return '';
      return s.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
    }

    // ======================================================================
    // Interaction handlers
    // ======================================================================
    function togglePhase(phaseId) {
      const wasExpanded = expandedPhases.has(phaseId);
      if (wasExpanded) {
        expandedPhases.delete(phaseId);
      } else {
        expandedPhases.add(phaseId);
      }

      // Record this as a manual user override so progressUpdate won't undo it
      userToggledPhases.set(phaseId, !wasExpanded);

      const el = document.querySelector('[data-phase-id="' + phaseId + '"]');
      if (el) {
        el.classList.toggle('expanded');
      }

      vscode.postMessage({ type: 'togglePhase', phaseId: phaseId });
    }

    function pinPanel() {
      vscode.postMessage({ type: 'pin' });
      const btn = document.getElementById('pin-button');
      if (btn) {
        btn.textContent = 'Pinned';
        btn.disabled = true;
      }
    }

    function refreshPanel() {
      vscode.postMessage({ type: 'refresh' });
    }

    function openPR(event) {
      event.preventDefault();
      const link = document.getElementById('pr-link');
      const url = link ? link.getAttribute('data-url') : null;
      if (url) {
        vscode.postMessage({ type: 'openPR', url: url });
      }
    }

    function openAgent(agentId) {
      vscode.postMessage({ type: 'openAgent', agentId: agentId });
    }

    // ======================================================================
    // Message listener
    // ======================================================================
    window.addEventListener('message', function(event) {
      const message = event.data;

      switch (message.type) {
        case 'update': {
          // Full update — reset user overrides and apply extension state
          userToggledPhases = new Map();
          if (message.data.expandedPhases) {
            expandedPhases = new Set(message.data.expandedPhases);
          }
          renderAll(message.data.item, message.data.progress);
          break;
        }

        case 'progressUpdate': {
          currentProgress = message.progress;
          // Merge smart expand/collapse from extension with user's manual overrides.
          // The extension sends the set of phases that *should* be expanded based on
          // running status. We apply those changes but preserve any manual user toggles.
          if (message.expandedPhases) {
            const extensionExpanded = new Set(message.expandedPhases);
            // Apply extension-driven changes for phases the user hasn't manually toggled
            if (currentProgress && currentProgress.phases) {
              for (const phase of currentProgress.phases) {
                if (userToggledPhases.has(phase.id)) {
                  // User manually toggled this phase — keep their preference
                  // But if a phase transitions to running, auto-expand it regardless
                  // (clear the user override since the state changed meaningfully)
                  if (phase.status === 'running' && !expandedPhases.has(phase.id)) {
                    expandedPhases.add(phase.id);
                    userToggledPhases.delete(phase.id);
                  }
                } else {
                  // No user override — apply extension's smart logic
                  if (extensionExpanded.has(phase.id)) {
                    expandedPhases.add(phase.id);
                  } else {
                    expandedPhases.delete(phase.id);
                  }
                }
              }
            }
          }
          updateStatusBar(currentItem, currentProgress);
          renderPhaseList(currentProgress);
          updatePRLink(currentProgress);
          break;
        }

        case 'connectionStatus': {
          const banner = document.getElementById('reconnecting-banner');
          if (banner) {
            banner.classList.toggle('visible', !message.connected);
          }
          break;
        }

        case 'error': {
          const container = document.getElementById('phase-list');
          if (container) {
            container.innerHTML = '<div class="loading" style="color: var(--vscode-inputValidation-errorForeground);">' + escapeStr(message.message) + '</div>';
          }
          break;
        }
      }
    });

    // Notify extension that webview is ready
    vscode.postMessage({ type: 'ready' });`;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Generate a 32-character alphanumeric nonce for CSP.
 */
function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

/**
 * Escape HTML special characters for safe embedding in HTML content.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

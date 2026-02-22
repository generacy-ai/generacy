/**
 * Agent Actions - Command handlers for agent monitoring operations.
 * Provides view logs, view mode toggling, and tree item selection validation.
 */
import * as vscode from 'vscode';
import { getLogger } from '../../../utils/logger';
import type { Agent } from '../../../api/types';
import { AgentTreeItem, isAgentTreeItem } from './tree-item';
import type { AgentTreeProvider } from './provider';
import { CLOUD_COMMANDS } from '../../../constants';
import { AgentLogChannel } from './log-channel';

/**
 * View agent logs in a VS Code output channel with historical + live streaming.
 * Delegates to AgentLogChannel which manages output channels per agent.
 */
export async function viewAgentLogs(agent: Agent): Promise<void> {
  await AgentLogChannel.openAgentLogs(agent);
}

/**
 * Register all agent action commands.
 *
 * Commands registered:
 * - `generacy.agents.viewLogs` - View logs for a selected agent
 * - `generacy.agents.viewByStatus` - Switch to grouped-by-status view mode
 * - `generacy.agents.viewFlat` - Switch to flat list view mode
 */
export function registerAgentActions(
  context: vscode.ExtensionContext,
  provider: AgentTreeProvider
): void {
  const logger = getLogger();
  logger.debug('Registering agent action commands');

  // View logs action - requires a selected agent tree item
  context.subscriptions.push(
    vscode.commands.registerCommand(
      CLOUD_COMMANDS.viewAgentLogs,
      async (item?: AgentTreeItem) => {
        if (!item || !isAgentTreeItem(item)) {
          vscode.window.showWarningMessage('Please select an agent to view logs');
          return;
        }
        await viewAgentLogs(item.agent);
      }
    )
  );

  // View by status - group agents by their display status
  context.subscriptions.push(
    vscode.commands.registerCommand(CLOUD_COMMANDS.viewAgentsByStatus, () => {
      provider.setViewMode('byStatus');
    })
  );

  // View flat - show agents in a flat list
  context.subscriptions.push(
    vscode.commands.registerCommand(CLOUD_COMMANDS.viewAgentsFlat, () => {
      provider.setViewMode('flat');
    })
  );

  logger.info('Agent action commands registered');
}

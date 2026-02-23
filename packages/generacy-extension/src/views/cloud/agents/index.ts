/**
 * Agents module - Tree view for monitoring agent pool status.
 */

export { AgentTreeProvider, createAgentTreeProvider } from './provider';
export type { AgentViewMode, AgentTreeProviderOptions } from './provider';
export {
  AgentTreeItem,
  AgentGroupItem,
  AgentEmptyItem,
  AgentLoadingItem,
  AgentErrorItem,
  getDisplayStatus,
  isAgentTreeItem,
} from './tree-item';
export type { AgentExplorerItem } from './tree-item';
export { viewAgentLogs, registerAgentActions } from './actions';
export { AgentLogChannel } from './log-channel';

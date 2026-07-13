// @generacy-ai/config - Centralized workspace configuration

export {
  WorkspaceRepoSchema,
  WorkspaceConfigSchema,
  type WorkspaceRepo,
  type WorkspaceConfig,
} from './workspace-schema.js';

export {
  getWorkspaceRepos,
  getMonitoredRepos,
  getRepoNames,
  getRepoWorkdir,
  resolveSiblingWorkdirs,
} from './repos.js';

export { parseRepoInput, parseRepoList } from './parse-repo-input.js';

export { detectRepoDrift } from './drift.js';

export {
  TemplateReposSchema,
  TemplateConfigSchema,
  OrchestratorSettingsSchema,
  AgentEntrySchema,
  WorkflowAgentEntriesSchema,
  AgentsConfigSchema,
  type TemplateConfig,
  type OrchestratorSettings,
  type AgentEntry,
  type WorkflowAgentEntries,
  type AgentsConfig,
} from './template-schema.js';

export { convertTemplateConfig } from './convert-template.js';

export { tryLoadWorkspaceConfig, tryLoadOrchestratorSettings, tryLoadDefaultsRole, tryLoadDefaultsAgent, findWorkspaceConfigPath, scanForWorkspaceConfig } from './loader.js';

export {
  ClusterYamlSchema,
  ClusterLocalYamlSchema,
  type ClusterYamlData,
  type ClusterLocalYamlData,
} from './cluster-config-schema.js';

export { readMergedClusterConfig, type MergedClusterConfig } from './cluster-config.js';

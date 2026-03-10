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
} from './repos.js';

export { parseRepoInput, parseRepoList } from './parse-repo-input.js';

export { detectRepoDrift } from './drift.js';

export {
  TemplateReposSchema,
  TemplateConfigSchema,
  OrchestratorSettingsSchema,
  type TemplateConfig,
  type OrchestratorSettings,
} from './template-schema.js';

export { convertTemplateConfig } from './convert-template.js';

export { tryLoadWorkspaceConfig, tryLoadOrchestratorSettings, findWorkspaceConfigPath, scanForWorkspaceConfig } from './loader.js';

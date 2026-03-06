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
  type TemplateConfig,
} from './template-schema.js';

export { convertTemplateConfig } from './convert-template.js';

export { tryLoadWorkspaceConfig, findWorkspaceConfigPath, scanForWorkspaceConfig } from './loader.js';

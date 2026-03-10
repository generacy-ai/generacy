import type { WorkspaceConfig, WorkspaceRepo } from './workspace-schema.js';
import type { TemplateConfig } from './template-schema.js';
import { parseRepoInput } from './parse-repo-input.js';

/**
 * Convert a template config (cluster-template format) to a WorkspaceConfig.
 *
 * Maps `repos.primary` → org + first repo, `repos.dev` → monitored repos,
 * `repos.clone` → unmonitored repos.
 */
export function convertTemplateConfig(template: TemplateConfig): WorkspaceConfig {
  const primary = parseRepoInput(template.repos.primary, template.project?.org_name);

  const repos: WorkspaceRepo[] = [
    { name: primary.repo, monitor: true },
    ...template.repos.dev.map(r => {
      const parsed = parseRepoInput(r, primary.owner);
      return { name: parsed.repo, monitor: true };
    }),
    ...template.repos.clone.map(r => {
      const parsed = parseRepoInput(r, primary.owner);
      return { name: parsed.repo, monitor: false };
    }),
  ];

  return { org: primary.owner, branch: 'develop', repos };
}

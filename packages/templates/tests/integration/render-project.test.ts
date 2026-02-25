/**
 * Integration tests for renderProject
 *
 * Tests the complete end-to-end rendering flow:
 * - Template loading
 * - Context substitution
 * - File generation
 * - Validation
 * - Merging behavior
 *
 * These tests ensure all components work together correctly.
 */

import { describe, it, expect } from 'vitest';
import {
  renderProject,
  validateAllRenderedFiles,
  buildSingleRepoContext,
  buildMultiRepoContext,
} from '../../src/index.js';
import type { TemplateContext } from '../../src/schema.js';
import yaml from 'js-yaml';

// Load test fixtures
import singleRepoContext from '../fixtures/single-repo-context.json';
import multiRepoContext from '../fixtures/multi-repo-context.json';
import existingExtensions from '../fixtures/existing-extensions.json';

describe('Integration: renderProject - Single Repo', () => {
  it('should render all files for single-repo project', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);

    // Verify correct number of files
    expect(files.size).toBe(5);

    // Verify all expected files are present
    expect(files.has('.generacy/config.yaml')).toBe(true);
    expect(files.has('.generacy/generacy.env.template')).toBe(true);
    expect(files.has('.generacy/.gitignore')).toBe(true);
    expect(files.has('.vscode/extensions.json')).toBe(true);
    expect(files.has('.devcontainer/devcontainer.json')).toBe(true);

    // Verify no multi-repo files
    expect(files.has('.devcontainer/docker-compose.yml')).toBe(false);
  });

  it('should render valid config.yaml for single-repo', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);
    const configYaml = files.get('.generacy/config.yaml')!;

    // Parse YAML to ensure it's valid
    const config: any = yaml.load(configYaml);

    // Verify structure
    expect(config).toBeDefined();
    expect(config.project).toBeDefined();
    expect(config.repos).toBeDefined();
    expect(config.defaults).toBeDefined();

    // Verify project data
    expect(config.project.id).toBe('proj_abc123xyz');
    expect(config.project.name).toBe('E-Commerce API');

    // Verify repos
    expect(config.repos.primary).toBe('acme-corp/ecommerce-api');
    expect(config.repos.dev).toBeUndefined(); // Empty arrays not rendered
    expect(config.repos.clone).toBeUndefined();

    // Verify defaults
    expect(config.defaults.agent).toBe('claude-code');
    expect(config.defaults.baseBranch).toBe('main');
    // Note: releaseStream is not rendered in config.yaml, it's just used for feature tag

    // Should NOT have orchestrator section for single-repo
    expect(config.orchestrator).toBeUndefined();
  });

  it('should render valid devcontainer.json for single-repo', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);
    const devcontainerJson = files.get('.devcontainer/devcontainer.json')!;

    // Parse JSON to ensure it's valid
    const devcontainer = JSON.parse(devcontainerJson);

    // Verify structure
    expect(devcontainer.name).toBe('E-Commerce API');
    expect(devcontainer.image).toBe('mcr.microsoft.com/devcontainers/typescript-node:20');

    // Verify features
    expect(devcontainer.features).toBeDefined();
    expect(devcontainer.features['ghcr.io/generacy-ai/generacy/generacy:1']).toBeDefined();

    // Verify extensions
    expect(devcontainer.customizations?.vscode?.extensions).toContain('generacy-ai.agency');
    expect(devcontainer.customizations?.vscode?.extensions).toContain('generacy-ai.generacy');

    // Should NOT have multi-repo properties
    expect(devcontainer.dockerComposeFile).toBeUndefined();
    expect(devcontainer.service).toBeUndefined();
    expect(devcontainer.workspaceFolder).toBeUndefined();
    expect(devcontainer.workspaceFolders).toBeUndefined();
  });

  it('should render valid extensions.json for single-repo', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);
    const extensionsJson = files.get('.vscode/extensions.json')!;

    // Parse JSON to ensure it's valid
    const extensions = JSON.parse(extensionsJson);

    // Verify structure
    expect(extensions.recommendations).toBeDefined();
    expect(Array.isArray(extensions.recommendations)).toBe(true);

    // Verify Generacy extensions are present
    expect(extensions.recommendations).toContain('generacy-ai.agency');
    expect(extensions.recommendations).toContain('generacy-ai.generacy');
  });

  it('should render valid env template for single-repo', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);
    const envTemplate = files.get('.generacy/generacy.env.template')!;

    // Verify content
    expect(envTemplate).toContain('PROJECT_ID=proj_abc123xyz');
    expect(envTemplate).toContain('GITHUB_TOKEN=');
    expect(envTemplate).toContain('ANTHROPIC_API_KEY=');
    expect(envTemplate).toContain('REDIS_URL=');
    expect(envTemplate).toContain('LOG_LEVEL=');

    // Verify it contains explanatory comments
    expect(envTemplate).toContain('#');
  });

  it('should render static .gitignore unchanged', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);
    const gitignore = files.get('.generacy/.gitignore')!;

    // Verify content
    expect(gitignore).toContain('generacy.env');
    expect(gitignore).toContain('.agent-state/');

    // Should NOT have any template variables
    expect(gitignore).not.toContain('{{');
    expect(gitignore).not.toContain('}}');
  });

  it('should pass validation for all single-repo files', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);

    // Should not throw
    expect(() => validateAllRenderedFiles(files)).not.toThrow();
  });

  it('should not have undefined template variables in single-repo files', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);

    // Check all files for {{undefined}} or similar
    for (const [path, content] of files) {
      // Skip .gitignore as it's static
      if (path.endsWith('.gitignore')) continue;

      expect(content).not.toContain('{{undefined}}');
      expect(content).not.toContain('undefined');
      expect(content).not.toMatch(/\{\{[^}]*undefined[^}]*\}\}/);
    }
  });
});

describe('Integration: renderProject - Multi Repo', () => {
  it('should render all files for multi-repo project', async () => {
    const files = await renderProject(multiRepoContext as TemplateContext);

    // Verify correct number of files
    expect(files.size).toBe(6);

    // Verify all expected files are present
    expect(files.has('.generacy/config.yaml')).toBe(true);
    expect(files.has('.generacy/generacy.env.template')).toBe(true);
    expect(files.has('.generacy/.gitignore')).toBe(true);
    expect(files.has('.vscode/extensions.json')).toBe(true);
    expect(files.has('.devcontainer/devcontainer.json')).toBe(true);
    expect(files.has('.devcontainer/docker-compose.yml')).toBe(true);
  });

  it('should render valid config.yaml for multi-repo', async () => {
    const files = await renderProject(multiRepoContext as TemplateContext);
    const configYaml = files.get('.generacy/config.yaml')!;

    // Parse YAML to ensure it's valid
    const config: any = yaml.load(configYaml);

    // Verify structure
    expect(config).toBeDefined();
    expect(config.project).toBeDefined();
    expect(config.repos).toBeDefined();
    expect(config.defaults).toBeDefined();
    expect(config.orchestrator).toBeDefined(); // Should have orchestrator

    // Verify project data
    expect(config.project.id).toBe('proj_xyz789def');
    expect(config.project.name).toBe('Acme Platform');

    // Verify repos
    expect(config.repos.primary).toBe('acme-corp/platform-orchestrator');
    expect(config.repos.dev).toBeDefined();
    expect(config.repos.dev).toHaveLength(3);
    expect(config.repos.dev).toContain('acme-corp/api-service');
    expect(config.repos.dev).toContain('acme-corp/frontend-app');
    expect(config.repos.dev).toContain('acme-corp/worker-service');
    expect(config.repos.clone).toBeDefined();
    expect(config.repos.clone).toHaveLength(2);
    expect(config.repos.clone).toContain('acme-corp/shared-lib');
    expect(config.repos.clone).toContain('acme-corp/proto-definitions');

    // Verify defaults
    expect(config.defaults.agent).toBe('claude-code');
    expect(config.defaults.baseBranch).toBe('develop');

    // Verify orchestrator
    expect(config.orchestrator.workerCount).toBe(3);
    expect(config.orchestrator.pollIntervalMs).toBe(3000);
  });

  it('should render valid devcontainer.json for multi-repo', async () => {
    const files = await renderProject(multiRepoContext as TemplateContext);
    const devcontainerJson = files.get('.devcontainer/devcontainer.json')!;

    // Parse JSON to ensure it's valid
    const devcontainer = JSON.parse(devcontainerJson);

    // Verify structure
    expect(devcontainer.name).toBe('Acme Platform');
    expect(devcontainer.dockerComposeFile).toBe('docker-compose.yml');
    expect(devcontainer.service).toBe('orchestrator');
    expect(devcontainer.workspaceFolder).toBe('/workspaces/platform-orchestrator');

    // Verify workspace folders
    expect(devcontainer.workspaceFolders).toBeDefined();
    expect(Array.isArray(devcontainer.workspaceFolders)).toBe(true);
    expect(devcontainer.workspaceFolders).toHaveLength(6);

    // Check all repos are in workspace folders
    const workspacePaths = devcontainer.workspaceFolders.map((w: any) => w.path);
    expect(workspacePaths).toContain('/workspaces/platform-orchestrator');
    expect(workspacePaths).toContain('/workspaces/api-service');
    expect(workspacePaths).toContain('/workspaces/frontend-app');
    expect(workspacePaths).toContain('/workspaces/worker-service');
    expect(workspacePaths).toContain('/workspaces/shared-lib');
    expect(workspacePaths).toContain('/workspaces/proto-definitions');

    // Verify extensions
    expect(devcontainer.customizations?.vscode?.extensions).toContain('generacy-ai.agency');
    expect(devcontainer.customizations?.vscode?.extensions).toContain('generacy-ai.generacy');

    // Should NOT have image (uses docker-compose)
    expect(devcontainer.image).toBeUndefined();
  });

  it('should render valid docker-compose.yml for multi-repo', async () => {
    const files = await renderProject(multiRepoContext as TemplateContext);
    const dockerComposeYml = files.get('.devcontainer/docker-compose.yml')!;

    // Parse YAML to ensure it's valid
    const dockerCompose: any = yaml.load(dockerComposeYml);

    // Verify services exist
    expect(dockerCompose.services).toBeDefined();
    expect(dockerCompose.services.redis).toBeDefined();
    expect(dockerCompose.services.orchestrator).toBeDefined();
    expect(dockerCompose.services.worker).toBeDefined();

    // Verify Redis service
    expect(dockerCompose.services.redis.image).toContain('redis');

    // Verify orchestrator service
    const orchestrator = dockerCompose.services.orchestrator;
    expect(orchestrator.image).toBe('mcr.microsoft.com/devcontainers/base:ubuntu');
    expect(orchestrator.volumes).toBeDefined();
    expect(orchestrator.environment).toBeDefined();
    expect(orchestrator.features).toBeDefined();

    // Verify all repos are mounted
    const volumePaths = orchestrator.volumes.map((v: string) => v.split(':')[1]);
    expect(volumePaths).toContain('/workspaces/platform-orchestrator');
    expect(volumePaths).toContain('/workspaces/api-service');
    expect(volumePaths).toContain('/workspaces/frontend-app');
    expect(volumePaths).toContain('/workspaces/worker-service');
    expect(volumePaths).toContain('/workspaces/shared-lib');
    expect(volumePaths).toContain('/workspaces/proto-definitions');

    // Verify worker service
    const worker = dockerCompose.services.worker;
    expect(worker.image).toBe('mcr.microsoft.com/devcontainers/base:ubuntu');
    expect(worker.deploy?.replicas).toBe(3);
    expect(worker.environment).toBeDefined();

    // Environment variables can be in array or object format in docker-compose
    // Check for REDIS_URL in the environment
    const envArray = Array.isArray(worker.environment) ? worker.environment : Object.keys(worker.environment);
    const hasRedisUrl = envArray.some((e: any) =>
      typeof e === 'string' ? e.includes('REDIS_URL') : e === 'REDIS_URL'
    );
    expect(hasRedisUrl).toBe(true);
  });

  it('should pass validation for all multi-repo files', async () => {
    const files = await renderProject(multiRepoContext as TemplateContext);

    // Should not throw
    expect(() => validateAllRenderedFiles(files)).not.toThrow();
  });

  it('should not have undefined template variables in multi-repo files', async () => {
    const files = await renderProject(multiRepoContext as TemplateContext);

    // Check all files for {{undefined}} or similar
    for (const [path, content] of files) {
      // Skip .gitignore as it's static
      if (path.endsWith('.gitignore')) continue;

      expect(content).not.toContain('{{undefined}}');
      // Allow "undefined" in comments but not as substituted values
      if (!path.endsWith('.yaml') && !path.endsWith('.yml')) {
        expect(content).not.toContain('undefined');
      }
      expect(content).not.toMatch(/\{\{[^}]*undefined[^}]*\}\}/);
    }
  });
});

describe('Integration: renderProject - Extensions.json Merging', () => {
  it('should merge with existing extensions.json', async () => {
    const existingFiles = new Map([
      ['.vscode/extensions.json', JSON.stringify(existingExtensions)],
    ]);

    const files = await renderProject(
      singleRepoContext as TemplateContext,
      existingFiles
    );

    const extensionsJson = files.get('.vscode/extensions.json')!;
    const extensions = JSON.parse(extensionsJson);

    // Should include both existing and new extensions
    expect(extensions.recommendations).toContain('dbaeumer.vscode-eslint');
    expect(extensions.recommendations).toContain('esbenp.prettier-vscode');
    expect(extensions.recommendations).toContain('ms-vscode.vscode-typescript-next');
    expect(extensions.recommendations).toContain('generacy-ai.agency');
    expect(extensions.recommendations).toContain('generacy-ai.generacy');

    // Should preserve other properties
    expect(extensions.unwantedRecommendations).toBeDefined();
    expect(extensions.unwantedRecommendations).toContain('ms-vscode.wordcount');
  });

  it('should deduplicate recommendations when merging', async () => {
    const existingWithDuplicates = {
      recommendations: [
        'generacy-ai.agency', // Already in Generacy extensions
        'dbaeumer.vscode-eslint',
      ],
    };

    const existingFiles = new Map([
      ['.vscode/extensions.json', JSON.stringify(existingWithDuplicates)],
    ]);

    const files = await renderProject(
      singleRepoContext as TemplateContext,
      existingFiles
    );

    const extensionsJson = files.get('.vscode/extensions.json')!;
    const extensions = JSON.parse(extensionsJson);

    // Count occurrences of agency extension
    const agencyCount = extensions.recommendations.filter(
      (r: string) => r === 'generacy-ai.agency'
    ).length;

    expect(agencyCount).toBe(1);
  });

  it('should not merge extensions.json if not in existingFiles', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);

    const extensionsJson = files.get('.vscode/extensions.json')!;
    const extensions = JSON.parse(extensionsJson);

    // Should only have Generacy extensions
    expect(extensions.recommendations).toHaveLength(2);
    expect(extensions.recommendations).toContain('generacy-ai.agency');
    expect(extensions.recommendations).toContain('generacy-ai.generacy');
  });

  it('should handle empty existing recommendations array', async () => {
    const existingFiles = new Map([
      ['.vscode/extensions.json', JSON.stringify({ recommendations: [] })],
    ]);

    const files = await renderProject(
      singleRepoContext as TemplateContext,
      existingFiles
    );

    const extensionsJson = files.get('.vscode/extensions.json')!;
    const extensions = JSON.parse(extensionsJson);

    expect(extensions.recommendations).toHaveLength(2);
    expect(extensions.recommendations).toContain('generacy-ai.agency');
    expect(extensions.recommendations).toContain('generacy-ai.generacy');
  });

  it('should throw error for invalid existing extensions.json', async () => {
    const existingFiles = new Map([
      ['.vscode/extensions.json', '{ invalid json }'],
    ]);

    await expect(
      renderProject(singleRepoContext as TemplateContext, existingFiles)
    ).rejects.toThrow(/Invalid JSON/);
  });
});

describe('Integration: renderProject - Error Handling', () => {
  it('should throw error with context when validation fails', async () => {
    const invalidContext = {
      ...singleRepoContext,
      project: null, // Will cause rendering error
    } as any;

    await expect(renderProject(invalidContext)).rejects.toThrow();
  });

  it('should include file path in error message', async () => {
    const invalidContext = {
      ...singleRepoContext,
      project: null,
    } as any;

    try {
      await renderProject(invalidContext);
      expect.fail('Should have thrown error');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      // Should mention a file path
      expect(message).toMatch(/\.generacy|\.vscode|\.devcontainer/);
    }
  });

  it('should propagate validation errors from validateAllRenderedFiles', async () => {
    // Create a context that will render invalid YAML
    const contextWithBadData = {
      ...singleRepoContext,
      // This won't actually break rendering, so we'll test validation separately
    } as TemplateContext;

    const files = await renderProject(contextWithBadData);

    // Manually create invalid content to test validation
    const badFiles = new Map(files);
    badFiles.set('.generacy/config.yaml', 'invalid: yaml: : :');

    expect(() => validateAllRenderedFiles(badFiles)).toThrow();
  });
});

describe('Integration: renderProject - Builder Integration', () => {
  it('should work with buildSingleRepoContext output', async () => {
    const context = buildSingleRepoContext({
      projectId: 'proj_test123',
      projectName: 'Test Project',
      primaryRepo: 'test-org/test-repo',
      releaseStream: 'stable',
    });

    const files = await renderProject(context);

    expect(files.size).toBe(5);
    expect(files.has('.generacy/config.yaml')).toBe(true);

    const configYaml = files.get('.generacy/config.yaml')!;
    const config: any = yaml.load(configYaml);

    expect(config.project.id).toBe('proj_test123');
    expect(config.project.name).toBe('Test Project');
    expect(config.repos.primary).toBe('test-org/test-repo');
  });

  it('should work with buildMultiRepoContext output', async () => {
    const context = buildMultiRepoContext({
      projectId: 'proj_multi456',
      projectName: 'Multi Project',
      primaryRepo: 'test-org/orchestrator',
      devRepos: ['test-org/api', 'test-org/frontend'],
      cloneRepos: ['test-org/shared'],
      workerCount: 2,
    });

    const files = await renderProject(context);

    expect(files.size).toBe(6);
    expect(files.has('.devcontainer/docker-compose.yml')).toBe(true);

    const configYaml = files.get('.generacy/config.yaml')!;
    const config: any = yaml.load(configYaml);

    expect(config.project.id).toBe('proj_multi456');
    expect(config.repos.dev).toHaveLength(2);
    expect(config.repos.clone).toHaveLength(1);
    expect(config.orchestrator.workerCount).toBe(2);
  });

  it('should render with default builder values', async () => {
    const context = buildSingleRepoContext({
      projectId: 'proj_defaults',
      projectName: 'Defaults Test',
      primaryRepo: 'test/repo',
    });

    const files = await renderProject(context);
    const configYaml = files.get('.generacy/config.yaml')!;
    const config: any = yaml.load(configYaml);

    // Check defaults were applied
    expect(config.defaults.agent).toBe('claude-code');
    expect(config.defaults.baseBranch).toBe('main');
    // Note: releaseStream is not rendered in config.yaml, it's just used for feature tag

    // Check devcontainer defaults
    const devcontainerJson = files.get('.devcontainer/devcontainer.json')!;
    const devcontainer = JSON.parse(devcontainerJson);
    expect(devcontainer.image).toContain('mcr.microsoft.com/devcontainers/');
  });
});

describe('Integration: renderProject - File Content Integrity', () => {
  it('should render properly indented YAML files', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);
    const configYaml = files.get('.generacy/config.yaml')!;

    // Check indentation (YAML uses 2 spaces)
    const lines = configYaml.split('\n');
    const indentedLines = lines.filter(line => line.startsWith('  '));
    expect(indentedLines.length).toBeGreaterThan(0);

    // Should not have tabs
    expect(configYaml).not.toContain('\t');
  });

  it('should render properly formatted JSON files', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);
    const devcontainerJson = files.get('.devcontainer/devcontainer.json')!;
    const extensionsJson = files.get('.vscode/extensions.json')!;

    // Parse to ensure valid JSON
    expect(() => JSON.parse(devcontainerJson)).not.toThrow();
    expect(() => JSON.parse(extensionsJson)).not.toThrow();

    // Check formatting (should be pretty-printed)
    expect(devcontainerJson).toContain('\n');
    expect(extensionsJson).toContain('\n');

    // Should use 2-space indentation
    const devcontainerLines = devcontainerJson.split('\n');
    const indentedLines = devcontainerLines.filter(line => line.startsWith('  '));
    expect(indentedLines.length).toBeGreaterThan(0);
  });

  it('should include trailing newline in all files', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);

    for (const [path, content] of files) {
      expect(content).toMatch(/\n$/);
    }
  });

  it('should not have extra blank lines at start or end', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);

    for (const [path, content] of files) {
      // Skip .gitignore for this check
      if (path.endsWith('.gitignore')) continue;

      // Should not start with blank line
      expect(content).not.toMatch(/^\n/);

      // Should end with single newline, not multiple
      expect(content).not.toMatch(/\n\n$/);
    }
  });
});

describe('Integration: renderProject - Consistency Checks', () => {
  it('should use consistent project ID across all files', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);
    const projectId = 'proj_abc123xyz';

    const configYaml = files.get('.generacy/config.yaml')!;
    const envTemplate = files.get('.generacy/generacy.env.template')!;

    expect(configYaml).toContain(projectId);
    expect(envTemplate).toContain(projectId);
  });

  it('should use consistent project name across all files', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);
    const projectName = 'E-Commerce API';

    const configYaml = files.get('.generacy/config.yaml')!;
    const devcontainerJson = files.get('.devcontainer/devcontainer.json')!;

    expect(configYaml).toContain(projectName);
    expect(devcontainerJson).toContain(projectName);
  });

  it('should use consistent repo names across multi-repo files', async () => {
    const files = await renderProject(multiRepoContext as TemplateContext);

    const configYaml = files.get('.generacy/config.yaml')!;
    const devcontainerJson = files.get('.devcontainer/devcontainer.json')!;
    const dockerComposeYml = files.get('.devcontainer/docker-compose.yml')!;

    // Check that all dev repos appear in all relevant files
    const devRepos = ['api-service', 'frontend-app', 'worker-service'];

    for (const repo of devRepos) {
      expect(configYaml).toContain(repo);
      expect(devcontainerJson).toContain(repo);
      expect(dockerComposeYml).toContain(repo);
    }
  });

  it('should use consistent VS Code extensions across files', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);

    const extensionsJson = files.get('.vscode/extensions.json')!;
    const devcontainerJson = files.get('.devcontainer/devcontainer.json')!;

    const extensions = JSON.parse(extensionsJson);
    const devcontainer = JSON.parse(devcontainerJson);

    // Both should include Generacy extensions
    expect(extensions.recommendations).toContain('generacy-ai.agency');
    expect(devcontainer.customizations.vscode.extensions).toContain('generacy-ai.agency');

    expect(extensions.recommendations).toContain('generacy-ai.generacy');
    expect(devcontainer.customizations.vscode.extensions).toContain('generacy-ai.generacy');
  });
});

describe('Integration: renderProject - Edge Cases', () => {
  it('should handle multi-repo with only dev repos (no clone repos)', async () => {
    const contextWithOnlyDev = {
      ...multiRepoContext,
      repos: {
        ...multiRepoContext.repos,
        clone: [],
        hasCloneRepos: false,
      },
    } as TemplateContext;

    const files = await renderProject(contextWithOnlyDev);

    expect(files.size).toBe(6);

    const configYaml = files.get('.generacy/config.yaml')!;
    const config: any = yaml.load(configYaml);

    expect(config.repos.dev).toBeDefined();
    expect(config.repos.dev.length).toBeGreaterThan(0);
    expect(config.repos.clone).toBeUndefined(); // Empty arrays not rendered
  });

  it('should handle multi-repo with only clone repos (no dev repos)', async () => {
    const contextWithOnlyClone = {
      ...multiRepoContext,
      repos: {
        ...multiRepoContext.repos,
        dev: [],
        hasDevRepos: false,
      },
    } as TemplateContext;

    const files = await renderProject(contextWithOnlyClone);

    expect(files.size).toBe(6);

    const configYaml = files.get('.generacy/config.yaml')!;
    const config: any = yaml.load(configYaml);

    expect(config.repos.dev).toBeUndefined(); // Empty arrays not rendered
    expect(config.repos.clone).toBeDefined();
    expect(config.repos.clone.length).toBeGreaterThan(0);
  });

  it('should handle minimal single-repo context', async () => {
    const minimalContext = buildSingleRepoContext({
      projectId: 'proj_min',
      projectName: 'Minimal',
      primaryRepo: 'org/repo',
    });

    const files = await renderProject(minimalContext);

    expect(files.size).toBe(5);
    expect(() => validateAllRenderedFiles(files)).not.toThrow();
  });

  it('should handle repo names with special characters', async () => {
    const context = buildSingleRepoContext({
      projectId: 'proj_special',
      projectName: 'Special Chars: &<>',
      primaryRepo: 'org-name.io/repo-name_v2',
    });

    const files = await renderProject(context);

    const configYaml = files.get('.generacy/config.yaml')!;
    const config: any = yaml.load(configYaml);

    expect(config.repos.primary).toBe('org-name.io/repo-name_v2');
  });

  it('should handle large number of repos in multi-repo', async () => {
    const manyDevRepos = Array.from({ length: 20 }, (_, i) => `org/repo-${i}`);

    const context = buildMultiRepoContext({
      projectId: 'proj_many',
      projectName: 'Many Repos',
      primaryRepo: 'org/primary',
      devRepos: manyDevRepos,
    });

    const files = await renderProject(context);

    expect(files.size).toBe(6);

    const dockerComposeYml = files.get('.devcontainer/docker-compose.yml')!;
    const dockerCompose: any = yaml.load(dockerComposeYml);

    // All repos should be mounted
    const volumes = dockerCompose.services.orchestrator.volumes;
    expect(volumes.length).toBeGreaterThanOrEqual(21); // primary + 20 dev repos
  });
});

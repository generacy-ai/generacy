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
 *
 * Note: All projects now use cluster templates (standard or microservices).
 * The old single-repo/multi-repo template distinction has been replaced by
 * cluster templates as the sole onboarding mechanism (see issue #289).
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

// Standard variant produces 11 files:
// 4 shared (config.yaml, generacy.env.template, .gitignore, extensions.json)
// 4 cluster variant (Dockerfile, docker-compose.yml, devcontainer.json, .env.template)
// 3 shared scripts (entrypoint-orchestrator.sh, entrypoint-worker.sh, setup-credentials.sh)
const STANDARD_FILE_COUNT = 11;

describe('Integration: renderProject - Single Repo', () => {
  it('should render all files for single-repo project', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);

    // All projects now get cluster templates
    expect(files.size).toBe(STANDARD_FILE_COUNT);

    // Verify shared files
    expect(files.has('.generacy/config.yaml')).toBe(true);
    expect(files.has('.generacy/generacy.env.template')).toBe(true);
    expect(files.has('.generacy/.gitignore')).toBe(true);
    expect(files.has('.vscode/extensions.json')).toBe(true);

    // Verify cluster template files
    expect(files.has('.devcontainer/devcontainer.json')).toBe(true);
    expect(files.has('.devcontainer/docker-compose.yml')).toBe(true);
    expect(files.has('.devcontainer/Dockerfile')).toBe(true);
    expect(files.has('.devcontainer/.env.template')).toBe(true);

    // Verify shared scripts
    expect(files.has('.devcontainer/scripts/entrypoint-orchestrator.sh')).toBe(true);
    expect(files.has('.devcontainer/scripts/entrypoint-worker.sh')).toBe(true);
    expect(files.has('.devcontainer/scripts/setup-credentials.sh')).toBe(true);
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
    expect(config.repos.primary).toBe('github.com/acme-corp/ecommerce-api');
    expect(config.repos.dev).toBeUndefined(); // Empty arrays not rendered
    expect(config.repos.clone).toBeUndefined();

    // Verify defaults
    expect(config.defaults.agent).toBe('claude-code');
    expect(config.defaults.baseBranch).toBe('main');

    // Should NOT have orchestrator section for single-repo
    expect(config.orchestrator).toBeUndefined();

    // Should have cluster section
    expect(config.cluster).toBeDefined();
    expect(config.cluster.variant).toBe('standard');
  });

  it('should render valid devcontainer.json for single-repo', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);
    const devcontainerJson = files.get('.devcontainer/devcontainer.json')!;

    // Parse JSON to ensure it's valid
    const devcontainer = JSON.parse(devcontainerJson);

    // Cluster templates always use docker-compose
    expect(devcontainer.name).toBe('E-Commerce API');
    expect(devcontainer.dockerComposeFile).toBe('docker-compose.yml');
    expect(devcontainer.service).toBe('orchestrator');
    expect(devcontainer.workspaceFolder).toBe('/workspaces/ecommerce-api');

    // Verify extensions in customizations
    expect(devcontainer.customizations?.vscode?.extensions).toContain('generacy-ai.agency');
    expect(devcontainer.customizations?.vscode?.extensions).toContain('generacy-ai.generacy');

    // Cluster templates don't use image or features directly (handled by Dockerfile)
    expect(devcontainer.image).toBeUndefined();
    expect(devcontainer.features).toBeUndefined();
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

  it('should render valid cluster .env.template for single-repo', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);
    const envTemplate = files.get('.devcontainer/.env.template')!;

    // Verify content
    expect(envTemplate).toContain('GITHUB_TOKEN=');
    expect(envTemplate).toContain('ANTHROPIC_API_KEY=');
    expect(envTemplate).toContain('REPO_URL=acme-corp/ecommerce-api');
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

    // Check rendered files for unrendered Handlebars variables
    for (const [path, content] of files) {
      // Skip static files (gitignore and shell scripts)
      if (path.endsWith('.gitignore') || path.endsWith('.sh')) continue;

      expect(content).not.toContain('{{undefined}}');
      expect(content).not.toMatch(/\{\{[^}]*undefined[^}]*\}\}/);
    }
  });
});

describe('Integration: renderProject - Multi Repo', () => {
  it('should render all files for multi-repo project', async () => {
    const files = await renderProject(multiRepoContext as TemplateContext);

    // All projects now get cluster templates (same file count)
    expect(files.size).toBe(STANDARD_FILE_COUNT);

    // Verify shared files
    expect(files.has('.generacy/config.yaml')).toBe(true);
    expect(files.has('.generacy/generacy.env.template')).toBe(true);
    expect(files.has('.generacy/.gitignore')).toBe(true);
    expect(files.has('.vscode/extensions.json')).toBe(true);

    // Verify cluster template files
    expect(files.has('.devcontainer/devcontainer.json')).toBe(true);
    expect(files.has('.devcontainer/docker-compose.yml')).toBe(true);
    expect(files.has('.devcontainer/Dockerfile')).toBe(true);
    expect(files.has('.devcontainer/.env.template')).toBe(true);
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
    expect(config.repos.primary).toBe('github.com/acme-corp/platform-orchestrator');
    expect(config.repos.dev).toBeDefined();
    expect(config.repos.dev).toHaveLength(3);
    expect(config.repos.dev).toContain('github.com/acme-corp/api-service');
    expect(config.repos.dev).toContain('github.com/acme-corp/frontend-app');
    expect(config.repos.dev).toContain('github.com/acme-corp/worker-service');
    expect(config.repos.clone).toBeDefined();
    expect(config.repos.clone).toHaveLength(2);
    expect(config.repos.clone).toContain('github.com/acme-corp/shared-lib');
    expect(config.repos.clone).toContain('github.com/acme-corp/proto-definitions');

    // Verify defaults
    expect(config.defaults.agent).toBe('claude-code');
    expect(config.defaults.baseBranch).toBe('develop');

    // Verify orchestrator
    expect(config.orchestrator.workerCount).toBe(2);
    expect(config.orchestrator.pollIntervalMs).toBe(5000);

    // Verify cluster
    expect(config.cluster).toBeDefined();
    expect(config.cluster.variant).toBe('standard');
  });

  it('should render valid devcontainer.json for multi-repo', async () => {
    const files = await renderProject(multiRepoContext as TemplateContext);
    const devcontainerJson = files.get('.devcontainer/devcontainer.json')!;

    // Parse JSON to ensure it's valid
    const devcontainer = JSON.parse(devcontainerJson);

    // Cluster templates always use docker-compose
    expect(devcontainer.name).toBe('Acme Platform');
    expect(devcontainer.dockerComposeFile).toBe('docker-compose.yml');
    expect(devcontainer.service).toBe('orchestrator');
    expect(devcontainer.workspaceFolder).toBe('/workspaces/platform-orchestrator');

    // Verify extensions
    expect(devcontainer.customizations?.vscode?.extensions).toContain('generacy-ai.agency');
    expect(devcontainer.customizations?.vscode?.extensions).toContain('generacy-ai.generacy');

    // Cluster templates don't use image directly
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

    // Verify no version field (obsolete in modern docker-compose)
    expect(dockerCompose.version).toBeUndefined();

    // Verify Redis has no exposed ports
    expect(dockerCompose.services.redis.ports).toBeUndefined();

    // Verify orchestrator service uses build (not direct image)
    const orchestrator = dockerCompose.services.orchestrator;
    expect(orchestrator.build).toBeDefined();
    expect(orchestrator.build.dockerfile).toBe('Dockerfile');
    expect(orchestrator.volumes).toBeDefined();
    expect(orchestrator.environment).toBeDefined();

    // Features belong in devcontainer.json, not docker-compose services
    expect(orchestrator.features).toBeUndefined();

    // Verify orchestrator health check
    expect(orchestrator.healthcheck).toBeDefined();

    // Verify worker service uses build
    const worker = dockerCompose.services.worker;
    expect(worker.build).toBeDefined();
    expect(worker.environment).toBeDefined();

    // Workers should not have features
    expect(worker.features).toBeUndefined();

    // Workers should have health check
    expect(worker.healthcheck).toBeDefined();

    // Worker replicas use runtime env var ${WORKER_COUNT:-3}
    expect(worker.deploy).toBeDefined();

    // Environment variables should include REDIS_URL
    const envArray = Array.isArray(worker.environment) ? worker.environment : Object.keys(worker.environment);
    const hasRedisUrl = envArray.some((e: any) =>
      typeof e === 'string' ? e.includes('REDIS_URL') : e === 'REDIS_URL'
    );
    expect(hasRedisUrl).toBe(true);

    // Verify project ID is substituted in docker-compose
    expect(dockerComposeYml).toContain('proj_xyz789def');
  });

  it('should pass validation for all multi-repo files', async () => {
    const files = await renderProject(multiRepoContext as TemplateContext);

    // Should not throw
    expect(() => validateAllRenderedFiles(files)).not.toThrow();
  });

  it('should not have undefined template variables in multi-repo files', async () => {
    const files = await renderProject(multiRepoContext as TemplateContext);

    // Check rendered files for unrendered Handlebars variables
    for (const [path, content] of files) {
      // Skip static files (gitignore and shell scripts)
      if (path.endsWith('.gitignore') || path.endsWith('.sh')) continue;

      expect(content).not.toContain('{{undefined}}');
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

    expect(files.size).toBe(STANDARD_FILE_COUNT);
    expect(files.has('.generacy/config.yaml')).toBe(true);

    const configYaml = files.get('.generacy/config.yaml')!;
    const config: any = yaml.load(configYaml);

    expect(config.project.id).toBe('proj_test123');
    expect(config.project.name).toBe('Test Project');
    expect(config.repos.primary).toBe('github.com/test-org/test-repo');
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

    expect(files.size).toBe(STANDARD_FILE_COUNT);
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

    // Cluster devcontainer uses docker-compose (not direct image)
    const devcontainerJson = files.get('.devcontainer/devcontainer.json')!;
    const devcontainer = JSON.parse(devcontainerJson);
    expect(devcontainer.dockerComposeFile).toBe('docker-compose.yml');
    expect(devcontainer.service).toBe('orchestrator');
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
      // Skip static files for this check
      if (path.endsWith('.gitignore') || path.endsWith('.sh')) continue;

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

  it('should use consistent repo names in config.yaml for multi-repo', async () => {
    const files = await renderProject(multiRepoContext as TemplateContext);

    const configYaml = files.get('.generacy/config.yaml')!;

    // Check that all dev repos appear in config.yaml
    const devRepos = ['api-service', 'frontend-app', 'worker-service'];
    for (const repo of devRepos) {
      expect(configYaml).toContain(repo);
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

    expect(files.size).toBe(STANDARD_FILE_COUNT);

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

    expect(files.size).toBe(STANDARD_FILE_COUNT);

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

    expect(files.size).toBe(STANDARD_FILE_COUNT);
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

    expect(config.repos.primary).toBe('github.com/org-name.io/repo-name_v2');
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

    expect(files.size).toBe(STANDARD_FILE_COUNT);

    // Config should list all repos
    const configYaml = files.get('.generacy/config.yaml')!;
    const config: any = yaml.load(configYaml);
    expect(config.repos.dev).toHaveLength(20);
  });
});

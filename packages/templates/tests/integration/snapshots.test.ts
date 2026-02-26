/**
 * Snapshot tests for template rendering
 *
 * These tests create snapshots of rendered templates to detect unintended
 * changes in template output. Snapshots are committed to version control
 * and serve as regression tests.
 *
 * When intentionally changing template output:
 * 1. Review the diff carefully
 * 2. Run `pnpm test -- -u` to update snapshots
 * 3. Commit the updated snapshots with your changes
 */

import { describe, it, expect } from 'vitest';
import { renderProject } from '../../src/index.js';
import type { TemplateContext } from '../../src/schema.js';

// Load test fixtures
import singleRepoContext from '../fixtures/single-repo-context.json';
import multiRepoContext from '../fixtures/multi-repo-context.json';

describe('Snapshot: Single-Repo Templates', () => {
  it('should match snapshot for config.yaml (single-repo)', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);
    const configYaml = files.get('.generacy/config.yaml')!;

    expect(configYaml).toBeDefined();
    expect(configYaml).toMatchSnapshot();
  });

  it('should match snapshot for devcontainer.json (single-repo)', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);
    const devcontainerJson = files.get('.devcontainer/devcontainer.json')!;

    expect(devcontainerJson).toBeDefined();
    expect(devcontainerJson).toMatchSnapshot();
  });

  it('should match snapshot for generacy.env.template (single-repo)', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);
    const envTemplate = files.get('.generacy/generacy.env.template')!;

    expect(envTemplate).toBeDefined();
    expect(envTemplate).toMatchSnapshot();
  });

  it('should match snapshot for extensions.json (single-repo)', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);
    const extensionsJson = files.get('.vscode/extensions.json')!;

    expect(extensionsJson).toBeDefined();
    expect(extensionsJson).toMatchSnapshot();
  });

  it('should match snapshot for .gitignore (single-repo)', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);
    const gitignore = files.get('.generacy/.gitignore')!;

    expect(gitignore).toBeDefined();
    expect(gitignore).toMatchSnapshot();
  });
});

describe('Snapshot: Multi-Repo Templates', () => {
  it('should match snapshot for config.yaml (multi-repo)', async () => {
    const files = await renderProject(multiRepoContext as TemplateContext);
    const configYaml = files.get('.generacy/config.yaml')!;

    expect(configYaml).toBeDefined();
    expect(configYaml).toMatchSnapshot();
  });

  it('should match snapshot for devcontainer.json (multi-repo)', async () => {
    const files = await renderProject(multiRepoContext as TemplateContext);
    const devcontainerJson = files.get('.devcontainer/devcontainer.json')!;

    expect(devcontainerJson).toBeDefined();
    expect(devcontainerJson).toMatchSnapshot();
  });

  it('should match snapshot for docker-compose.yml (multi-repo)', async () => {
    const files = await renderProject(multiRepoContext as TemplateContext);
    const dockerComposeYml = files.get('.devcontainer/docker-compose.yml')!;

    expect(dockerComposeYml).toBeDefined();
    expect(dockerComposeYml).toMatchSnapshot();
  });

  it('should match snapshot for generacy.env.template (multi-repo)', async () => {
    const files = await renderProject(multiRepoContext as TemplateContext);
    const envTemplate = files.get('.generacy/generacy.env.template')!;

    expect(envTemplate).toBeDefined();
    expect(envTemplate).toMatchSnapshot();
  });

  it('should match snapshot for extensions.json (multi-repo)', async () => {
    const files = await renderProject(multiRepoContext as TemplateContext);
    const extensionsJson = files.get('.vscode/extensions.json')!;

    expect(extensionsJson).toBeDefined();
    expect(extensionsJson).toMatchSnapshot();
  });

  it('should match snapshot for .gitignore (multi-repo)', async () => {
    const files = await renderProject(multiRepoContext as TemplateContext);
    const gitignore = files.get('.generacy/.gitignore')!;

    expect(gitignore).toBeDefined();
    expect(gitignore).toMatchSnapshot();
  });
});

describe('Snapshot: Complete File Sets', () => {
  it('should match snapshot for all single-repo file paths', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);
    const filePaths = Array.from(files.keys()).sort();

    expect(filePaths).toMatchSnapshot();
  });

  it('should match snapshot for all multi-repo file paths', async () => {
    const files = await renderProject(multiRepoContext as TemplateContext);
    const filePaths = Array.from(files.keys()).sort();

    expect(filePaths).toMatchSnapshot();
  });
});

describe('Snapshot: Edge Cases', () => {
  it('should match snapshot for config.yaml with no dev or clone repos', async () => {
    // Single repo context has no dev/clone repos
    const files = await renderProject(singleRepoContext as TemplateContext);
    const configYaml = files.get('.generacy/config.yaml')!;

    // Verify no dev/clone arrays are rendered
    expect(configYaml).not.toContain('dev:');
    expect(configYaml).not.toContain('clone:');
    expect(configYaml).toMatchSnapshot();
  });

  it('should match snapshot for config.yaml with orchestrator section', async () => {
    const files = await renderProject(multiRepoContext as TemplateContext);
    const configYaml = files.get('.generacy/config.yaml')!;

    // Verify orchestrator section exists
    expect(configYaml).toContain('orchestrator:');
    expect(configYaml).toContain('workerCount:');
    expect(configYaml).toContain('pollIntervalMs:');
    expect(configYaml).toMatchSnapshot();
  });

  it('should match snapshot for docker-compose.yml with multiple repos', async () => {
    const files = await renderProject(multiRepoContext as TemplateContext);
    const dockerComposeYml = files.get('.devcontainer/docker-compose.yml')!;

    // Verify all repos are referenced
    expect(dockerComposeYml).toContain('platform-orchestrator');
    expect(dockerComposeYml).toContain('api-service');
    expect(dockerComposeYml).toContain('frontend-app');
    expect(dockerComposeYml).toContain('worker-service');
    expect(dockerComposeYml).toContain('shared-lib');
    expect(dockerComposeYml).toContain('proto-definitions');
    expect(dockerComposeYml).toMatchSnapshot();
  });

  it('should match snapshot for multi-repo devcontainer.json with workspace folders', async () => {
    const files = await renderProject(multiRepoContext as TemplateContext);
    const devcontainerJson = files.get('.devcontainer/devcontainer.json')!;

    // Verify workspace folders are defined
    expect(devcontainerJson).toContain('workspaceFolders');
    expect(devcontainerJson).toContain('/workspaces/platform-orchestrator');
    expect(devcontainerJson).toContain('/workspaces/api-service');
    expect(devcontainerJson).toMatchSnapshot();
  });
});

describe('Snapshot: Format Consistency', () => {
  it('should maintain consistent YAML formatting in config.yaml', async () => {
    const singleFiles = await renderProject(singleRepoContext as TemplateContext);
    const multiFiles = await renderProject(multiRepoContext as TemplateContext);

    const singleConfig = singleFiles.get('.generacy/config.yaml')!;
    const multiConfig = multiFiles.get('.generacy/config.yaml')!;

    // Both should use consistent indentation
    expect(singleConfig).toMatchSnapshot();
    expect(multiConfig).toMatchSnapshot();
  });

  it('should maintain consistent JSON formatting across templates', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);
    const devcontainerJson = files.get('.devcontainer/devcontainer.json')!;
    const extensionsJson = files.get('.vscode/extensions.json')!;

    // Both JSON files should be properly formatted
    expect(devcontainerJson).toMatchSnapshot();
    expect(extensionsJson).toMatchSnapshot();
  });
});

describe('Snapshot: Special Values', () => {
  it('should correctly render project IDs in config and env template', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);
    const configYaml = files.get('.generacy/config.yaml')!;
    const envTemplate = files.get('.generacy/generacy.env.template')!;

    // Verify project ID appears in both files
    expect(configYaml).toContain('proj_abc123xyz');
    expect(envTemplate).toContain('proj_abc123xyz');

    // Snapshot to detect any changes
    expect(configYaml).toMatchSnapshot();
    expect(envTemplate).toMatchSnapshot();
  });

  it('should correctly render base images in devcontainer templates', async () => {
    const singleFiles = await renderProject(singleRepoContext as TemplateContext);
    const multiFiles = await renderProject(multiRepoContext as TemplateContext);

    const singleDevcontainer = singleFiles.get('.devcontainer/devcontainer.json')!;
    const multiDevcontainer = multiFiles.get('.devcontainer/devcontainer.json')!;

    // Single-repo uses image directly
    expect(singleDevcontainer).toContain('mcr.microsoft.com/devcontainers/typescript-node:20');

    // Multi-repo uses docker-compose (no image field in devcontainer.json)
    expect(multiDevcontainer).not.toContain('"image"');
    expect(multiDevcontainer).toContain('docker-compose.yml');

    expect(singleDevcontainer).toMatchSnapshot();
    expect(multiDevcontainer).toMatchSnapshot();
  });

  it('should correctly render Generacy feature references', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);
    const devcontainerJson = files.get('.devcontainer/devcontainer.json')!;

    // Verify feature reference is correct
    expect(devcontainerJson).toContain('ghcr.io/generacy-ai/generacy/generacy:1');

    expect(devcontainerJson).toMatchSnapshot();
  });

  it('should correctly render worker count in docker-compose.yml', async () => {
    const files = await renderProject(multiRepoContext as TemplateContext);
    const dockerComposeYml = files.get('.devcontainer/docker-compose.yml')!;

    // Verify worker replicas match context
    expect(dockerComposeYml).toContain('replicas: 2');

    expect(dockerComposeYml).toMatchSnapshot();
  });
});

describe('Snapshot: Comment Preservation', () => {
  it('should preserve header comments in config.yaml', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);
    const configYaml = files.get('.generacy/config.yaml')!;

    // Should contain header comments
    expect(configYaml).toContain('#');
    expect(configYaml).toMatchSnapshot();
  });

  it('should preserve explanatory comments in env template', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);
    const envTemplate = files.get('.generacy/generacy.env.template')!;

    // Should contain explanatory comments
    expect(envTemplate).toContain('#');
    expect(envTemplate).toMatchSnapshot();
  });

  it('should preserve comments in .gitignore', async () => {
    const files = await renderProject(singleRepoContext as TemplateContext);
    const gitignore = files.get('.generacy/.gitignore')!;

    // Should contain comments explaining what to ignore
    expect(gitignore).toContain('#');
    expect(gitignore).toMatchSnapshot();
  });
});

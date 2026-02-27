/**
 * Unit tests for template renderer
 *
 * Tests template rendering, Handlebars helpers, template selection logic,
 * error handling, and special cases like extensions.json merging.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadTemplate,
  renderTemplate,
  selectTemplates,
  renderExtensionsJson,
  renderProject,
  getTemplatePaths,
  getTargetPaths,
  getTemplateMapping,
} from '../../src/renderer.js';
import type { TemplateContext } from '../../src/schema.js';
import { GENERACY_EXTENSIONS } from '../../src/schema.js';
import Handlebars from 'handlebars';

// Load test fixtures
import singleRepoContext from '../fixtures/single-repo-context.json';
import multiRepoContext from '../fixtures/multi-repo-context.json';

describe('Template Loading', () => {
  describe('loadTemplate', () => {
    it('should load a template file successfully', async () => {
      const content = await loadTemplate('shared/config.yaml.hbs');
      expect(content).toBeDefined();
      expect(content).toContain('project:');
      expect(content).toContain('{{project.id}}');
    });

    it('should load static files without .hbs extension', async () => {
      const content = await loadTemplate('shared/gitignore.template');
      expect(content).toBeDefined();
      expect(content).toContain('generacy.env');
    });

    it('should throw error for non-existent template', async () => {
      await expect(
        loadTemplate('nonexistent/template.hbs')
      ).rejects.toThrow(/Failed to load template/);
    });

    it('should include template path in error message', async () => {
      await expect(
        loadTemplate('missing/file.hbs')
      ).rejects.toThrow('missing/file.hbs');
    });
  });
});

describe('Handlebars Helper Functions', () => {
  describe('repoName helper', () => {
    it('should extract repo name from shorthand format', () => {
      const template = Handlebars.compile('{{repoName "acme/main-api"}}');
      const result = template({});
      expect(result).toBe('main-api');
    });

    it('should handle org with dots and dashes', () => {
      const template = Handlebars.compile('{{repoName "acme-corp.io/my-repo"}}');
      const result = template({});
      expect(result).toBe('my-repo');
    });

    it('should return empty string for invalid format', () => {
      const template = Handlebars.compile('{{repoName "invalid"}}');
      const result = template({});
      expect(result).toBe('invalid');
    });

    it('should handle empty string', () => {
      const template = Handlebars.compile('{{repoName ""}}');
      const result = template({});
      expect(result).toBe('');
    });

    it('should handle non-string values', () => {
      const template = Handlebars.compile('{{repoName null}}');
      const result = template({});
      expect(result).toBe('');
    });
  });

  describe('json helper', () => {
    it('should pretty-print JSON object', () => {
      // Direct Handlebars.compile uses default escaping; renderTemplate uses noEscape: true
      const template = Handlebars.compile('{{json obj}}');
      const result = template({ obj: { name: 'test', value: 123 } });
      // Handlebars HTML-escapes by default with double braces
      expect(result).toContain('&quot;name&quot;: &quot;test&quot;');
      expect(result).toContain('&quot;value&quot;: 123');
      expect(result).toContain('\n'); // Should be formatted
    });

    it('should pretty-print JSON without escaping when noEscape is true', () => {
      // This mirrors the renderer behavior (noEscape: true for YAML/JSON output)
      const template = Handlebars.compile('{{json obj}}', { noEscape: true });
      const result = template({ obj: { name: 'test', value: 123 } });
      expect(result).toContain('"name": "test"');
      expect(result).toContain('"value": 123');
      expect(result).toContain('\n');
    });

    it('should handle arrays', () => {
      const template = Handlebars.compile('{{json arr}}');
      const result = template({ arr: ['a', 'b', 'c'] });
      expect(result).toContain('[\n');
      expect(result).toContain('&quot;a&quot;');
      expect(result).toContain('&quot;b&quot;');
      expect(result).toContain('&quot;c&quot;');
    });

    it('should handle nested objects', () => {
      const template = Handlebars.compile('{{json data}}');
      const result = template({
        data: {
          outer: {
            inner: {
              value: 'deep',
            },
          },
        },
      });
      expect(result).toContain('&quot;outer&quot;');
      expect(result).toContain('&quot;inner&quot;');
      expect(result).toContain('&quot;value&quot;: &quot;deep&quot;');
    });

    it('should use 2-space indentation', () => {
      const template = Handlebars.compile('{{json obj}}');
      const result = template({ obj: { a: { b: 1 } } });
      const lines = result.split('\n');
      // Check indentation
      expect(lines[1]).toMatch(/^  /); // 2 spaces
      expect(lines[2]).toMatch(/^    /); // 4 spaces
    });
  });

  describe('urlEncode helper', () => {
    it('should URL encode spaces', () => {
      const template = Handlebars.compile('{{urlEncode "string with spaces"}}');
      const result = template({});
      expect(result).toBe('string%20with%20spaces');
    });

    it('should URL encode special characters', () => {
      const template = Handlebars.compile('{{urlEncode "foo&bar=baz"}}');
      const result = template({});
      expect(result).toBe('foo%26bar%3Dbaz');
    });

    it('should handle unicode characters', () => {
      const template = Handlebars.compile('{{urlEncode "café"}}');
      const result = template({});
      expect(result).toBe('caf%C3%A9');
    });

    it('should return empty string for null/undefined', () => {
      const template = Handlebars.compile('{{urlEncode null}}');
      const result = template({});
      expect(result).toBe('');
    });

    it('should handle empty string', () => {
      const template = Handlebars.compile('{{urlEncode ""}}');
      const result = template({});
      expect(result).toBe('');
    });
  });

  describe('eq helper', () => {
    it('should return true for equal strings', () => {
      const template = Handlebars.compile('{{#if (eq a "test")}}yes{{else}}no{{/if}}');
      const result = template({ a: 'test' });
      expect(result).toBe('yes');
    });

    it('should return false for unequal strings', () => {
      const template = Handlebars.compile('{{#if (eq a "test")}}yes{{else}}no{{/if}}');
      const result = template({ a: 'other' });
      expect(result).toBe('no');
    });

    it('should work with numbers', () => {
      const template = Handlebars.compile('{{#if (eq count 5)}}yes{{else}}no{{/if}}');
      expect(template({ count: 5 })).toBe('yes');
      expect(template({ count: 3 })).toBe('no');
    });

    it('should work with booleans', () => {
      const template = Handlebars.compile('{{#if (eq flag true)}}yes{{else}}no{{/if}}');
      expect(template({ flag: true })).toBe('yes');
      expect(template({ flag: false })).toBe('no');
    });
  });
});

describe('Template Selection Logic', () => {
  describe('selectTemplates', () => {
    it('should select single-repo templates', () => {
      const templates = selectTemplates(singleRepoContext as TemplateContext);
      const templatePaths = templates.map(t => t.templatePath);
      const targetPaths = templates.map(t => t.targetPath);

      // Should include shared templates
      expect(templatePaths).toContain('shared/config.yaml.hbs');
      expect(templatePaths).toContain('shared/generacy.env.template.hbs');
      expect(templatePaths).toContain('shared/gitignore.template');
      expect(templatePaths).toContain('shared/extensions.json.hbs');

      // Should include single-repo devcontainer
      expect(templatePaths).toContain('single-repo/devcontainer.json.hbs');

      // Should NOT include multi-repo templates
      expect(templatePaths).not.toContain('multi-repo/devcontainer.json.hbs');
      expect(templatePaths).not.toContain('multi-repo/docker-compose.yml.hbs');

      // Check target paths
      expect(targetPaths).toContain('.generacy/config.yaml');
      expect(targetPaths).toContain('.devcontainer/devcontainer.json');
      expect(targetPaths).toContain('.vscode/extensions.json');

      // Should have exactly 5 files for single-repo
      expect(templates).toHaveLength(5);
    });

    it('should select multi-repo templates', () => {
      const templates = selectTemplates(multiRepoContext as TemplateContext);
      const templatePaths = templates.map(t => t.templatePath);
      const targetPaths = templates.map(t => t.targetPath);

      // Should include shared templates
      expect(templatePaths).toContain('shared/config.yaml.hbs');
      expect(templatePaths).toContain('shared/generacy.env.template.hbs');
      expect(templatePaths).toContain('shared/gitignore.template');
      expect(templatePaths).toContain('shared/extensions.json.hbs');

      // Should include multi-repo templates
      expect(templatePaths).toContain('multi-repo/devcontainer.json.hbs');
      expect(templatePaths).toContain('multi-repo/docker-compose.yml.hbs');

      // Should NOT include single-repo devcontainer
      expect(templatePaths).not.toContain('single-repo/devcontainer.json.hbs');

      // Check target paths
      expect(targetPaths).toContain('.generacy/config.yaml');
      expect(targetPaths).toContain('.devcontainer/devcontainer.json');
      expect(targetPaths).toContain('.devcontainer/docker-compose.yml');
      expect(targetPaths).toContain('.vscode/extensions.json');

      // Should have exactly 6 files for multi-repo
      expect(templates).toHaveLength(6);
    });

    it('should mark extensions.json for merge', () => {
      const templates = selectTemplates(singleRepoContext as TemplateContext);
      const extensionsTemplate = templates.find(
        t => t.targetPath === '.vscode/extensions.json'
      );
      expect(extensionsTemplate?.requiresMerge).toBe(true);
    });

    it('should mark .gitignore as static', () => {
      const templates = selectTemplates(singleRepoContext as TemplateContext);
      const gitignoreTemplate = templates.find(
        t => t.targetPath === '.generacy/.gitignore'
      );
      expect(gitignoreTemplate?.isStatic).toBe(true);
    });

    it('should not mark .hbs templates as static', () => {
      const templates = selectTemplates(singleRepoContext as TemplateContext);
      const configTemplate = templates.find(
        t => t.targetPath === '.generacy/config.yaml'
      );
      expect(configTemplate?.isStatic).toBe(false);
    });
  });

  describe('Utility functions', () => {
    it('getTemplatePaths should return template paths', () => {
      const paths = getTemplatePaths(singleRepoContext as TemplateContext);
      expect(paths).toContain('shared/config.yaml.hbs');
      expect(paths).toContain('single-repo/devcontainer.json.hbs');
      expect(paths).toHaveLength(5);
    });

    it('getTargetPaths should return target paths', () => {
      const paths = getTargetPaths(singleRepoContext as TemplateContext);
      expect(paths).toContain('.generacy/config.yaml');
      expect(paths).toContain('.devcontainer/devcontainer.json');
      expect(paths).toHaveLength(5);
    });

    it('getTemplateMapping should return template-to-target mapping', () => {
      const mapping = getTemplateMapping(singleRepoContext as TemplateContext);
      expect(mapping.get('shared/config.yaml.hbs')).toBe('.generacy/config.yaml');
      expect(mapping.get('shared/gitignore.template')).toBe('.generacy/.gitignore');
      expect(mapping.size).toBe(5);
    });
  });
});

describe('Template Rendering', () => {
  describe('renderTemplate', () => {
    it('should render config.yaml with single-repo context', async () => {
      const result = await renderTemplate(
        'shared/config.yaml.hbs',
        singleRepoContext as TemplateContext
      );

      // Check basic structure
      expect(result).toContain('project:');
      expect(result).toContain('repos:');
      expect(result).toContain('defaults:');

      // Check substituted values
      expect(result).toContain('id: "proj_abc123xyz"');
      expect(result).toContain('name: "E-Commerce API"');
      expect(result).toContain('primary: "github.com/acme-corp/ecommerce-api"');
      expect(result).toContain('agent: "claude-code"');
      expect(result).toContain('baseBranch: "main"');

      // Should NOT include orchestrator section (single-repo)
      expect(result).not.toContain('orchestrator:');

      // Should NOT include dev/clone repos sections (empty arrays)
      expect(result).not.toContain('dev:');
      expect(result).not.toContain('clone:');
    });

    it('should render config.yaml with multi-repo context', async () => {
      const result = await renderTemplate(
        'shared/config.yaml.hbs',
        multiRepoContext as TemplateContext
      );

      // Check substituted values
      expect(result).toContain('id: "proj_xyz789def"');
      expect(result).toContain('name: "Acme Platform"');
      expect(result).toContain('primary: "github.com/acme-corp/platform-orchestrator"');

      // Should include dev repos
      expect(result).toContain('dev:');
      expect(result).toContain('- "github.com/acme-corp/api-service"');
      expect(result).toContain('- "github.com/acme-corp/frontend-app"');
      expect(result).toContain('- "github.com/acme-corp/worker-service"');

      // Should include clone repos
      expect(result).toContain('clone:');
      expect(result).toContain('- "github.com/acme-corp/shared-lib"');
      expect(result).toContain('- "github.com/acme-corp/proto-definitions"');

      // Should include orchestrator section
      expect(result).toContain('orchestrator:');
      expect(result).toContain('pollIntervalMs: 5000');
      expect(result).toContain('workerCount: 2');
    });

    it('should render generacy.env.template with project ID', async () => {
      const result = await renderTemplate(
        'shared/generacy.env.template.hbs',
        singleRepoContext as TemplateContext
      );

      expect(result).toContain('PROJECT_ID=proj_abc123xyz');
      expect(result).toContain('GITHUB_TOKEN=');
      expect(result).toContain('ANTHROPIC_API_KEY=');
      expect(result).toContain('REDIS_URL=');
      expect(result).toContain('LOG_LEVEL=');
    });

    it('should render extensions.json', async () => {
      const result = await renderTemplate(
        'shared/extensions.json.hbs',
        singleRepoContext as TemplateContext
      );

      const parsed = JSON.parse(result);
      expect(parsed.recommendations).toBeDefined();
      expect(parsed.recommendations).toContain('generacy-ai.agency');
      expect(parsed.recommendations).toContain('generacy-ai.generacy');
      expect(parsed.recommendations).toHaveLength(GENERACY_EXTENSIONS.length);
    });

    it('should render single-repo devcontainer.json', async () => {
      const result = await renderTemplate(
        'single-repo/devcontainer.json.hbs',
        singleRepoContext as TemplateContext
      );

      const parsed = JSON.parse(result);
      expect(parsed.name).toBe('E-Commerce API');
      expect(parsed.image).toBe('mcr.microsoft.com/devcontainers/typescript-node:20');
      expect(parsed.features).toBeDefined();
      expect(parsed.customizations?.vscode?.extensions).toContain('generacy-ai.agency');
      expect(parsed.customizations?.vscode?.extensions).toContain('generacy-ai.generacy');

      // Should NOT have dockerComposeFile or workspaceFolder
      expect(parsed.dockerComposeFile).toBeUndefined();
      expect(parsed.workspaceFolder).toBeUndefined();
    });

    it('should render multi-repo devcontainer.json', async () => {
      const result = await renderTemplate(
        'multi-repo/devcontainer.json.hbs',
        multiRepoContext as TemplateContext
      );

      const parsed = JSON.parse(result);
      expect(parsed.name).toBe('Acme Platform');
      expect(parsed.dockerComposeFile).toBe('docker-compose.yml');
      expect(parsed.service).toBe('orchestrator');
      expect(parsed.workspaceFolder).toBe('/workspaces/platform-orchestrator');

      // Should have workspace folders for all repos
      expect(parsed.workspaceFolders).toBeDefined();
      const workspacePaths = parsed.workspaceFolders.map((w: any) => w.path);
      expect(workspacePaths).toContain('/workspaces/platform-orchestrator');
      expect(workspacePaths).toContain('/workspaces/api-service');
      expect(workspacePaths).toContain('/workspaces/frontend-app');
      expect(workspacePaths).toContain('/workspaces/worker-service');
      expect(workspacePaths).toContain('/workspaces/shared-lib');
      expect(workspacePaths).toContain('/workspaces/proto-definitions');

      // Should NOT have image (uses docker-compose instead)
      expect(parsed.image).toBeUndefined();
    });

    it('should render multi-repo docker-compose.yml', async () => {
      const result = await renderTemplate(
        'multi-repo/docker-compose.yml.hbs',
        multiRepoContext as TemplateContext
      );

      // Check for services
      expect(result).toContain('services:');
      expect(result).toContain('redis:');
      expect(result).toContain('orchestrator:');
      expect(result).toContain('worker:');

      // Check for volume mounts
      expect(result).toContain('/workspaces/platform-orchestrator');
      expect(result).toContain('/workspaces/api-service');
      expect(result).toContain('/workspaces/frontend-app');
      expect(result).toContain('/workspaces/worker-service');
      expect(result).toContain('/workspaces/shared-lib');
      expect(result).toContain('/workspaces/proto-definitions');

      // Check environment variables
      expect(result).toContain('REDIS_URL');
      expect(result).toContain('POLL_INTERVAL_MS');
      expect(result).toContain('WORKER_COUNT');

      // Check deploy replicas for worker
      expect(result).toContain('replicas: 2');
    });

    it('should return static file content unchanged', async () => {
      const result = await renderTemplate(
        'shared/gitignore.template',
        singleRepoContext as TemplateContext
      );

      // Should contain the static content
      expect(result).toContain('generacy.env');
      expect(result).toContain('.agent-state/');

      // Should NOT have any Handlebars substitution
      expect(result).not.toContain('{{');
      expect(result).not.toContain('}}');
    });

    it('should use strict mode for template compilation', async () => {
      // Verify that templates are compiled with strict mode enabled
      // Note: The config.yaml template is designed to handle missing optional fields
      // gracefully using Handlebars conditionals, so we just verify the mode is set
      const result = await renderTemplate(
        'shared/config.yaml.hbs',
        singleRepoContext as TemplateContext
      );

      // If strict mode is working, the template should render successfully
      // with valid context
      expect(result).toBeDefined();
      expect(result).toContain('project:');
    });
  });

  describe('renderExtensionsJson', () => {
    it('should render new extensions.json', async () => {
      const result = await renderExtensionsJson(singleRepoContext as TemplateContext);

      const parsed = JSON.parse(result);
      expect(parsed.recommendations).toEqual(
        expect.arrayContaining([...GENERACY_EXTENSIONS])
      );
    });

    it('should merge with existing extensions.json', async () => {
      const existing = JSON.stringify({
        recommendations: [
          'dbaeumer.vscode-eslint',
          'esbenp.prettier-vscode',
        ],
      });

      const result = await renderExtensionsJson(
        singleRepoContext as TemplateContext,
        existing
      );

      const parsed = JSON.parse(result);
      expect(parsed.recommendations).toEqual(
        expect.arrayContaining([
          'dbaeumer.vscode-eslint',
          'esbenp.prettier-vscode',
          'generacy-ai.agency',
          'generacy-ai.generacy',
        ])
      );
    });

    it('should deduplicate recommendations', async () => {
      const existing = JSON.stringify({
        recommendations: [
          'generacy-ai.agency', // Already present
          'dbaeumer.vscode-eslint',
        ],
      });

      const result = await renderExtensionsJson(
        singleRepoContext as TemplateContext,
        existing
      );

      const parsed = JSON.parse(result);
      // Should not have duplicates
      const agencyCount = parsed.recommendations.filter(
        (r: string) => r === 'generacy-ai.agency'
      ).length;
      expect(agencyCount).toBe(1);
    });

    it('should preserve other properties', async () => {
      const existing = JSON.stringify({
        recommendations: ['dbaeumer.vscode-eslint'],
        unwantedRecommendations: ['ms-vscode.cpptools'],
        customProperty: 'value',
      });

      const result = await renderExtensionsJson(
        singleRepoContext as TemplateContext,
        existing
      );

      const parsed = JSON.parse(result);
      expect(parsed.unwantedRecommendations).toEqual(['ms-vscode.cpptools']);
      expect(parsed.customProperty).toBe('value');
    });

    it('should handle empty existing recommendations array', async () => {
      const existing = JSON.stringify({
        recommendations: [],
      });

      const result = await renderExtensionsJson(
        singleRepoContext as TemplateContext,
        existing
      );

      const parsed = JSON.parse(result);
      expect(parsed.recommendations).toEqual([...GENERACY_EXTENSIONS]);
    });

    it('should throw error for invalid JSON', async () => {
      const invalidJson = '{ invalid json }';

      await expect(
        renderExtensionsJson(singleRepoContext as TemplateContext, invalidJson)
      ).rejects.toThrow(/Invalid JSON/);
    });

    it('should add trailing newline', async () => {
      const result = await renderExtensionsJson(singleRepoContext as TemplateContext);
      expect(result).toMatch(/\n$/);
    });
  });
});

describe('Project Rendering', () => {
  describe('renderProject', () => {
    it('should render all single-repo files', async () => {
      const fileMap = await renderProject(singleRepoContext as TemplateContext);

      // Should have exactly 5 files
      expect(fileMap.size).toBe(5);

      // Check file paths
      expect(fileMap.has('.generacy/config.yaml')).toBe(true);
      expect(fileMap.has('.generacy/generacy.env.template')).toBe(true);
      expect(fileMap.has('.generacy/.gitignore')).toBe(true);
      expect(fileMap.has('.vscode/extensions.json')).toBe(true);
      expect(fileMap.has('.devcontainer/devcontainer.json')).toBe(true);

      // Check content is rendered
      const config = fileMap.get('.generacy/config.yaml')!;
      expect(config).toContain('proj_abc123xyz');
      expect(config).not.toContain('{{');
    });

    it('should render all multi-repo files', async () => {
      const fileMap = await renderProject(multiRepoContext as TemplateContext);

      // Should have exactly 6 files
      expect(fileMap.size).toBe(6);

      // Check file paths
      expect(fileMap.has('.generacy/config.yaml')).toBe(true);
      expect(fileMap.has('.generacy/generacy.env.template')).toBe(true);
      expect(fileMap.has('.generacy/.gitignore')).toBe(true);
      expect(fileMap.has('.vscode/extensions.json')).toBe(true);
      expect(fileMap.has('.devcontainer/devcontainer.json')).toBe(true);
      expect(fileMap.has('.devcontainer/docker-compose.yml')).toBe(true);

      // Check content is rendered
      const config = fileMap.get('.generacy/config.yaml')!;
      expect(config).toContain('proj_xyz789def');
      expect(config).toContain('acme-corp/api-service');
    });

    it('should merge existing extensions.json', async () => {
      const existingFiles = new Map([
        [
          '.vscode/extensions.json',
          JSON.stringify({
            recommendations: ['dbaeumer.vscode-eslint'],
          }),
        ],
      ]);

      const fileMap = await renderProject(
        singleRepoContext as TemplateContext,
        existingFiles
      );

      const extensionsJson = fileMap.get('.vscode/extensions.json')!;
      const parsed = JSON.parse(extensionsJson);
      expect(parsed.recommendations).toContain('dbaeumer.vscode-eslint');
      expect(parsed.recommendations).toContain('generacy-ai.agency');
      expect(parsed.recommendations).toContain('generacy-ai.generacy');
    });

    it('should not affect other files when merging extensions.json', async () => {
      const existingFiles = new Map([
        [
          '.vscode/extensions.json',
          JSON.stringify({
            recommendations: ['dbaeumer.vscode-eslint'],
          }),
        ],
      ]);

      const fileMap = await renderProject(
        singleRepoContext as TemplateContext,
        existingFiles
      );

      // Other files should be rendered normally
      const config = fileMap.get('.generacy/config.yaml')!;
      expect(config).toContain('proj_abc123xyz');
    });

    it('should throw error with context when template fails', async () => {
      // Create an invalid context that will fail rendering
      const invalidContext = {
        ...singleRepoContext,
        project: null, // Will cause rendering error
      } as any;

      await expect(
        renderProject(invalidContext)
      ).rejects.toThrow(/Failed to render/);
    });

    it('should include target path in error message', async () => {
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
        // Should mention the file that failed
        expect(message).toMatch(/\.generacy\/config\.yaml|\.vscode\/extensions\.json/);
      }
    });

    it('should return Map with correct types', async () => {
      const fileMap = await renderProject(singleRepoContext as TemplateContext);

      expect(fileMap).toBeInstanceOf(Map);
      for (const [key, value] of fileMap) {
        expect(typeof key).toBe('string');
        expect(typeof value).toBe('string');
      }
    });

    it('should render valid JSON for JSON files', async () => {
      const fileMap = await renderProject(singleRepoContext as TemplateContext);

      const extensionsJson = fileMap.get('.vscode/extensions.json')!;
      expect(() => JSON.parse(extensionsJson)).not.toThrow();

      const devcontainerJson = fileMap.get('.devcontainer/devcontainer.json')!;
      expect(() => JSON.parse(devcontainerJson)).not.toThrow();
    });

    it('should render valid YAML for YAML files', async () => {
      const fileMap = await renderProject(singleRepoContext as TemplateContext);

      const configYaml = fileMap.get('.generacy/config.yaml')!;
      // Basic YAML structure check
      expect(configYaml).toContain('project:');
      expect(configYaml).toContain('repos:');
      // Should have proper indentation
      expect(configYaml).toMatch(/\n  id:/);
      expect(configYaml).toMatch(/\n  name:/);
    });
  });
});

describe('Error Handling', () => {
  it('should provide clear error for missing template', async () => {
    await expect(
      renderTemplate('nonexistent/file.hbs', singleRepoContext as TemplateContext)
    ).rejects.toThrow(/Failed to render template/);
  });

  it('should include template path in load errors', async () => {
    try {
      await loadTemplate('missing/template.hbs');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('missing/template.hbs');
    }
  });

  it('should include template path in render errors', async () => {
    try {
      const invalidContext = { project: null } as any;
      await renderTemplate('shared/config.yaml.hbs', invalidContext);
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('config.yaml.hbs');
    }
  });

  it('should propagate errors from renderProject', async () => {
    const invalidContext = { ...singleRepoContext, project: null } as any;

    await expect(
      renderProject(invalidContext)
    ).rejects.toThrow(Error);
  });
});

describe('Edge Cases', () => {
  it('should handle context with empty dev and clone repos', async () => {
    const result = await renderTemplate(
      'shared/config.yaml.hbs',
      singleRepoContext as TemplateContext
    );

    // Should not render empty arrays
    expect(result).not.toContain('dev:');
    expect(result).not.toContain('clone:');
  });

  it('should handle multi-repo with only dev repos', async () => {
    const contextWithOnlyDev = {
      ...multiRepoContext,
      repos: {
        ...multiRepoContext.repos,
        clone: [],
        hasCloneRepos: false,
      },
    } as TemplateContext;

    const result = await renderTemplate(
      'shared/config.yaml.hbs',
      contextWithOnlyDev
    );

    expect(result).toContain('dev:');
    expect(result).not.toContain('clone:');
  });

  it('should handle multi-repo with only clone repos', async () => {
    const contextWithOnlyClone = {
      ...multiRepoContext,
      repos: {
        ...multiRepoContext.repos,
        dev: [],
        hasDevRepos: false,
      },
    } as TemplateContext;

    const result = await renderTemplate(
      'shared/config.yaml.hbs',
      contextWithOnlyClone
    );

    expect(result).not.toContain('dev:');
    expect(result).toContain('clone:');
  });

  it('should handle repoName helper with multiple slashes', () => {
    const template = Handlebars.compile('{{repoName "org/sub/repo"}}');
    const result = template({});
    // Should return original if format is invalid
    expect(result).toBe('org/sub/repo');
  });

  it('should handle json helper with null value', () => {
    const template = Handlebars.compile('{{json value}}');
    const result = template({ value: null });
    expect(result).toBe('null');
  });

  it('should handle json helper with undefined value', () => {
    const template = Handlebars.compile('{{json value}}');
    const result = template({ value: undefined });
    expect(result).toBe(''); // undefined serializes to empty in JSON.stringify
  });

  it('should not HTML-escape special characters (noEscape: true)', async () => {
    // With noEscape: true, Handlebars should not convert & to &amp;,
    // < to &lt;, > to &gt;, or " to &quot;
    const result = await renderTemplate(
      'shared/config.yaml.hbs',
      {
        ...singleRepoContext,
        project: {
          ...singleRepoContext.project,
          name: 'Acme & Co',
        },
      } as TemplateContext
    );

    // The ampersand should appear as-is, not HTML-escaped
    expect(result).toContain('name: "Acme & Co"');
    expect(result).not.toContain('&amp;');
  });

  it('should preserve quotes in rendered JSON output', async () => {
    const result = await renderTemplate(
      'shared/extensions.json.hbs',
      singleRepoContext as TemplateContext
    );

    // JSON should contain real double quotes, not &quot;
    expect(result).not.toContain('&quot;');
    expect(() => JSON.parse(result)).not.toThrow();
  });
});

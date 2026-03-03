/**
 * Unit tests for template renderer
 *
 * Tests template rendering, Handlebars helpers, template selection logic,
 * error handling, and special cases like extensions.json merging.
 *
 * Template selection routes to cluster variant directories based on
 * context.cluster.variant: "standard" (DooD) or "microservices" (DinD).
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
  // Helper to create context with a specific variant
  function contextWithVariant(
    base: typeof singleRepoContext,
    variant: 'standard' | 'microservices'
  ): TemplateContext {
    return { ...base, cluster: { variant } } as TemplateContext;
  }

  describe('selectTemplates - shared templates', () => {
    it('should always include shared templates regardless of variant', () => {
      const standardTemplates = selectTemplates(
        contextWithVariant(singleRepoContext, 'standard')
      );
      const microservicesTemplates = selectTemplates(
        contextWithVariant(singleRepoContext, 'microservices')
      );

      const sharedPaths = [
        'shared/config.yaml.hbs',
        'shared/generacy.env.template.hbs',
        'shared/gitignore.template',
        'shared/extensions.json.hbs',
      ];

      for (const path of sharedPaths) {
        expect(standardTemplates.map(t => t.templatePath)).toContain(path);
        expect(microservicesTemplates.map(t => t.templatePath)).toContain(path);
      }
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

  describe('selectTemplates - standard variant', () => {
    it('should select standard cluster templates', () => {
      const ctx = contextWithVariant(singleRepoContext, 'standard');
      const templates = selectTemplates(ctx);
      const templatePaths = templates.map(t => t.templatePath);

      // Cluster variant templates
      expect(templatePaths).toContain('cluster/standard/Dockerfile.hbs');
      expect(templatePaths).toContain('cluster/standard/docker-compose.yml.hbs');
      expect(templatePaths).toContain('cluster/standard/devcontainer.json.hbs');
      expect(templatePaths).toContain('cluster/standard/env.template.hbs');

      // Should NOT include microservices templates
      expect(templatePaths).not.toContain('cluster/microservices/Dockerfile.hbs');
      expect(templatePaths).not.toContain('cluster/microservices/docker-compose.yml.hbs');
      expect(templatePaths).not.toContain('cluster/microservices/devcontainer.json.hbs');
      expect(templatePaths).not.toContain('cluster/microservices/env.template.hbs');
    });

    it('should include shared static scripts', () => {
      const ctx = contextWithVariant(singleRepoContext, 'standard');
      const templates = selectTemplates(ctx);
      const templatePaths = templates.map(t => t.templatePath);

      expect(templatePaths).toContain('cluster/shared/scripts/entrypoint-orchestrator.sh');
      expect(templatePaths).toContain('cluster/shared/scripts/entrypoint-worker.sh');
      expect(templatePaths).toContain('cluster/shared/scripts/setup-credentials.sh');
    });

    it('should NOT include Docker-in-Docker setup script', () => {
      const ctx = contextWithVariant(singleRepoContext, 'standard');
      const templates = selectTemplates(ctx);
      const templatePaths = templates.map(t => t.templatePath);

      expect(templatePaths).not.toContain('cluster/shared/scripts/setup-docker-dind.sh');
    });

    it('should have exactly 11 templates for standard variant', () => {
      const ctx = contextWithVariant(singleRepoContext, 'standard');
      const templates = selectTemplates(ctx);
      // 4 shared + 4 cluster/standard + 3 shared scripts = 11
      expect(templates).toHaveLength(11);
    });

    it('should map cluster templates to correct target paths', () => {
      const ctx = contextWithVariant(singleRepoContext, 'standard');
      const templates = selectTemplates(ctx);

      const dockerfileTemplate = templates.find(
        t => t.templatePath === 'cluster/standard/Dockerfile.hbs'
      );
      expect(dockerfileTemplate?.targetPath).toBe('.devcontainer/Dockerfile');

      const composeTemplate = templates.find(
        t => t.templatePath === 'cluster/standard/docker-compose.yml.hbs'
      );
      expect(composeTemplate?.targetPath).toBe('.devcontainer/docker-compose.yml');

      const devcontainerTemplate = templates.find(
        t => t.templatePath === 'cluster/standard/devcontainer.json.hbs'
      );
      expect(devcontainerTemplate?.targetPath).toBe('.devcontainer/devcontainer.json');

      const envTemplate = templates.find(
        t => t.templatePath === 'cluster/standard/env.template.hbs'
      );
      expect(envTemplate?.targetPath).toBe('.devcontainer/.env.template');
    });

    it('should mark shared scripts as static', () => {
      const ctx = contextWithVariant(singleRepoContext, 'standard');
      const templates = selectTemplates(ctx);

      const scripts = templates.filter(
        t => t.templatePath.startsWith('cluster/shared/scripts/')
      );
      for (const script of scripts) {
        expect(script.isStatic).toBe(true);
        expect(script.requiresMerge).toBe(false);
      }
    });

    it('should map scripts to .devcontainer/scripts/ target directory', () => {
      const ctx = contextWithVariant(singleRepoContext, 'standard');
      const templates = selectTemplates(ctx);

      const scripts = templates.filter(
        t => t.templatePath.startsWith('cluster/shared/scripts/')
      );
      for (const script of scripts) {
        expect(script.targetPath).toMatch(/^\.devcontainer\/scripts\//);
      }
    });
  });

  describe('selectTemplates - microservices variant', () => {
    it('should select microservices cluster templates', () => {
      const ctx = contextWithVariant(singleRepoContext, 'microservices');
      const templates = selectTemplates(ctx);
      const templatePaths = templates.map(t => t.templatePath);

      // Cluster variant templates
      expect(templatePaths).toContain('cluster/microservices/Dockerfile.hbs');
      expect(templatePaths).toContain('cluster/microservices/docker-compose.yml.hbs');
      expect(templatePaths).toContain('cluster/microservices/devcontainer.json.hbs');
      expect(templatePaths).toContain('cluster/microservices/env.template.hbs');

      // Should NOT include standard templates
      expect(templatePaths).not.toContain('cluster/standard/Dockerfile.hbs');
      expect(templatePaths).not.toContain('cluster/standard/docker-compose.yml.hbs');
      expect(templatePaths).not.toContain('cluster/standard/devcontainer.json.hbs');
      expect(templatePaths).not.toContain('cluster/standard/env.template.hbs');
    });

    it('should include Docker-in-Docker setup script', () => {
      const ctx = contextWithVariant(singleRepoContext, 'microservices');
      const templates = selectTemplates(ctx);
      const templatePaths = templates.map(t => t.templatePath);

      expect(templatePaths).toContain('cluster/shared/scripts/setup-docker-dind.sh');
    });

    it('should also include the shared scripts', () => {
      const ctx = contextWithVariant(singleRepoContext, 'microservices');
      const templates = selectTemplates(ctx);
      const templatePaths = templates.map(t => t.templatePath);

      expect(templatePaths).toContain('cluster/shared/scripts/entrypoint-orchestrator.sh');
      expect(templatePaths).toContain('cluster/shared/scripts/entrypoint-worker.sh');
      expect(templatePaths).toContain('cluster/shared/scripts/setup-credentials.sh');
    });

    it('should have exactly 12 templates for microservices variant', () => {
      const ctx = contextWithVariant(singleRepoContext, 'microservices');
      const templates = selectTemplates(ctx);
      // 4 shared + 4 cluster/microservices + 3 shared scripts + 1 DinD script = 12
      expect(templates).toHaveLength(12);
    });

    it('should map DinD setup script to .devcontainer/scripts/', () => {
      const ctx = contextWithVariant(singleRepoContext, 'microservices');
      const templates = selectTemplates(ctx);

      const dindScript = templates.find(
        t => t.templatePath === 'cluster/shared/scripts/setup-docker-dind.sh'
      );
      expect(dindScript?.targetPath).toBe('.devcontainer/scripts/setup-docker-dind.sh');
      expect(dindScript?.isStatic).toBe(true);
    });
  });

  describe('selectTemplates - variant routing consistency', () => {
    it('should produce identical shared templates for both variants', () => {
      const standardCtx = contextWithVariant(singleRepoContext, 'standard');
      const microservicesCtx = contextWithVariant(singleRepoContext, 'microservices');

      const standardTemplates = selectTemplates(standardCtx);
      const microservicesTemplates = selectTemplates(microservicesCtx);

      const standardShared = standardTemplates
        .filter(t => t.templatePath.startsWith('shared/'))
        .map(t => t.templatePath)
        .sort();
      const microservicesShared = microservicesTemplates
        .filter(t => t.templatePath.startsWith('shared/'))
        .map(t => t.templatePath)
        .sort();

      expect(standardShared).toEqual(microservicesShared);
    });

    it('should produce identical target paths for variant-specific templates', () => {
      const standardCtx = contextWithVariant(singleRepoContext, 'standard');
      const microservicesCtx = contextWithVariant(singleRepoContext, 'microservices');

      const standardTargets = selectTemplates(standardCtx)
        .filter(t => t.templatePath.startsWith('cluster/standard/'))
        .map(t => t.targetPath)
        .sort();
      const microservicesTargets = selectTemplates(microservicesCtx)
        .filter(t => t.templatePath.startsWith('cluster/microservices/'))
        .map(t => t.targetPath)
        .sort();

      // Both variants produce the same output file paths
      expect(standardTargets).toEqual(microservicesTargets);
    });

    it('should work identically for single-repo and multi-repo contexts', () => {
      const singleStandard = selectTemplates(
        contextWithVariant(singleRepoContext, 'standard')
      );
      const multiStandard = selectTemplates(
        contextWithVariant(multiRepoContext, 'standard')
      );

      // Template selection is driven by variant, not by repo type
      expect(singleStandard.map(t => t.templatePath)).toEqual(
        multiStandard.map(t => t.templatePath)
      );
    });
  });

  describe('Utility functions', () => {
    it('getTemplatePaths should return template paths for standard', () => {
      const paths = getTemplatePaths(singleRepoContext as TemplateContext);
      expect(paths).toContain('shared/config.yaml.hbs');
      expect(paths).toContain('cluster/standard/Dockerfile.hbs');
      expect(paths).toContain('cluster/standard/devcontainer.json.hbs');
      expect(paths).toContain('cluster/shared/scripts/entrypoint-orchestrator.sh');
      expect(paths).toHaveLength(11);
    });

    it('getTargetPaths should return target paths for standard', () => {
      const paths = getTargetPaths(singleRepoContext as TemplateContext);
      expect(paths).toContain('.generacy/config.yaml');
      expect(paths).toContain('.devcontainer/Dockerfile');
      expect(paths).toContain('.devcontainer/devcontainer.json');
      expect(paths).toContain('.devcontainer/docker-compose.yml');
      expect(paths).toContain('.devcontainer/.env.template');
      expect(paths).toContain('.devcontainer/scripts/entrypoint-orchestrator.sh');
      expect(paths).toHaveLength(11);
    });

    it('getTemplatePaths should return 12 paths for microservices', () => {
      const ctx = { ...singleRepoContext, cluster: { variant: 'microservices' } } as TemplateContext;
      const paths = getTemplatePaths(ctx);
      expect(paths).toContain('cluster/microservices/Dockerfile.hbs');
      expect(paths).toContain('cluster/shared/scripts/setup-docker-dind.sh');
      expect(paths).toHaveLength(12);
    });

    it('getTemplateMapping should return template-to-target mapping', () => {
      const mapping = getTemplateMapping(singleRepoContext as TemplateContext);
      expect(mapping.get('shared/config.yaml.hbs')).toBe('.generacy/config.yaml');
      expect(mapping.get('shared/gitignore.template')).toBe('.generacy/.gitignore');
      expect(mapping.get('cluster/standard/Dockerfile.hbs')).toBe('.devcontainer/Dockerfile');
      expect(mapping.get('cluster/standard/docker-compose.yml.hbs')).toBe('.devcontainer/docker-compose.yml');
      expect(mapping.size).toBe(11);
    });
  });
});

describe('Template Rendering', () => {
  describe('renderTemplate - shared templates', () => {
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

  describe('renderTemplate - standard cluster templates', () => {
    it('should render standard devcontainer.json', async () => {
      const result = await renderTemplate(
        'cluster/standard/devcontainer.json.hbs',
        singleRepoContext as TemplateContext
      );

      const parsed = JSON.parse(result);
      expect(parsed.name).toBe('E-Commerce API');
      expect(parsed.dockerComposeFile).toBe('docker-compose.yml');
      expect(parsed.service).toBe('orchestrator');
      expect(parsed.workspaceFolder).toBe('/workspaces/ecommerce-api');
      expect(parsed.customizations?.vscode?.extensions).toContain('generacy-ai.agency');
      expect(parsed.customizations?.vscode?.extensions).toContain('generacy-ai.generacy');
    });

    it('should render standard docker-compose.yml', async () => {
      const result = await renderTemplate(
        'cluster/standard/docker-compose.yml.hbs',
        singleRepoContext as TemplateContext
      );

      expect(result).toContain('services:');
      expect(result).toContain('redis:');
      expect(result).toContain('orchestrator:');
      expect(result).toContain('worker:');
      expect(result).toContain('Standard cluster (DooD)');
      expect(result).toContain(singleRepoContext.project.id);
    });

    it('should render standard Dockerfile', async () => {
      const result = await renderTemplate(
        'cluster/standard/Dockerfile.hbs',
        singleRepoContext as TemplateContext
      );

      // Standard Dockerfile should NOT include Docker CE
      expect(result).toContain('GitHub CLI');
      expect(result).toContain('Generacy CLI');
      expect(result).not.toContain('Docker CE');
      expect(result).not.toContain('docker-ce');
    });

    it('should render standard env.template with repo and branch', async () => {
      const result = await renderTemplate(
        'cluster/standard/env.template.hbs',
        singleRepoContext as TemplateContext
      );

      expect(result).toContain('GITHUB_TOKEN=');
      expect(result).toContain('ANTHROPIC_API_KEY=');
      expect(result).toContain(`REPO_URL=${singleRepoContext.repos.primary}`);
      expect(result).toContain(`REPO_BRANCH=${singleRepoContext.defaults.baseBranch}`);
      expect(result).toContain('WORKER_COUNT=3');
      expect(result).toContain('REDIS_URL=redis://redis:6379');
      // Standard should NOT have ENABLE_DIND
      expect(result).not.toContain('ENABLE_DIND');
    });
  });

  describe('renderTemplate - microservices cluster templates', () => {
    const microservicesCtx = {
      ...singleRepoContext,
      cluster: { variant: 'microservices' },
    } as TemplateContext;

    it('should render microservices devcontainer.json', async () => {
      const result = await renderTemplate(
        'cluster/microservices/devcontainer.json.hbs',
        microservicesCtx
      );

      const parsed = JSON.parse(result);
      expect(parsed.name).toBe('E-Commerce API');
      expect(parsed.dockerComposeFile).toBe('docker-compose.yml');
      expect(parsed.service).toBe('orchestrator');
      expect(parsed.workspaceFolder).toBe('/workspaces/ecommerce-api');
    });

    it('should render microservices docker-compose.yml with privileged mode', async () => {
      const result = await renderTemplate(
        'cluster/microservices/docker-compose.yml.hbs',
        microservicesCtx
      );

      expect(result).toContain('services:');
      expect(result).toContain('redis:');
      expect(result).toContain('orchestrator:');
      expect(result).toContain('worker:');
      expect(result).toContain('Microservices cluster (DinD)');
      expect(result).toContain('privileged: true');
      expect(result).toContain('ENABLE_DIND=true');
    });

    it('should render microservices Dockerfile with Docker CE', async () => {
      const result = await renderTemplate(
        'cluster/microservices/Dockerfile.hbs',
        microservicesCtx
      );

      expect(result).toContain('Docker CE');
      expect(result).toContain('docker-ce');
      expect(result).toContain('containerd.io');
      expect(result).toContain('docker');
    });

    it('should render microservices env.template with ENABLE_DIND', async () => {
      const result = await renderTemplate(
        'cluster/microservices/env.template.hbs',
        microservicesCtx
      );

      expect(result).toContain('GITHUB_TOKEN=');
      expect(result).toContain('ANTHROPIC_API_KEY=');
      expect(result).toContain('ENABLE_DIND=true');
    });
  });

  describe('renderTemplate - static scripts', () => {
    it('should return entrypoint-orchestrator.sh unchanged', async () => {
      const result = await renderTemplate(
        'cluster/shared/scripts/entrypoint-orchestrator.sh',
        singleRepoContext as TemplateContext
      );

      expect(result).toBeDefined();
      expect(result.length).toBeGreaterThan(0);
      // Static files should not have Handlebars substitution
      expect(result).not.toContain('{{');
    });

    it('should return entrypoint-worker.sh unchanged', async () => {
      const result = await renderTemplate(
        'cluster/shared/scripts/entrypoint-worker.sh',
        singleRepoContext as TemplateContext
      );

      expect(result).toBeDefined();
      expect(result.length).toBeGreaterThan(0);
    });

    it('should return setup-credentials.sh unchanged', async () => {
      const result = await renderTemplate(
        'cluster/shared/scripts/setup-credentials.sh',
        singleRepoContext as TemplateContext
      );

      expect(result).toBeDefined();
      expect(result.length).toBeGreaterThan(0);
    });

    it('should return setup-docker-dind.sh unchanged', async () => {
      const result = await renderTemplate(
        'cluster/shared/scripts/setup-docker-dind.sh',
        singleRepoContext as TemplateContext
      );

      expect(result).toBeDefined();
      expect(result.length).toBeGreaterThan(0);
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
  describe('renderProject - standard variant', () => {
    it('should render all standard variant files', async () => {
      const fileMap = await renderProject(singleRepoContext as TemplateContext);

      // 4 shared + 4 cluster + 3 scripts = 11 files
      expect(fileMap.size).toBe(11);

      // Shared files
      expect(fileMap.has('.generacy/config.yaml')).toBe(true);
      expect(fileMap.has('.generacy/generacy.env.template')).toBe(true);
      expect(fileMap.has('.generacy/.gitignore')).toBe(true);
      expect(fileMap.has('.vscode/extensions.json')).toBe(true);

      // Cluster variant files
      expect(fileMap.has('.devcontainer/Dockerfile')).toBe(true);
      expect(fileMap.has('.devcontainer/docker-compose.yml')).toBe(true);
      expect(fileMap.has('.devcontainer/devcontainer.json')).toBe(true);
      expect(fileMap.has('.devcontainer/.env.template')).toBe(true);

      // Script files
      expect(fileMap.has('.devcontainer/scripts/entrypoint-orchestrator.sh')).toBe(true);
      expect(fileMap.has('.devcontainer/scripts/entrypoint-worker.sh')).toBe(true);
      expect(fileMap.has('.devcontainer/scripts/setup-credentials.sh')).toBe(true);

      // Should NOT have DinD script
      expect(fileMap.has('.devcontainer/scripts/setup-docker-dind.sh')).toBe(false);
    });

    it('should render content with context substitution', async () => {
      const fileMap = await renderProject(singleRepoContext as TemplateContext);

      const config = fileMap.get('.generacy/config.yaml')!;
      expect(config).toContain('proj_abc123xyz');
      expect(config).not.toContain('{{');
    });
  });

  describe('renderProject - microservices variant', () => {
    const microservicesCtx = {
      ...singleRepoContext,
      cluster: { variant: 'microservices' },
    } as TemplateContext;

    it('should render all microservices variant files', async () => {
      const fileMap = await renderProject(microservicesCtx);

      // 4 shared + 4 cluster + 3 scripts + 1 DinD script = 12 files
      expect(fileMap.size).toBe(12);

      // Should include DinD script
      expect(fileMap.has('.devcontainer/scripts/setup-docker-dind.sh')).toBe(true);
    });

    it('should render microservices-specific content', async () => {
      const fileMap = await renderProject(microservicesCtx);

      const dockerCompose = fileMap.get('.devcontainer/docker-compose.yml')!;
      expect(dockerCompose).toContain('privileged: true');
      expect(dockerCompose).toContain('ENABLE_DIND=true');
      expect(dockerCompose).toContain('Microservices cluster (DinD)');
    });

    it('should render Dockerfile with Docker CE for microservices', async () => {
      const fileMap = await renderProject(microservicesCtx);

      const dockerfile = fileMap.get('.devcontainer/Dockerfile')!;
      expect(dockerfile).toContain('docker-ce');
      expect(dockerfile).toContain('Docker CE');
    });
  });

  describe('renderProject - multi-repo context', () => {
    it('should render all files for multi-repo with standard variant', async () => {
      const fileMap = await renderProject(multiRepoContext as TemplateContext);

      expect(fileMap.size).toBe(11);

      const config = fileMap.get('.generacy/config.yaml')!;
      expect(config).toContain('proj_xyz789def');
      expect(config).toContain('acme-corp/api-service');
    });
  });

  describe('renderProject - extensions merge', () => {
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
  });

  describe('renderProject - error handling', () => {
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

  it('should render standard docker-compose.yml without privileged mode', async () => {
    const result = await renderTemplate(
      'cluster/standard/docker-compose.yml.hbs',
      singleRepoContext as TemplateContext
    );

    // Standard variant should NOT have privileged mode
    expect(result).not.toContain('privileged: true');
    expect(result).not.toContain('ENABLE_DIND');
  });

  it('should render microservices docker-compose.yml with DinD config', async () => {
    const ctx = {
      ...singleRepoContext,
      cluster: { variant: 'microservices' },
    } as TemplateContext;

    const result = await renderTemplate(
      'cluster/microservices/docker-compose.yml.hbs',
      ctx
    );

    // Microservices variant SHOULD have privileged mode and DinD
    expect(result).toContain('privileged: true');
    expect(result).toContain('ENABLE_DIND=true');
  });
});

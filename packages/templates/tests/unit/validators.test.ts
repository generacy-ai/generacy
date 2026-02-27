/**
 * Unit tests for template validators
 *
 * Tests pre-render validation (Zod schema checking) and post-render validation
 * (YAML/JSON parsing and structure validation).
 */

import { describe, it, expect } from 'vitest';
import {
  validateContext,
  validateRenderedConfig,
  validateRenderedDevContainer,
  validateRenderedDockerCompose,
  validateRenderedExtensionsJson,
  findUndefinedVariables,
  validateAllRenderedFiles,
  ValidationError,
} from '../../src/validators.js';
import { MultiRepoInputSchema } from '../../src/schema.js';
import type { TemplateContext } from '../../src/schema.js';
import yaml from 'js-yaml';

// Load test fixtures
import singleRepoContext from '../fixtures/single-repo-context.json';
import multiRepoContext from '../fixtures/multi-repo-context.json';
import invalidContexts from '../fixtures/invalid-contexts.json';

describe('Pre-Render Validation', () => {
  describe('validateContext', () => {
    describe('valid contexts', () => {
      it('should validate single-repo context successfully', () => {
        const result = validateContext(singleRepoContext);
        expect(result).toBeDefined();
        expect(result.project.id).toBe('proj_abc123xyz');
        expect(result.repos.isMultiRepo).toBe(false);
      });

      it('should validate multi-repo context successfully', () => {
        const result = validateContext(multiRepoContext);
        expect(result).toBeDefined();
        expect(result.project.id).toBe('proj_xyz789def');
        expect(result.repos.isMultiRepo).toBe(true);
      });

      it('should return typed TemplateContext', () => {
        const result = validateContext(singleRepoContext);

        // Check all expected properties exist
        expect(result.project).toBeDefined();
        expect(result.repos).toBeDefined();
        expect(result.defaults).toBeDefined();
        expect(result.orchestrator).toBeDefined();
        expect(result.devcontainer).toBeDefined();
        expect(result.metadata).toBeDefined();
      });

      it('should accept valid timestamps', () => {
        const context = {
          ...singleRepoContext,
          metadata: {
            ...singleRepoContext.metadata,
            timestamp: '2026-02-24T10:30:45.123Z',
          },
        };

        const result = validateContext(context);
        expect(result.metadata.timestamp).toBe('2026-02-24T10:30:45.123Z');
      });

      it('should accept valid semver versions', () => {
        const validVersions = ['1.0.0', '2.1.3', '10.20.30'];

        for (const version of validVersions) {
          const context = {
            ...singleRepoContext,
            metadata: {
              ...singleRepoContext.metadata,
              version,
            },
          };

          const result = validateContext(context);
          expect(result.metadata.version).toBe(version);
        }
      });

      it('should accept valid repo formats', () => {
        const validRepos = [
          'simple/repo',
          'org-name/repo-name',
          'org.name/repo.name',
          'org_name/repo_name',
        ];

        for (const repo of validRepos) {
          const context = {
            ...singleRepoContext,
            repos: {
              ...singleRepoContext.repos,
              primary: repo,
            },
          };

          const result = validateContext(context);
          expect(result.repos.primary).toBe(repo);
        }
      });

      it('should accept zero worker count for single-repo', () => {
        const result = validateContext(singleRepoContext);
        expect(result.orchestrator.workerCount).toBe(0);
      });

      it('should accept positive worker count for multi-repo', () => {
        const result = validateContext(multiRepoContext);
        expect(result.orchestrator.workerCount).toBeGreaterThan(0);
      });
    });

    describe('invalid contexts', () => {
      it('should reject context with missing project.id', () => {
        const { context } = invalidContexts.missingProjectId;

        expect(() => validateContext(context)).toThrow(ValidationError);
        expect(() => validateContext(context)).toThrow(/project\.id/);
        expect(() => validateContext(context)).toThrow(/Required/);
      });

      it('should reject context with invalid repo format', () => {
        const { context, expectedError } = invalidContexts.invalidRepoFormat;

        expect(() => validateContext(context)).toThrow(ValidationError);
        expect(() => validateContext(context)).toThrow(expectedError);
      });

      it('should reject context with invalid feature tag', () => {
        const { context, expectedError } = invalidContexts.invalidFeatureTag;

        expect(() => validateContext(context)).toThrow(ValidationError);
        expect(() => validateContext(context)).toThrow(expectedError);
      });

      it('should reject context with negative worker count', () => {
        const { context, expectedError } = invalidContexts.negativeWorkerCount;

        expect(() => validateContext(context)).toThrow(ValidationError);
        expect(() => validateContext(context)).toThrow(expectedError);
      });

      it('should reject context with invalid timestamp', () => {
        const { context, expectedError } = invalidContexts.invalidTimestamp;

        expect(() => validateContext(context)).toThrow(ValidationError);
        expect(() => validateContext(context)).toThrow(expectedError);
      });

      it('should reject context with invalid version format', () => {
        const { context, expectedError } = invalidContexts.invalidVersionFormat;

        expect(() => validateContext(context)).toThrow(ValidationError);
        expect(() => validateContext(context)).toThrow(expectedError);
      });

      it('should reject context with empty project name', () => {
        const { context, expectedError } = invalidContexts.emptyProjectName;

        expect(() => validateContext(context)).toThrow(ValidationError);
        expect(() => validateContext(context)).toThrow(expectedError);
      });

      it('should reject context with invalid dev repo format', () => {
        const { context } = invalidContexts.invalidDevRepoFormat;

        expect(() => validateContext(context)).toThrow(ValidationError);
        expect(() => validateContext(context)).toThrow(/Invalid/);
      });

      it('should reject context with zero poll interval', () => {
        const { context, expectedError } = invalidContexts.zeroPollInterval;

        expect(() => validateContext(context)).toThrow(ValidationError);
        expect(() => validateContext(context)).toThrow(expectedError);
      });

      it('should reject context with low poll interval (below 5000ms)', () => {
        const { context, expectedError } = invalidContexts.lowPollInterval;

        expect(() => validateContext(context)).toThrow(ValidationError);
        expect(() => validateContext(context)).toThrow(expectedError);
      });

      it('should reject repo name collisions', () => {
        const context = {
          ...multiRepoContext,
          repos: {
            primary: 'org-a/shared-lib',
            dev: ['org-b/shared-lib'],
            clone: [],
            hasDevRepos: true,
            hasCloneRepos: false,
            isMultiRepo: true,
          },
        };

        expect(() => validateContext(context)).toThrow(ValidationError);
        expect(() => validateContext(context)).toThrow(/Multiple repos resolve to the same mount path "shared-lib"/);
      });

      it('should reject repo name collisions across dev and clone arrays', () => {
        const context = {
          ...multiRepoContext,
          repos: {
            primary: 'org/primary',
            dev: ['org-a/utils'],
            clone: ['org-b/utils'],
            hasDevRepos: true,
            hasCloneRepos: true,
            isMultiRepo: true,
          },
        };

        expect(() => validateContext(context)).toThrow(ValidationError);
        expect(() => validateContext(context)).toThrow(/Multiple repos resolve to the same mount path "utils"/);
      });

      it('should accept repos with same org but different names', () => {
        const context = {
          ...multiRepoContext,
          repos: {
            primary: 'acme/frontend',
            dev: ['acme/backend', 'acme/shared'],
            clone: [],
            hasDevRepos: true,
            hasCloneRepos: false,
            isMultiRepo: true,
          },
        };

        expect(() => validateContext(context)).not.toThrow();
      });

      it('should reject completely missing context', () => {
        expect(() => validateContext(undefined)).toThrow(ValidationError);
      });

      it('should reject null context', () => {
        expect(() => validateContext(null)).toThrow(ValidationError);
      });

      it('should reject empty object', () => {
        expect(() => validateContext({})).toThrow(ValidationError);
      });

      it('should reject context missing repos section', () => {
        const context = {
          project: singleRepoContext.project,
          // Missing repos
          defaults: singleRepoContext.defaults,
        };

        expect(() => validateContext(context)).toThrow(ValidationError);
      });
    });

    describe('ValidationError structure', () => {
      it('should throw ValidationError with formatted message', () => {
        const { context } = invalidContexts.missingProjectId;

        try {
          validateContext(context);
          expect.fail('Should have thrown ValidationError');
        } catch (error) {
          expect(error).toBeInstanceOf(ValidationError);
          expect(error).toBeInstanceOf(Error);
        }
      });

      it('should include error details in ValidationError', () => {
        const { context } = invalidContexts.missingProjectId;

        try {
          validateContext(context);
          expect.fail('Should have thrown ValidationError');
        } catch (error) {
          const validationError = error as ValidationError;
          expect(validationError.errors).toBeDefined();
          expect(Array.isArray(validationError.errors)).toBe(true);
          expect(validationError.errors.length).toBeGreaterThan(0);
        }
      });

      it('should include path and message in error details', () => {
        const { context } = invalidContexts.missingProjectId;

        try {
          validateContext(context);
          expect.fail('Should have thrown ValidationError');
        } catch (error) {
          const validationError = error as ValidationError;
          const firstError = validationError.errors[0];

          expect(firstError.path).toBeDefined();
          expect(firstError.message).toBeDefined();
          expect(typeof firstError.path).toBe('string');
          expect(typeof firstError.message).toBe('string');
        }
      });

      it('should format multiple errors', () => {
        const invalidContext = {
          project: {
            // Missing id
            name: '',  // Empty name
          },
          repos: {
            primary: 'invalid',  // Invalid format
            dev: [],
            clone: [],
            hasDevRepos: false,
            hasCloneRepos: false,
            isMultiRepo: false,
          },
        };

        try {
          validateContext(invalidContext);
          expect.fail('Should have thrown ValidationError');
        } catch (error) {
          const validationError = error as ValidationError;
          // Should have multiple errors
          expect(validationError.errors.length).toBeGreaterThan(1);
        }
      });

      it('should include readable error message', () => {
        const { context } = invalidContexts.missingProjectId;

        try {
          validateContext(context);
          expect.fail('Should have thrown ValidationError');
        } catch (error) {
          expect(error.message).toContain('Template context validation failed');
          expect(error.message).toContain('project.id');
        }
      });
    });
  });
});

describe('MultiRepoInputSchema Validation', () => {
  it('should reject workerCount: 0 for multi-repo input', () => {
    const input = {
      projectId: 'proj_123',
      projectName: 'Test Project',
      primaryRepo: 'test/repo',
      devRepos: ['test/dev1'],
      workerCount: 0,
    };

    expect(() => MultiRepoInputSchema.parse(input)).toThrow(
      'Number must be greater than or equal to 1'
    );
  });

  it('should reject workerCount > 20 for multi-repo input', () => {
    const input = {
      projectId: 'proj_123',
      projectName: 'Test Project',
      primaryRepo: 'test/repo',
      devRepos: ['test/dev1'],
      workerCount: 21,
    };

    expect(() => MultiRepoInputSchema.parse(input)).toThrow(
      'Number must be less than or equal to 20'
    );
  });

  it('should reject pollIntervalMs below 5000 for multi-repo input', () => {
    const input = {
      projectId: 'proj_123',
      projectName: 'Test Project',
      primaryRepo: 'test/repo',
      devRepos: ['test/dev1'],
      pollIntervalMs: 1000,
    };

    expect(() => MultiRepoInputSchema.parse(input)).toThrow(
      'Number must be greater than or equal to 5000'
    );
  });

  it('should accept valid multi-repo input', () => {
    const input = {
      projectId: 'proj_123',
      projectName: 'Test Project',
      primaryRepo: 'test/repo',
      devRepos: ['test/dev1'],
      workerCount: 2,
      pollIntervalMs: 5000,
    };

    expect(() => MultiRepoInputSchema.parse(input)).not.toThrow();
  });
});

describe('Post-Render Validation', () => {
  describe('validateRenderedConfig', () => {
    describe('valid YAML', () => {
      it('should accept valid single-repo config.yaml', () => {
        const validYaml = yaml.dump({
          project: {
            id: 'proj_123',
            name: 'Test Project',
          },
          repos: {
            primary: 'owner/repo',
          },
          defaults: {
            agent: 'claude-code',
            baseBranch: 'main',
          },
        });

        expect(() => validateRenderedConfig(validYaml)).not.toThrow();
      });

      it('should accept valid multi-repo config.yaml with orchestrator', () => {
        const validYaml = yaml.dump({
          project: {
            id: 'proj_123',
            name: 'Test Project',
          },
          repos: {
            primary: 'owner/repo',
            isMultiRepo: true,
            dev: ['owner/dev1'],
          },
          orchestrator: {
            pollIntervalMs: 5000,
            workerCount: 3,
          },
          defaults: {
            agent: 'claude-code',
          },
        });

        expect(() => validateRenderedConfig(validYaml)).not.toThrow();
      });

      it('should accept config with optional fields present', () => {
        const validYaml = yaml.dump({
          project: {
            id: 'proj_123',
            name: 'Test Project',
          },
          repos: {
            primary: 'owner/repo',
            dev: ['owner/dev1'],
            clone: ['owner/lib1'],
          },
          defaults: {
            agent: 'claude-code',
            baseBranch: 'main',
            releaseStream: 'stable',
          },
          metadata: {
            timestamp: '2026-02-24T10:00:00Z',
            generatedBy: 'generacy-cli',
            version: '1.0.0',
          },
        });

        expect(() => validateRenderedConfig(validYaml)).not.toThrow();
      });
    });

    describe('invalid YAML', () => {
      it('should reject malformed YAML', () => {
        const malformedYaml = `
          project:
            id: "test"
            name: "Test
          invalid yaml syntax
        `;

        expect(() => validateRenderedConfig(malformedYaml)).toThrow(/Invalid YAML/);
      });

      it('should reject YAML missing project section', () => {
        const yamlMissingProject = yaml.dump({
          repos: {
            primary: 'owner/repo',
          },
        });

        expect(() => validateRenderedConfig(yamlMissingProject)).toThrow(/missing required fields.*project/);
      });

      it('should reject YAML missing repos section', () => {
        const yamlMissingRepos = yaml.dump({
          project: {
            id: 'proj_123',
            name: 'Test',
          },
        });

        expect(() => validateRenderedConfig(yamlMissingRepos)).toThrow(/missing required fields.*repos/);
      });

      it('should reject YAML missing project.id', () => {
        const yamlMissingId = yaml.dump({
          project: {
            name: 'Test',
          },
          repos: {
            primary: 'owner/repo',
          },
        });

        expect(() => validateRenderedConfig(yamlMissingId)).toThrow(/missing required field.*project\.id/);
      });

      it('should reject YAML missing repos.primary', () => {
        const yamlMissingPrimary = yaml.dump({
          project: {
            id: 'proj_123',
            name: 'Test',
          },
          repos: {},
        });

        expect(() => validateRenderedConfig(yamlMissingPrimary)).toThrow(/missing required field.*repos\.primary/);
      });

      it('should reject multi-repo without orchestrator config', () => {
        const yamlMissingOrchestrator = yaml.dump({
          project: {
            id: 'proj_123',
            name: 'Test',
          },
          repos: {
            primary: 'owner/repo',
            isMultiRepo: true,
            dev: ['owner/dev1'],
          },
          // Missing orchestrator
        });

        expect(() => validateRenderedConfig(yamlMissingOrchestrator)).toThrow(/missing orchestrator configuration/);
      });

      it('should reject empty string', () => {
        // Empty string parses as null in YAML, which fails field validation
        expect(() => validateRenderedConfig('')).toThrow(/missing required fields/);
      });

      it('should reject non-object YAML (array)', () => {
        const arrayYaml = yaml.dump(['item1', 'item2']);
        expect(() => validateRenderedConfig(arrayYaml)).toThrow(/missing required fields/);
      });

      it('should reject non-object YAML (string)', () => {
        const stringYaml = 'just a string';
        expect(() => validateRenderedConfig(stringYaml)).toThrow(/missing required fields/);
      });
    });
  });

  describe('validateRenderedDevContainer', () => {
    describe('valid JSON', () => {
      it('should accept valid single-repo devcontainer.json', () => {
        const validJson = JSON.stringify({
          name: 'Test Project',
          image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
          features: {
            'ghcr.io/generacy-ai/generacy/generacy:1': {},
          },
          customizations: {
            vscode: {
              extensions: ['generacy-ai.agency', 'generacy-ai.generacy'],
            },
          },
        });

        expect(() => validateRenderedDevContainer(validJson)).not.toThrow();
      });

      it('should accept valid multi-repo devcontainer.json', () => {
        const validJson = JSON.stringify({
          name: 'Test Project',
          dockerComposeFile: 'docker-compose.yml',
          service: 'orchestrator',
          workspaceFolder: '/workspaces/primary',
          features: {
            'ghcr.io/generacy-ai/generacy/generacy:1': {},
          },
        });

        expect(() => validateRenderedDevContainer(validJson)).not.toThrow();
      });

      it('should accept devcontainer with customizations but no features', () => {
        const validJson = JSON.stringify({
          name: 'Test Project',
          image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
          customizations: {
            vscode: {
              extensions: ['generacy-ai.agency'],
              settings: {
                'editor.formatOnSave': true,
              },
            },
          },
        });

        expect(() => validateRenderedDevContainer(validJson)).not.toThrow();
      });
    });

    describe('invalid JSON', () => {
      it('should reject malformed JSON', () => {
        const malformedJson = '{ "name": "test", invalid json }';
        expect(() => validateRenderedDevContainer(malformedJson)).toThrow(/Invalid JSON/);
      });

      it('should reject JSON missing name field', () => {
        const jsonMissingName = JSON.stringify({
          image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
        });

        expect(() => validateRenderedDevContainer(jsonMissingName)).toThrow(/missing required field.*name/);
      });

      it('should reject JSON without image or dockerComposeFile', () => {
        const jsonMissingBoth = JSON.stringify({
          name: 'Test Project',
          features: {},
        });

        expect(() => validateRenderedDevContainer(jsonMissingBoth)).toThrow(/must have either "image".*or "dockerComposeFile"/);
      });

      it('should reject dockerComposeFile without service', () => {
        const jsonMissingService = JSON.stringify({
          name: 'Test Project',
          dockerComposeFile: 'docker-compose.yml',
          // Missing service
          features: {
            'ghcr.io/generacy-ai/generacy/generacy:1': {},
          },
        });

        expect(() => validateRenderedDevContainer(jsonMissingService)).toThrow(/must specify "service" name/);
      });

      it('should reject devcontainer without features or customizations', () => {
        const jsonMissingBoth = JSON.stringify({
          name: 'Test Project',
          image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
        });

        expect(() => validateRenderedDevContainer(jsonMissingBoth)).toThrow(/should have either "features" or "customizations"/);
      });

      it('should reject features without Generacy feature', () => {
        const jsonMissingGeneracyFeature = JSON.stringify({
          name: 'Test Project',
          image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
          features: {
            'ghcr.io/devcontainers/features/git:1': {},
            'ghcr.io/devcontainers/features/node:1': {},
          },
        });

        expect(() => validateRenderedDevContainer(jsonMissingGeneracyFeature)).toThrow(/should include Generacy Dev Container Feature/);
      });

      it('should reject empty string', () => {
        expect(() => validateRenderedDevContainer('')).toThrow(/Invalid JSON/);
      });

      it('should reject non-object JSON (array)', () => {
        const arrayJson = JSON.stringify(['item1', 'item2']);
        expect(() => validateRenderedDevContainer(arrayJson)).toThrow(/missing required field/);
      });
    });

    describe('edge cases', () => {
      it('should accept Generacy feature with different version tags', () => {
        const featureTags = [
          'ghcr.io/generacy-ai/generacy/generacy:1',
          'ghcr.io/generacy-ai/generacy/generacy:preview',
          'ghcr.io/generacy-ai/generacy/generacy:latest',
        ];

        for (const featureTag of featureTags) {
          const validJson = JSON.stringify({
            name: 'Test Project',
            image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
            features: {
              [featureTag]: {},
            },
          });

          expect(() => validateRenderedDevContainer(validJson)).not.toThrow();
        }
      });

      it('should handle both image and dockerComposeFile (prefer dockerComposeFile)', () => {
        const jsonWithBoth = JSON.stringify({
          name: 'Test Project',
          image: 'some-image',
          dockerComposeFile: 'docker-compose.yml',
          service: 'orchestrator',
          features: {
            'ghcr.io/generacy-ai/generacy/generacy:1': {},
          },
        });

        // Should not throw - dockerComposeFile is present
        expect(() => validateRenderedDevContainer(jsonWithBoth)).not.toThrow();
      });
    });
  });

  describe('validateRenderedDockerCompose', () => {
    describe('valid YAML', () => {
      it('should accept valid docker-compose.yml', () => {
        const validYaml = yaml.dump({
          services: {
            redis: {
              image: 'redis:7-alpine',
            },
            orchestrator: {
              image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
              depends_on: ['redis'],
            },
            worker: {
              image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
              depends_on: ['redis'],
            },
          },
        });

        expect(() => validateRenderedDockerCompose(validYaml)).not.toThrow();
      });

      it('should accept docker-compose with build instead of image', () => {
        const validYaml = yaml.dump({
          services: {
            redis: {
              image: 'redis:7-alpine',
            },
            orchestrator: {
              build: {
                context: '.',
                dockerfile: 'Dockerfile',
              },
            },
            worker: {
              image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
            },
          },
        });

        expect(() => validateRenderedDockerCompose(validYaml)).not.toThrow();
      });

      it('should accept docker-compose with additional services beyond required', () => {
        const validYaml = yaml.dump({
          services: {
            redis: {
              image: 'redis:7-alpine',
            },
            orchestrator: {
              image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
            },
            worker: {
              image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
            },
            database: {
              image: 'postgres:15',
            },
          },
        });

        expect(() => validateRenderedDockerCompose(validYaml)).not.toThrow();
      });
    });

    describe('invalid YAML', () => {
      it('should reject malformed YAML', () => {
        const malformedYaml = `
          services:
            redis:
              image: "redis
          invalid yaml
        `;

        expect(() => validateRenderedDockerCompose(malformedYaml)).toThrow(/Invalid YAML/);
      });

      it('should reject YAML missing services section', () => {
        const yamlMissingServices = yaml.dump({
          version: '3.8',
        });

        expect(() => validateRenderedDockerCompose(yamlMissingServices)).toThrow(/missing "services" section/);
      });

      it('should reject YAML missing redis service', () => {
        const yamlMissingRedis = yaml.dump({
          services: {
            orchestrator: {
              image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
            },
            worker: {
              image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
            },
          },
        });

        expect(() => validateRenderedDockerCompose(yamlMissingRedis)).toThrow(/missing required services.*redis/);
      });

      it('should reject YAML missing orchestrator service', () => {
        const yamlMissingOrchestrator = yaml.dump({
          services: {
            redis: {
              image: 'redis:7-alpine',
            },
            worker: {
              image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
            },
          },
        });

        expect(() => validateRenderedDockerCompose(yamlMissingOrchestrator)).toThrow(/missing required services.*orchestrator/);
      });

      it('should reject YAML missing worker service', () => {
        const yamlMissingWorker = yaml.dump({
          services: {
            redis: {
              image: 'redis:7-alpine',
            },
            orchestrator: {
              image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
            },
          },
        });

        expect(() => validateRenderedDockerCompose(yamlMissingWorker)).toThrow(/missing required services.*worker/);
      });

      it('should reject orchestrator without image or build', () => {
        const yamlMissingImageOrBuild = yaml.dump({
          services: {
            redis: {
              image: 'redis:7-alpine',
            },
            orchestrator: {
              command: 'echo hello',
            },
            worker: {
              image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
            },
          },
        });

        expect(() => validateRenderedDockerCompose(yamlMissingImageOrBuild)).toThrow(/orchestrator service must specify "image" or "build"/);
      });

      it('should reject redis without image', () => {
        const yamlRedisNoImage = yaml.dump({
          services: {
            redis: {
              command: 'redis-server',
            },
            orchestrator: {
              image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
            },
            worker: {
              image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
            },
          },
        });

        expect(() => validateRenderedDockerCompose(yamlRedisNoImage)).toThrow(/redis service must specify "image"/);
      });

      it('should reject empty string', () => {
        // Empty string parses as null in YAML, which fails structure validation
        expect(() => validateRenderedDockerCompose('')).toThrow(/missing "services" section/);
      });
    });
  });

  describe('validateRenderedExtensionsJson', () => {
    describe('valid JSON', () => {
      it('should accept valid extensions.json with Generacy extensions', () => {
        const validJson = JSON.stringify({
          recommendations: [
            'generacy-ai.agency',
            'generacy-ai.generacy',
          ],
        });

        expect(() => validateRenderedExtensionsJson(validJson)).not.toThrow();
      });

      it('should accept extensions.json with additional recommendations', () => {
        const validJson = JSON.stringify({
          recommendations: [
            'generacy-ai.agency',
            'generacy-ai.generacy',
            'dbaeumer.vscode-eslint',
            'esbenp.prettier-vscode',
          ],
        });

        expect(() => validateRenderedExtensionsJson(validJson)).not.toThrow();
      });

      it('should accept extensions.json with other properties', () => {
        const validJson = JSON.stringify({
          recommendations: [
            'generacy-ai.agency',
            'generacy-ai.generacy',
          ],
          unwantedRecommendations: [
            'ms-vscode.cpptools',
          ],
        });

        expect(() => validateRenderedExtensionsJson(validJson)).not.toThrow();
      });
    });

    describe('invalid JSON', () => {
      it('should reject malformed JSON', () => {
        const malformedJson = '{ "recommendations": [invalid] }';
        expect(() => validateRenderedExtensionsJson(malformedJson)).toThrow(/Invalid JSON/);
      });

      it('should reject JSON missing recommendations array', () => {
        const jsonMissingRecommendations = JSON.stringify({
          unwantedRecommendations: ['something'],
        });

        expect(() => validateRenderedExtensionsJson(jsonMissingRecommendations)).toThrow(/must have "recommendations" array/);
      });

      it('should reject JSON with recommendations as non-array', () => {
        const jsonRecommendationsNotArray = JSON.stringify({
          recommendations: 'not-an-array',
        });

        expect(() => validateRenderedExtensionsJson(jsonRecommendationsNotArray)).toThrow(/must have "recommendations" array/);
      });

      it('should reject extensions.json missing agency extension', () => {
        const jsonMissingAgency = JSON.stringify({
          recommendations: [
            'generacy-ai.generacy',
            'dbaeumer.vscode-eslint',
          ],
        });

        expect(() => validateRenderedExtensionsJson(jsonMissingAgency)).toThrow(/missing "generacy-ai\.agency"/);
      });

      it('should reject extensions.json missing generacy extension', () => {
        const jsonMissingGeneracy = JSON.stringify({
          recommendations: [
            'generacy-ai.agency',
            'dbaeumer.vscode-eslint',
          ],
        });

        expect(() => validateRenderedExtensionsJson(jsonMissingGeneracy)).toThrow(/missing "generacy-ai\.generacy"/);
      });

      it('should reject empty recommendations array', () => {
        const jsonEmptyRecommendations = JSON.stringify({
          recommendations: [],
        });

        expect(() => validateRenderedExtensionsJson(jsonEmptyRecommendations)).toThrow(/missing "generacy-ai\.agency"/);
      });

      it('should reject empty string', () => {
        expect(() => validateRenderedExtensionsJson('')).toThrow(/Invalid JSON/);
      });
    });
  });
});

describe('Validation Helpers', () => {
  describe('findUndefinedVariables', () => {
    it('should find simple undefined variables', () => {
      const content = 'Hello {{name}}, welcome to {{project}}!';
      const undefined = findUndefinedVariables(content);

      expect(undefined).toContain('name');
      expect(undefined).toContain('project');
      expect(undefined).toHaveLength(2);
    });

    it('should find nested property references', () => {
      const content = 'Project: {{project.name}}, ID: {{project.id}}';
      const undefined = findUndefinedVariables(content);

      expect(undefined).toContain('project.name');
      expect(undefined).toContain('project.id');
    });

    it('should find triple-brace variables', () => {
      const content = 'Unescaped: {{{html}}}';
      const undefined = findUndefinedVariables(content);

      expect(undefined).toContain('html');
    });

    it('should handle variables with underscores', () => {
      const content = '{{base_url}}, {{api_key}}';
      const undefined = findUndefinedVariables(content);

      expect(undefined).toContain('base_url');
      expect(undefined).toContain('api_key');
    });

    it('should deduplicate repeated variables', () => {
      const content = '{{name}} and {{name}} and {{name}}';
      const undefined = findUndefinedVariables(content);

      expect(undefined).toHaveLength(1);
      expect(undefined[0]).toBe('name');
    });

    it('should return empty array for fully rendered content', () => {
      const content = 'Hello World, no variables here!';
      const undefined = findUndefinedVariables(content);

      expect(undefined).toHaveLength(0);
    });

    it('should not match Handlebars block helpers', () => {
      // Block helpers like {{#if}} don't match the variable pattern
      // because they start with # or /
      const content = '{{#if condition}}text{{/if}}';
      const undefined = findUndefinedVariables(content);

      // The regex requires variables to start with [a-zA-Z_], so #if and /if don't match
      expect(undefined.length).toBe(0);
    });

    it('should handle empty string', () => {
      const undefined = findUndefinedVariables('');
      expect(undefined).toHaveLength(0);
    });

    it('should handle content with no braces', () => {
      const content = 'Just plain text without any template syntax';
      const undefined = findUndefinedVariables('');
      expect(undefined).toHaveLength(0);
    });

    it('should handle variables with spaces', () => {
      const content = '{{ name }}, {{ project.id }}';
      const undefined = findUndefinedVariables(content);

      expect(undefined).toContain('name');
      expect(undefined).toContain('project.id');
    });

    it('should find variables in YAML content', () => {
      const yamlContent = `
project:
  id: {{project.id}}
  name: {{project.name}}
repos:
  primary: {{repos.primary}}
      `;
      const undefined = findUndefinedVariables(yamlContent);

      expect(undefined).toContain('project.id');
      expect(undefined).toContain('project.name');
      expect(undefined).toContain('repos.primary');
    });

    it('should find variables in JSON content', () => {
      const jsonContent = `{
  "name": "{{name}}",
  "value": {{value}}
}`;
      const undefined = findUndefinedVariables(jsonContent);

      expect(undefined).toContain('name');
      expect(undefined).toContain('value');
    });
  });

  describe('validateAllRenderedFiles', () => {
    it('should validate all files successfully', () => {
      const files = new Map([
        [
          '.generacy/config.yaml',
          yaml.dump({
            project: { id: 'proj_123', name: 'Test' },
            repos: { primary: 'owner/repo' },
          }),
        ],
        [
          '.devcontainer/devcontainer.json',
          JSON.stringify({
            name: 'Test',
            image: 'ubuntu',
            features: { 'ghcr.io/generacy-ai/generacy/generacy:1': {} },
          }),
        ],
        [
          '.vscode/extensions.json',
          JSON.stringify({
            recommendations: ['generacy-ai.agency', 'generacy-ai.generacy'],
          }),
        ],
      ]);

      expect(() => validateAllRenderedFiles(files)).not.toThrow();
    });

    it('should validate multi-repo files including docker-compose', () => {
      const files = new Map([
        [
          '.generacy/config.yaml',
          yaml.dump({
            project: { id: 'proj_123', name: 'Test' },
            repos: { primary: 'owner/repo', isMultiRepo: true, dev: ['owner/dev1'] },
            orchestrator: { pollIntervalMs: 5000, workerCount: 2 },
          }),
        ],
        [
          '.devcontainer/devcontainer.json',
          JSON.stringify({
            name: 'Test',
            dockerComposeFile: 'docker-compose.yml',
            service: 'orchestrator',
            features: { 'ghcr.io/generacy-ai/generacy/generacy:1': {} },
          }),
        ],
        [
          '.devcontainer/docker-compose.yml',
          yaml.dump({
            services: {
              redis: { image: 'redis:7-alpine' },
              orchestrator: { image: 'ubuntu' },
              worker: { image: 'ubuntu' },
            },
          }),
        ],
        [
          '.vscode/extensions.json',
          JSON.stringify({
            recommendations: ['generacy-ai.agency', 'generacy-ai.generacy'],
          }),
        ],
      ]);

      expect(() => validateAllRenderedFiles(files)).not.toThrow();
    });

    it('should throw error for invalid config.yaml', () => {
      const files = new Map([
        ['.generacy/config.yaml', 'invalid: yaml: [[['],
      ]);

      expect(() => validateAllRenderedFiles(files)).toThrow(/Validation failed for.*config\.yaml/);
    });

    it('should throw error for invalid devcontainer.json', () => {
      const files = new Map([
        ['.devcontainer/devcontainer.json', '{ invalid json }'],
      ]);

      expect(() => validateAllRenderedFiles(files)).toThrow(/Validation failed for.*devcontainer\.json/);
    });

    it('should throw error for invalid docker-compose.yml', () => {
      const files = new Map([
        ['.devcontainer/docker-compose.yml', 'invalid: yaml: [[['],
      ]);

      expect(() => validateAllRenderedFiles(files)).toThrow(/Validation failed for.*docker-compose\.yml/);
    });

    it('should throw error for invalid extensions.json', () => {
      const files = new Map([
        ['.vscode/extensions.json', '{ invalid json }'],
      ]);

      expect(() => validateAllRenderedFiles(files)).toThrow(/Validation failed for.*extensions\.json/);
    });

    it('should throw error for files with undefined variables', () => {
      const files = new Map([
        [
          '.generacy/config.yaml',
          yaml.dump({
            project: { id: 'proj_123', name: 'Test' },
            repos: { primary: 'owner/repo' },
          }),
        ],
        [
          '.generacy/generacy.env.template',
          'PROJECT_ID={{project.id}}\nGITHUB_TOKEN={{github.token}}',
        ],
      ]);

      expect(() => validateAllRenderedFiles(files)).toThrow(/unrendered template variables/);
      expect(() => validateAllRenderedFiles(files)).toThrow(/generacy\.env\.template/);
    });

    it('should include file path in error message', () => {
      const files = new Map([
        ['.generacy/config.yaml', 'invalid yaml'],
      ]);

      try {
        validateAllRenderedFiles(files);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('.generacy/config.yaml');
      }
    });

    it('should handle empty file map', () => {
      const files = new Map<string, string>();
      expect(() => validateAllRenderedFiles(files)).not.toThrow();
    });

    it('should skip validation for unrecognized file types', () => {
      const files = new Map([
        ['.generacy/.gitignore', 'generacy.env\n.agent-state/'],
        ['.generacy/README.md', '# Generacy Config'],
      ]);

      // Should not throw - these files don't have validators
      expect(() => validateAllRenderedFiles(files)).not.toThrow();
    });

    it('should validate multiple files and stop at first error', () => {
      const files = new Map([
        [
          '.generacy/config.yaml',
          'invalid yaml',  // This will fail
        ],
        [
          '.vscode/extensions.json',
          'also invalid',  // This would also fail but won't be reached
        ],
      ]);

      expect(() => validateAllRenderedFiles(files)).toThrow();
    });
  });
});

describe('Error Message Quality', () => {
  it('should provide helpful error for common mistakes', () => {
    const context = {
      ...singleRepoContext,
      repos: {
        ...singleRepoContext.repos,
        primary: 'missing-slash',  // Common mistake: forgot owner/
      },
    };

    try {
      validateContext(context);
      expect.fail('Should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('owner/repo');
      expect(message).toContain('repos.primary');
    }
  });

  it('should provide line numbers for YAML parsing errors', () => {
    const invalidYaml = `
project:
  id: "test"
repos: [invalid array syntax
  primary: "owner/repo"
    `;

    try {
      validateRenderedConfig(invalidYaml);
      expect.fail('Should have thrown');
    } catch (error) {
      // js-yaml includes line/column info in error message
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Invalid YAML');
    }
  });

  it('should provide context for JSON parsing errors', () => {
    const invalidJson = `{
  "name": "test",
  "value": invalid
}`;

    try {
      validateRenderedDevContainer(invalidJson);
      expect.fail('Should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('Invalid JSON');
    }
  });

  it('should explain what fields are missing', () => {
    const yamlMissingFields = yaml.dump({
      project: {},
      repos: {},
    });

    try {
      validateRenderedConfig(yamlMissingFields);
      expect.fail('Should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('project.id');
    }
  });
});

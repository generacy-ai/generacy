/**
 * Unit tests for context builder utilities
 *
 * Tests builder functions that construct TemplateContext objects from simpler
 * input types. Verifies default application, metadata generation, and validation.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  buildSingleRepoContext,
  buildMultiRepoContext,
  withGeneratedBy,
  withBaseImage,
  withBaseBranch,
  withOrchestrator,
  quickSingleRepo,
  quickMultiRepo,
} from '../../src/builders.js';
import type { TemplateContext, SingleRepoInput, MultiRepoInput } from '../../src/schema.js';

describe('Single-Repo Context Builder', () => {
  describe('buildSingleRepoContext', () => {
    describe('minimal options', () => {
      it('should build valid context with only required fields', () => {
        const input: SingleRepoInput = {
          projectId: 'proj_test123',
          projectName: 'Test Project',
          primaryRepo: 'acme/test-repo',
        };

        const context = buildSingleRepoContext(input);

        expect(context).toBeDefined();
        expect(context.project.id).toBe('proj_test123');
        expect(context.project.name).toBe('Test Project');
        expect(context.repos.primary).toBe('acme/test-repo');
      });

      it('should apply default baseImage when not provided', () => {
        const input: SingleRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/repo',
        };

        const context = buildSingleRepoContext(input);

        expect(context.devcontainer.baseImage).toBe('mcr.microsoft.com/devcontainers/base:ubuntu');
      });

      it('should apply default releaseStream (stable) when not provided', () => {
        const input: SingleRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/repo',
        };

        const context = buildSingleRepoContext(input);

        expect(context.defaults.releaseStream).toBe('stable');
      });

      it('should apply default baseBranch (main) when not provided', () => {
        const input: SingleRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/repo',
        };

        const context = buildSingleRepoContext(input);

        expect(context.defaults.baseBranch).toBe('main');
      });

      it('should set repos.dev to empty array', () => {
        const input: SingleRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/repo',
        };

        const context = buildSingleRepoContext(input);

        expect(context.repos.dev).toEqual([]);
        expect(context.repos.hasDevRepos).toBe(false);
      });

      it('should set repos.clone to empty array', () => {
        const input: SingleRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/repo',
        };

        const context = buildSingleRepoContext(input);

        expect(context.repos.clone).toEqual([]);
        expect(context.repos.hasCloneRepos).toBe(false);
      });

      it('should set isMultiRepo to false', () => {
        const input: SingleRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/repo',
        };

        const context = buildSingleRepoContext(input);

        expect(context.repos.isMultiRepo).toBe(false);
      });

      it('should set workerCount to 0 for single-repo', () => {
        const input: SingleRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/repo',
        };

        const context = buildSingleRepoContext(input);

        expect(context.orchestrator.workerCount).toBe(0);
      });

      it('should set default agent to claude-code', () => {
        const input: SingleRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/repo',
        };

        const context = buildSingleRepoContext(input);

        expect(context.defaults.agent).toBe('claude-code');
      });
    });

    describe('with optional fields', () => {
      it('should use provided baseImage', () => {
        const input: SingleRepoInput = {
          projectId: 'proj_123',
          projectName: 'Python App',
          primaryRepo: 'acme/python-app',
          baseImage: 'mcr.microsoft.com/devcontainers/python:3.11',
        };

        const context = buildSingleRepoContext(input);

        expect(context.devcontainer.baseImage).toBe('mcr.microsoft.com/devcontainers/python:3.11');
      });

      it('should use provided releaseStream (preview)', () => {
        const input: SingleRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/repo',
          releaseStream: 'preview',
        };

        const context = buildSingleRepoContext(input);

        expect(context.defaults.releaseStream).toBe('preview');
      });

      it('should use provided baseBranch', () => {
        const input: SingleRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/repo',
          baseBranch: 'develop',
        };

        const context = buildSingleRepoContext(input);

        expect(context.defaults.baseBranch).toBe('develop');
      });
    });

    describe('feature tag mapping', () => {
      it('should map stable releaseStream to :1 feature tag', () => {
        const input: SingleRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/repo',
          releaseStream: 'stable',
        };

        const context = buildSingleRepoContext(input);

        expect(context.devcontainer.featureTag).toBe(':1');
      });

      it('should map preview releaseStream to :preview feature tag', () => {
        const input: SingleRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/repo',
          releaseStream: 'preview',
        };

        const context = buildSingleRepoContext(input);

        expect(context.devcontainer.featureTag).toBe(':preview');
      });
    });

    describe('metadata generation', () => {
      beforeEach(() => {
        // Mock Date for consistent timestamp testing
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-02-24T10:30:00.000Z'));
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('should generate ISO 8601 timestamp', () => {
        const input: SingleRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/repo',
        };

        const context = buildSingleRepoContext(input);

        expect(context.metadata.timestamp).toBe('2026-02-24T10:30:00.000Z');
      });

      it('should set version to 1.0.0', () => {
        const input: SingleRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/repo',
        };

        const context = buildSingleRepoContext(input);

        expect(context.metadata.version).toBe('1.0.0');
      });

      it('should default generatedBy to generacy-cli', () => {
        const input: SingleRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/repo',
        };

        const context = buildSingleRepoContext(input);

        expect(context.metadata.generatedBy).toBe('generacy-cli');
      });
    });

    describe('input validation', () => {
      it('should reject input with empty projectId', () => {
        const input = {
          projectId: '',
          projectName: 'Test',
          primaryRepo: 'acme/repo',
        };

        expect(() => buildSingleRepoContext(input as SingleRepoInput)).toThrow();
      });

      it('should reject input with empty projectName', () => {
        const input = {
          projectId: 'proj_123',
          projectName: '',
          primaryRepo: 'acme/repo',
        };

        expect(() => buildSingleRepoContext(input as SingleRepoInput)).toThrow();
      });

      it('should reject input with invalid repo format (missing slash)', () => {
        const input = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'invalid-repo',
        };

        expect(() => buildSingleRepoContext(input as SingleRepoInput)).toThrow();
      });

      it('should reject input with invalid repo format (multiple slashes)', () => {
        const input = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'owner/sub/repo',
        };

        expect(() => buildSingleRepoContext(input as SingleRepoInput)).toThrow();
      });

      it('should accept valid repo formats with special characters', () => {
        const validRepos = [
          'org-name/repo-name',
          'org.name/repo.name',
          'org_name/repo_name',
        ];

        for (const repo of validRepos) {
          const input: SingleRepoInput = {
            projectId: 'proj_123',
            projectName: 'Test',
            primaryRepo: repo,
          };

          expect(() => buildSingleRepoContext(input)).not.toThrow();
        }
      });
    });

    describe('built context validation', () => {
      it('should return validated context that passes schema validation', () => {
        const input: SingleRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/repo',
        };

        const context = buildSingleRepoContext(input);

        // If this doesn't throw, validation passed
        expect(context).toBeDefined();
        expect(context.project).toBeDefined();
        expect(context.repos).toBeDefined();
        expect(context.defaults).toBeDefined();
        expect(context.orchestrator).toBeDefined();
        expect(context.devcontainer).toBeDefined();
        expect(context.metadata).toBeDefined();
      });
    });
  });
});

describe('Multi-Repo Context Builder', () => {
  describe('buildMultiRepoContext', () => {
    describe('minimal options', () => {
      it('should build valid context with only required fields', () => {
        const input: MultiRepoInput = {
          projectId: 'proj_multi123',
          projectName: 'Multi Project',
          primaryRepo: 'acme/orchestrator',
          devRepos: ['acme/api', 'acme/frontend'],
        };

        const context = buildMultiRepoContext(input);

        expect(context).toBeDefined();
        expect(context.project.id).toBe('proj_multi123');
        expect(context.project.name).toBe('Multi Project');
        expect(context.repos.primary).toBe('acme/orchestrator');
        expect(context.repos.dev).toEqual(['acme/api', 'acme/frontend']);
      });

      it('should apply default baseImage when not provided', () => {
        const input: MultiRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/orch',
          devRepos: ['acme/api'],
        };

        const context = buildMultiRepoContext(input);

        expect(context.devcontainer.baseImage).toBe('mcr.microsoft.com/devcontainers/base:ubuntu');
      });

      it('should apply default releaseStream (stable) when not provided', () => {
        const input: MultiRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/orch',
          devRepos: ['acme/api'],
        };

        const context = buildMultiRepoContext(input);

        expect(context.defaults.releaseStream).toBe('stable');
      });

      it('should apply default baseBranch (main) when not provided', () => {
        const input: MultiRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/orch',
          devRepos: ['acme/api'],
        };

        const context = buildMultiRepoContext(input);

        expect(context.defaults.baseBranch).toBe('main');
      });

      it('should apply default workerCount (3) when not provided', () => {
        const input: MultiRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/orch',
          devRepos: ['acme/api'],
        };

        const context = buildMultiRepoContext(input);

        expect(context.orchestrator.workerCount).toBe(3);
      });

      it('should apply default pollIntervalMs (5000) when not provided', () => {
        const input: MultiRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/orch',
          devRepos: ['acme/api'],
        };

        const context = buildMultiRepoContext(input);

        expect(context.orchestrator.pollIntervalMs).toBe(5000);
      });

      it('should default cloneRepos to empty array when not provided', () => {
        const input: MultiRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/orch',
          devRepos: ['acme/api'],
        };

        const context = buildMultiRepoContext(input);

        expect(context.repos.clone).toEqual([]);
        expect(context.repos.hasCloneRepos).toBe(false);
      });

      it('should set isMultiRepo to true', () => {
        const input: MultiRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/orch',
          devRepos: ['acme/api'],
        };

        const context = buildMultiRepoContext(input);

        expect(context.repos.isMultiRepo).toBe(true);
      });

      it('should set hasDevRepos to true when devRepos provided', () => {
        const input: MultiRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/orch',
          devRepos: ['acme/api', 'acme/frontend'],
        };

        const context = buildMultiRepoContext(input);

        expect(context.repos.hasDevRepos).toBe(true);
      });
    });

    describe('with optional fields', () => {
      it('should use provided cloneRepos', () => {
        const input: MultiRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/orch',
          devRepos: ['acme/api'],
          cloneRepos: ['acme/shared-lib', 'acme/proto'],
        };

        const context = buildMultiRepoContext(input);

        expect(context.repos.clone).toEqual(['acme/shared-lib', 'acme/proto']);
        expect(context.repos.hasCloneRepos).toBe(true);
      });

      it('should use provided workerCount', () => {
        const input: MultiRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/orch',
          devRepos: ['acme/api'],
          workerCount: 5,
        };

        const context = buildMultiRepoContext(input);

        expect(context.orchestrator.workerCount).toBe(5);
      });

      it('should use provided pollIntervalMs', () => {
        const input: MultiRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/orch',
          devRepos: ['acme/api'],
          pollIntervalMs: 3000,
        };

        const context = buildMultiRepoContext(input);

        expect(context.orchestrator.pollIntervalMs).toBe(3000);
      });

      it('should use provided baseImage', () => {
        const input: MultiRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/orch',
          devRepos: ['acme/api'],
          baseImage: 'mcr.microsoft.com/devcontainers/javascript-node:20',
        };

        const context = buildMultiRepoContext(input);

        expect(context.devcontainer.baseImage).toBe('mcr.microsoft.com/devcontainers/javascript-node:20');
      });

      it('should use provided releaseStream', () => {
        const input: MultiRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/orch',
          devRepos: ['acme/api'],
          releaseStream: 'preview',
        };

        const context = buildMultiRepoContext(input);

        expect(context.defaults.releaseStream).toBe('preview');
        expect(context.devcontainer.featureTag).toBe(':preview');
      });

      it('should use provided baseBranch', () => {
        const input: MultiRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/orch',
          devRepos: ['acme/api'],
          baseBranch: 'develop',
        };

        const context = buildMultiRepoContext(input);

        expect(context.defaults.baseBranch).toBe('develop');
      });
    });

    describe('with all options', () => {
      it('should build context with all optional fields', () => {
        const input: MultiRepoInput = {
          projectId: 'proj_full',
          projectName: 'Full Platform',
          primaryRepo: 'acme/orchestrator',
          devRepos: ['acme/api', 'acme/frontend', 'acme/worker'],
          cloneRepos: ['acme/shared-lib', 'acme/proto'],
          baseImage: 'mcr.microsoft.com/devcontainers/typescript-node:20',
          releaseStream: 'preview',
          baseBranch: 'develop',
          workerCount: 5,
          pollIntervalMs: 2000,
        };

        const context = buildMultiRepoContext(input);

        expect(context.project.id).toBe('proj_full');
        expect(context.project.name).toBe('Full Platform');
        expect(context.repos.primary).toBe('acme/orchestrator');
        expect(context.repos.dev).toEqual(['acme/api', 'acme/frontend', 'acme/worker']);
        expect(context.repos.clone).toEqual(['acme/shared-lib', 'acme/proto']);
        expect(context.repos.hasDevRepos).toBe(true);
        expect(context.repos.hasCloneRepos).toBe(true);
        expect(context.repos.isMultiRepo).toBe(true);
        expect(context.devcontainer.baseImage).toBe('mcr.microsoft.com/devcontainers/typescript-node:20');
        expect(context.devcontainer.featureTag).toBe(':preview');
        expect(context.defaults.releaseStream).toBe('preview');
        expect(context.defaults.baseBranch).toBe('develop');
        expect(context.orchestrator.workerCount).toBe(5);
        expect(context.orchestrator.pollIntervalMs).toBe(2000);
      });
    });

    describe('input validation', () => {
      it('should reject input with empty devRepos array', () => {
        const input = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/orch',
          devRepos: [],
        };

        expect(() => buildMultiRepoContext(input as MultiRepoInput)).toThrow();
      });

      it('should reject input with invalid devRepo format', () => {
        const input = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/orch',
          devRepos: ['acme/valid', 'invalid-repo'],
        };

        expect(() => buildMultiRepoContext(input as MultiRepoInput)).toThrow();
      });

      it('should reject input with invalid cloneRepo format', () => {
        const input = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/orch',
          devRepos: ['acme/api'],
          cloneRepos: ['invalid'],
        };

        expect(() => buildMultiRepoContext(input as MultiRepoInput)).toThrow();
      });

      it('should reject input with zero workerCount', () => {
        const input = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/orch',
          devRepos: ['acme/api'],
          workerCount: 0,
        };

        expect(() => buildMultiRepoContext(input as MultiRepoInput)).toThrow();
      });

      it('should reject input with negative workerCount', () => {
        const input = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/orch',
          devRepos: ['acme/api'],
          workerCount: -1,
        };

        expect(() => buildMultiRepoContext(input as MultiRepoInput)).toThrow();
      });

      it('should reject input with zero pollIntervalMs', () => {
        const input = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/orch',
          devRepos: ['acme/api'],
          pollIntervalMs: 0,
        };

        expect(() => buildMultiRepoContext(input as MultiRepoInput)).toThrow();
      });

      it('should reject input with negative pollIntervalMs', () => {
        const input = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/orch',
          devRepos: ['acme/api'],
          pollIntervalMs: -5000,
        };

        expect(() => buildMultiRepoContext(input as MultiRepoInput)).toThrow();
      });
    });

    describe('metadata generation', () => {
      beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-02-24T14:00:00.000Z'));
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('should generate ISO 8601 timestamp', () => {
        const input: MultiRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/orch',
          devRepos: ['acme/api'],
        };

        const context = buildMultiRepoContext(input);

        expect(context.metadata.timestamp).toBe('2026-02-24T14:00:00.000Z');
      });

      it('should set version to 1.0.0', () => {
        const input: MultiRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/orch',
          devRepos: ['acme/api'],
        };

        const context = buildMultiRepoContext(input);

        expect(context.metadata.version).toBe('1.0.0');
      });

      it('should default generatedBy to generacy-cli', () => {
        const input: MultiRepoInput = {
          projectId: 'proj_123',
          projectName: 'Test',
          primaryRepo: 'acme/orch',
          devRepos: ['acme/api'],
        };

        const context = buildMultiRepoContext(input);

        expect(context.metadata.generatedBy).toBe('generacy-cli');
      });
    });
  });
});

describe('Context Modification Helpers', () => {
  describe('withGeneratedBy', () => {
    it('should override generatedBy to generacy-cloud', () => {
      const base: TemplateContext = buildSingleRepoContext({
        projectId: 'proj_123',
        projectName: 'Test',
        primaryRepo: 'acme/repo',
      });

      const modified = withGeneratedBy(base, 'generacy-cloud');

      expect(modified.metadata.generatedBy).toBe('generacy-cloud');
    });

    it('should override generatedBy to generacy-cli', () => {
      const base: TemplateContext = buildSingleRepoContext({
        projectId: 'proj_123',
        projectName: 'Test',
        primaryRepo: 'acme/repo',
      });
      // First set it to cloud
      const cloud = withGeneratedBy(base, 'generacy-cloud');

      // Then back to CLI
      const cli = withGeneratedBy(cloud, 'generacy-cli');

      expect(cli.metadata.generatedBy).toBe('generacy-cli');
    });

    it('should preserve all other context properties', () => {
      const base: TemplateContext = buildSingleRepoContext({
        projectId: 'proj_123',
        projectName: 'Test',
        primaryRepo: 'acme/repo',
      });

      const modified = withGeneratedBy(base, 'generacy-cloud');

      expect(modified.project).toEqual(base.project);
      expect(modified.repos).toEqual(base.repos);
      expect(modified.defaults).toEqual(base.defaults);
      expect(modified.orchestrator).toEqual(base.orchestrator);
      expect(modified.devcontainer).toEqual(base.devcontainer);
      expect(modified.metadata.timestamp).toBe(base.metadata.timestamp);
      expect(modified.metadata.version).toBe(base.metadata.version);
    });

    it('should not mutate original context', () => {
      const base: TemplateContext = buildSingleRepoContext({
        projectId: 'proj_123',
        projectName: 'Test',
        primaryRepo: 'acme/repo',
      });
      const originalGeneratedBy = base.metadata.generatedBy;

      withGeneratedBy(base, 'generacy-cloud');

      expect(base.metadata.generatedBy).toBe(originalGeneratedBy);
    });
  });

  describe('withBaseImage', () => {
    it('should override baseImage', () => {
      const base: TemplateContext = buildSingleRepoContext({
        projectId: 'proj_123',
        projectName: 'Python App',
        primaryRepo: 'acme/python-app',
      });

      const modified = withBaseImage(base, 'mcr.microsoft.com/devcontainers/python:3.11');

      expect(modified.devcontainer.baseImage).toBe('mcr.microsoft.com/devcontainers/python:3.11');
    });

    it('should preserve featureTag', () => {
      const base: TemplateContext = buildSingleRepoContext({
        projectId: 'proj_123',
        projectName: 'Test',
        primaryRepo: 'acme/repo',
        releaseStream: 'preview',
      });

      const modified = withBaseImage(base, 'mcr.microsoft.com/devcontainers/rust:1');

      expect(modified.devcontainer.featureTag).toBe(':preview');
    });

    it('should preserve all other context properties', () => {
      const base: TemplateContext = buildSingleRepoContext({
        projectId: 'proj_123',
        projectName: 'Test',
        primaryRepo: 'acme/repo',
      });

      const modified = withBaseImage(base, 'custom-image');

      expect(modified.project).toEqual(base.project);
      expect(modified.repos).toEqual(base.repos);
      expect(modified.defaults).toEqual(base.defaults);
      expect(modified.orchestrator).toEqual(base.orchestrator);
      expect(modified.metadata).toEqual(base.metadata);
    });

    it('should not mutate original context', () => {
      const base: TemplateContext = buildSingleRepoContext({
        projectId: 'proj_123',
        projectName: 'Test',
        primaryRepo: 'acme/repo',
      });
      const originalImage = base.devcontainer.baseImage;

      withBaseImage(base, 'new-image');

      expect(base.devcontainer.baseImage).toBe(originalImage);
    });
  });

  describe('withBaseBranch', () => {
    it('should override baseBranch', () => {
      const base: TemplateContext = buildSingleRepoContext({
        projectId: 'proj_123',
        projectName: 'Test',
        primaryRepo: 'acme/repo',
      });

      const modified = withBaseBranch(base, 'develop');

      expect(modified.defaults.baseBranch).toBe('develop');
    });

    it('should preserve other defaults properties', () => {
      const base: TemplateContext = buildSingleRepoContext({
        projectId: 'proj_123',
        projectName: 'Test',
        primaryRepo: 'acme/repo',
        releaseStream: 'preview',
      });

      const modified = withBaseBranch(base, 'custom-branch');

      expect(modified.defaults.agent).toBe(base.defaults.agent);
      expect(modified.defaults.releaseStream).toBe(base.defaults.releaseStream);
    });

    it('should preserve all other context properties', () => {
      const base: TemplateContext = buildSingleRepoContext({
        projectId: 'proj_123',
        projectName: 'Test',
        primaryRepo: 'acme/repo',
      });

      const modified = withBaseBranch(base, 'master');

      expect(modified.project).toEqual(base.project);
      expect(modified.repos).toEqual(base.repos);
      expect(modified.orchestrator).toEqual(base.orchestrator);
      expect(modified.devcontainer).toEqual(base.devcontainer);
      expect(modified.metadata).toEqual(base.metadata);
    });

    it('should not mutate original context', () => {
      const base: TemplateContext = buildSingleRepoContext({
        projectId: 'proj_123',
        projectName: 'Test',
        primaryRepo: 'acme/repo',
      });
      const originalBranch = base.defaults.baseBranch;

      withBaseBranch(base, 'new-branch');

      expect(base.defaults.baseBranch).toBe(originalBranch);
    });
  });

  describe('withOrchestrator', () => {
    it('should override workerCount only', () => {
      const base: TemplateContext = buildMultiRepoContext({
        projectId: 'proj_123',
        projectName: 'Test',
        primaryRepo: 'acme/orch',
        devRepos: ['acme/api'],
      });

      const modified = withOrchestrator(base, { workerCount: 7 });

      expect(modified.orchestrator.workerCount).toBe(7);
      expect(modified.orchestrator.pollIntervalMs).toBe(base.orchestrator.pollIntervalMs);
    });

    it('should override pollIntervalMs only', () => {
      const base: TemplateContext = buildMultiRepoContext({
        projectId: 'proj_123',
        projectName: 'Test',
        primaryRepo: 'acme/orch',
        devRepos: ['acme/api'],
      });

      const modified = withOrchestrator(base, { pollIntervalMs: 1000 });

      expect(modified.orchestrator.pollIntervalMs).toBe(1000);
      expect(modified.orchestrator.workerCount).toBe(base.orchestrator.workerCount);
    });

    it('should override both workerCount and pollIntervalMs', () => {
      const base: TemplateContext = buildMultiRepoContext({
        projectId: 'proj_123',
        projectName: 'Test',
        primaryRepo: 'acme/orch',
        devRepos: ['acme/api'],
      });

      const modified = withOrchestrator(base, {
        workerCount: 10,
        pollIntervalMs: 2500,
      });

      expect(modified.orchestrator.workerCount).toBe(10);
      expect(modified.orchestrator.pollIntervalMs).toBe(2500);
    });

    it('should work with single-repo context', () => {
      const base: TemplateContext = buildSingleRepoContext({
        projectId: 'proj_123',
        projectName: 'Test',
        primaryRepo: 'acme/repo',
      });

      const modified = withOrchestrator(base, { workerCount: 2 });

      expect(modified.orchestrator.workerCount).toBe(2);
    });

    it('should preserve all other context properties', () => {
      const base: TemplateContext = buildMultiRepoContext({
        projectId: 'proj_123',
        projectName: 'Test',
        primaryRepo: 'acme/orch',
        devRepos: ['acme/api'],
      });

      const modified = withOrchestrator(base, { workerCount: 5 });

      expect(modified.project).toEqual(base.project);
      expect(modified.repos).toEqual(base.repos);
      expect(modified.defaults).toEqual(base.defaults);
      expect(modified.devcontainer).toEqual(base.devcontainer);
      expect(modified.metadata).toEqual(base.metadata);
    });

    it('should not mutate original context', () => {
      const base: TemplateContext = buildMultiRepoContext({
        projectId: 'proj_123',
        projectName: 'Test',
        primaryRepo: 'acme/orch',
        devRepos: ['acme/api'],
      });
      const originalWorkerCount = base.orchestrator.workerCount;
      const originalPollInterval = base.orchestrator.pollIntervalMs;

      withOrchestrator(base, { workerCount: 999, pollIntervalMs: 999 });

      expect(base.orchestrator.workerCount).toBe(originalWorkerCount);
      expect(base.orchestrator.pollIntervalMs).toBe(originalPollInterval);
    });
  });
});

describe('Quick Builder Helpers', () => {
  describe('quickSingleRepo', () => {
    it('should create single-repo context with minimal arguments', () => {
      const context = quickSingleRepo('proj_quick', 'Quick App', 'acme/quick');

      expect(context.project.id).toBe('proj_quick');
      expect(context.project.name).toBe('Quick App');
      expect(context.repos.primary).toBe('acme/quick');
      expect(context.repos.isMultiRepo).toBe(false);
    });

    it('should apply all defaults', () => {
      const context = quickSingleRepo('proj_123', 'Test', 'acme/repo');

      expect(context.devcontainer.baseImage).toBe('mcr.microsoft.com/devcontainers/base:ubuntu');
      expect(context.defaults.releaseStream).toBe('stable');
      expect(context.defaults.baseBranch).toBe('main');
      expect(context.devcontainer.featureTag).toBe(':1');
      expect(context.orchestrator.workerCount).toBe(0);
    });

    it('should generate metadata', () => {
      const context = quickSingleRepo('proj_123', 'Test', 'acme/repo');

      expect(context.metadata.timestamp).toBeDefined();
      expect(context.metadata.version).toBe('1.0.0');
      expect(context.metadata.generatedBy).toBe('generacy-cli');
    });

    it('should return validated context', () => {
      const context = quickSingleRepo('proj_123', 'Test', 'acme/repo');

      expect(context).toBeDefined();
      expect(context.project).toBeDefined();
      expect(context.repos).toBeDefined();
    });
  });

  describe('quickMultiRepo', () => {
    it('should create multi-repo context with minimal arguments', () => {
      const context = quickMultiRepo(
        'proj_quick_multi',
        'Quick Platform',
        'acme/orch',
        ['acme/api', 'acme/frontend']
      );

      expect(context.project.id).toBe('proj_quick_multi');
      expect(context.project.name).toBe('Quick Platform');
      expect(context.repos.primary).toBe('acme/orch');
      expect(context.repos.dev).toEqual(['acme/api', 'acme/frontend']);
      expect(context.repos.isMultiRepo).toBe(true);
    });

    it('should apply all defaults', () => {
      const context = quickMultiRepo('proj_123', 'Test', 'acme/orch', ['acme/api']);

      expect(context.devcontainer.baseImage).toBe('mcr.microsoft.com/devcontainers/base:ubuntu');
      expect(context.defaults.releaseStream).toBe('stable');
      expect(context.defaults.baseBranch).toBe('main');
      expect(context.devcontainer.featureTag).toBe(':1');
      expect(context.orchestrator.workerCount).toBe(3);
      expect(context.orchestrator.pollIntervalMs).toBe(5000);
      expect(context.repos.clone).toEqual([]);
    });

    it('should generate metadata', () => {
      const context = quickMultiRepo('proj_123', 'Test', 'acme/orch', ['acme/api']);

      expect(context.metadata.timestamp).toBeDefined();
      expect(context.metadata.version).toBe('1.0.0');
      expect(context.metadata.generatedBy).toBe('generacy-cli');
    });

    it('should return validated context', () => {
      const context = quickMultiRepo('proj_123', 'Test', 'acme/orch', ['acme/api']);

      expect(context).toBeDefined();
      expect(context.project).toBeDefined();
      expect(context.repos).toBeDefined();
    });

    it('should handle multiple dev repos', () => {
      const devRepos = ['acme/api', 'acme/frontend', 'acme/worker', 'acme/scheduler'];
      const context = quickMultiRepo('proj_123', 'Test', 'acme/orch', devRepos);

      expect(context.repos.dev).toEqual(devRepos);
      expect(context.repos.hasDevRepos).toBe(true);
    });
  });
});

describe('Edge Cases and Integration', () => {
  describe('chaining modification helpers', () => {
    it('should allow chaining multiple modifiers', () => {
      const base = buildSingleRepoContext({
        projectId: 'proj_123',
        projectName: 'Test',
        primaryRepo: 'acme/repo',
      });

      const modified = withGeneratedBy(
        withBaseImage(
          withBaseBranch(base, 'develop'),
          'mcr.microsoft.com/devcontainers/python:3.11'
        ),
        'generacy-cloud'
      );

      expect(modified.defaults.baseBranch).toBe('develop');
      expect(modified.devcontainer.baseImage).toBe('mcr.microsoft.com/devcontainers/python:3.11');
      expect(modified.metadata.generatedBy).toBe('generacy-cloud');
    });

    it('should not mutate intermediate contexts when chaining', () => {
      const base = buildSingleRepoContext({
        projectId: 'proj_123',
        projectName: 'Test',
        primaryRepo: 'acme/repo',
      });

      const step1 = withBaseBranch(base, 'develop');
      const step2 = withBaseImage(step1, 'custom-image');
      const step3 = withGeneratedBy(step2, 'generacy-cloud');

      // Original should be unchanged
      expect(base.defaults.baseBranch).toBe('main');
      expect(base.devcontainer.baseImage).toBe('mcr.microsoft.com/devcontainers/base:ubuntu');
      expect(base.metadata.generatedBy).toBe('generacy-cli');

      // Step 1 should only have branch changed
      expect(step1.defaults.baseBranch).toBe('develop');
      expect(step1.devcontainer.baseImage).toBe('mcr.microsoft.com/devcontainers/base:ubuntu');
      expect(step1.metadata.generatedBy).toBe('generacy-cli');

      // Step 2 should have branch and image changed
      expect(step2.defaults.baseBranch).toBe('develop');
      expect(step2.devcontainer.baseImage).toBe('custom-image');
      expect(step2.metadata.generatedBy).toBe('generacy-cli');

      // Step 3 should have all changes
      expect(step3.defaults.baseBranch).toBe('develop');
      expect(step3.devcontainer.baseImage).toBe('custom-image');
      expect(step3.metadata.generatedBy).toBe('generacy-cloud');
    });
  });

  describe('real-world usage patterns', () => {
    it('should support CLI workflow', () => {
      // User runs: generacy init
      const context = buildSingleRepoContext({
        projectId: 'proj_cli_user',
        projectName: 'My App',
        primaryRepo: 'user/my-app',
        releaseStream: 'stable',
      });

      expect(context.metadata.generatedBy).toBe('generacy-cli');
      expect(context.devcontainer.featureTag).toBe(':1');
    });

    it('should support cloud service workflow', () => {
      // Cloud service creates project via web UI
      const context = withGeneratedBy(
        buildMultiRepoContext({
          projectId: 'proj_cloud_gen',
          projectName: 'Enterprise Platform',
          primaryRepo: 'enterprise/orchestrator',
          devRepos: ['enterprise/api', 'enterprise/frontend'],
          workerCount: 5,
          pollIntervalMs: 2000,
        }),
        'generacy-cloud'
      );

      expect(context.metadata.generatedBy).toBe('generacy-cloud');
      expect(context.orchestrator.workerCount).toBe(5);
    });

    it('should support language-specific customization', () => {
      // Start with default context
      const base = buildSingleRepoContext({
        projectId: 'proj_python',
        projectName: 'Python ML App',
        primaryRepo: 'ml-team/model-trainer',
      });

      // Customize for Python
      const pythonContext = withBaseImage(
        base,
        'mcr.microsoft.com/devcontainers/python:3.11'
      );

      expect(pythonContext.devcontainer.baseImage).toContain('python');
    });
  });

  describe('timestamp format', () => {
    it('should generate valid ISO 8601 timestamps', () => {
      const context = buildSingleRepoContext({
        projectId: 'proj_123',
        projectName: 'Test',
        primaryRepo: 'acme/repo',
      });

      // ISO 8601 format: YYYY-MM-DDTHH:mm:ss.sssZ
      const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
      expect(context.metadata.timestamp).toMatch(isoPattern);
    });

    it('should generate current timestamp', () => {
      const beforeBuild = new Date().toISOString();
      const context = buildSingleRepoContext({
        projectId: 'proj_123',
        projectName: 'Test',
        primaryRepo: 'acme/repo',
      });
      const afterBuild = new Date().toISOString();

      const timestamp = context.metadata.timestamp;
      expect(timestamp >= beforeBuild).toBe(true);
      expect(timestamp <= afterBuild).toBe(true);
    });
  });
});

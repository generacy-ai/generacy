/**
 * Fixture validation tests
 *
 * These tests verify that all fixture files are valid and can be loaded correctly.
 * This ensures fixtures stay in sync with schema changes.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { validateContext } from '../../src/validators.js';
import type { TemplateContext } from '../../src/schema.js';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Load a fixture file and parse as JSON
 */
function loadFixture<T = any>(filename: string): T {
  const path = join(__dirname, filename);
  const content = readFileSync(path, 'utf-8');
  return JSON.parse(content) as T;
}

// ============================================================================
// Valid Context Fixture Tests
// ============================================================================

describe('Valid Context Fixtures', () => {
  test('single-repo-context.json is valid', () => {
    const context = loadFixture<TemplateContext>('single-repo-context.json');

    expect(() => validateContext(context)).not.toThrow();

    const validated = validateContext(context);
    expect(validated.project.id).toBe('proj_abc123xyz');
    expect(validated.project.name).toBe('E-Commerce API');
    expect(validated.repos.isMultiRepo).toBe(false);
    expect(validated.repos.primary).toBe('acme-corp/ecommerce-api');
    expect(validated.devcontainer.featureTag).toBe(':1');
    expect(validated.metadata.generatedBy).toBe('generacy-cli');
  });

  test('multi-repo-context.json is valid', () => {
    const context = loadFixture<TemplateContext>('multi-repo-context.json');

    expect(() => validateContext(context)).not.toThrow();

    const validated = validateContext(context);
    expect(validated.project.id).toBe('proj_xyz789def');
    expect(validated.project.name).toBe('Acme Platform');
    expect(validated.repos.isMultiRepo).toBe(true);
    expect(validated.repos.dev).toHaveLength(3);
    expect(validated.repos.clone).toHaveLength(2);
    expect(validated.repos.hasDevRepos).toBe(true);
    expect(validated.repos.hasCloneRepos).toBe(true);
    expect(validated.orchestrator.workerCount).toBe(3);
    expect(validated.metadata.generatedBy).toBe('generacy-cloud');
  });

  test('minimal-single-repo-context.json is valid', () => {
    const context = loadFixture<TemplateContext>('minimal-single-repo-context.json');

    expect(() => validateContext(context)).not.toThrow();

    const validated = validateContext(context);
    expect(validated.project.id).toBe('proj_min123');
    expect(validated.repos.primary).toBe('user/simple-app');
    expect(validated.devcontainer.baseImage).toBe('mcr.microsoft.com/devcontainers/base:ubuntu');
    expect(validated.defaults.releaseStream).toBe('stable');
  });

  test('large-multi-repo-context.json is valid', () => {
    const context = loadFixture<TemplateContext>('large-multi-repo-context.json');

    expect(() => validateContext(context)).not.toThrow();

    const validated = validateContext(context);
    expect(validated.project.id).toBe('proj_large999');
    expect(validated.repos.dev).toHaveLength(10);
    expect(validated.repos.clone).toHaveLength(6);
    expect(validated.orchestrator.workerCount).toBe(8);
    expect(validated.devcontainer.featureTag).toBe(':preview');
    expect(validated.defaults.releaseStream).toBe('preview');
  });

  test('preview-release-context.json is valid', () => {
    const context = loadFixture<TemplateContext>('preview-release-context.json');

    expect(() => validateContext(context)).not.toThrow();

    const validated = validateContext(context);
    expect(validated.devcontainer.featureTag).toBe(':preview');
    expect(validated.defaults.releaseStream).toBe('preview');
    expect(validated.defaults.baseBranch).toBe('develop');
  });

  test('custom-base-image-context.json is valid', () => {
    const context = loadFixture<TemplateContext>('custom-base-image-context.json');

    expect(() => validateContext(context)).not.toThrow();

    const validated = validateContext(context);
    expect(validated.devcontainer.baseImage).toBe('mcr.microsoft.com/devcontainers/rust:1-bullseye');
    expect(validated.project.name).toBe('Rust Service');
  });
});

// ============================================================================
// Invalid Context Fixture Tests
// ============================================================================

describe('Invalid Context Fixtures', () => {
  const invalidContexts = loadFixture<Record<string, {
    description: string;
    context: any;
    expectedError: string;
  }>>('invalid-contexts.json');

  test('invalid-contexts.json has expected test cases', () => {
    expect(Object.keys(invalidContexts)).toContain('missingProjectId');
    expect(Object.keys(invalidContexts)).toContain('invalidRepoFormat');
    expect(Object.keys(invalidContexts)).toContain('invalidFeatureTag');
    expect(Object.keys(invalidContexts)).toContain('negativeWorkerCount');
    expect(Object.keys(invalidContexts)).toContain('invalidTimestamp');
    expect(Object.keys(invalidContexts)).toContain('invalidVersionFormat');
    expect(Object.keys(invalidContexts)).toContain('emptyProjectName');
    expect(Object.keys(invalidContexts)).toContain('invalidDevRepoFormat');
    expect(Object.keys(invalidContexts)).toContain('zeroPollInterval');
  });

  test('missingProjectId throws validation error', () => {
    const testCase = invalidContexts.missingProjectId;

    expect(() => validateContext(testCase.context))
      .toThrow();

    try {
      validateContext(testCase.context);
    } catch (error: any) {
      expect(error.message).toContain('project.id');
    }
  });

  test('invalidRepoFormat throws validation error', () => {
    const testCase = invalidContexts.invalidRepoFormat;

    expect(() => validateContext(testCase.context))
      .toThrow();

    try {
      validateContext(testCase.context);
    } catch (error: any) {
      expect(error.message.toLowerCase()).toContain('owner/repo');
    }
  });

  test('invalidFeatureTag throws validation error', () => {
    const testCase = invalidContexts.invalidFeatureTag;

    expect(() => validateContext(testCase.context))
      .toThrow();

    try {
      validateContext(testCase.context);
    } catch (error: any) {
      expect(error.message).toMatch(/:1|:preview/i);
    }
  });

  test('negativeWorkerCount throws validation error', () => {
    const testCase = invalidContexts.negativeWorkerCount;

    expect(() => validateContext(testCase.context))
      .toThrow();

    try {
      validateContext(testCase.context);
    } catch (error: any) {
      expect(error.message.toLowerCase()).toContain('greater than or equal to 0');
    }
  });

  test('invalidTimestamp throws validation error', () => {
    const testCase = invalidContexts.invalidTimestamp;

    expect(() => validateContext(testCase.context))
      .toThrow();

    try {
      validateContext(testCase.context);
    } catch (error: any) {
      expect(error.message.toLowerCase()).toContain('datetime');
    }
  });

  test('invalidVersionFormat throws validation error', () => {
    const testCase = invalidContexts.invalidVersionFormat;

    expect(() => validateContext(testCase.context))
      .toThrow();

    try {
      validateContext(testCase.context);
    } catch (error: any) {
      expect(error.message.toLowerCase()).toMatch(/version|semver/);
    }
  });

  test('emptyProjectName throws validation error', () => {
    const testCase = invalidContexts.emptyProjectName;

    expect(() => validateContext(testCase.context))
      .toThrow();

    try {
      validateContext(testCase.context);
    } catch (error: any) {
      expect(error.message).toContain('name');
    }
  });

  test('invalidDevRepoFormat throws validation error', () => {
    const testCase = invalidContexts.invalidDevRepoFormat;

    expect(() => validateContext(testCase.context))
      .toThrow();
  });

  test('zeroPollInterval throws validation error', () => {
    const testCase = invalidContexts.zeroPollInterval;

    expect(() => validateContext(testCase.context))
      .toThrow();

    try {
      validateContext(testCase.context);
    } catch (error: any) {
      expect(error.message.toLowerCase()).toContain('greater than 0');
    }
  });
});

// ============================================================================
// Extensions.json Fixture Tests
// ============================================================================

describe('Extensions.json Fixtures', () => {
  test('existing-extensions.json is valid JSON', () => {
    const extensions = loadFixture('existing-extensions.json');

    expect(extensions).toHaveProperty('recommendations');
    expect(Array.isArray(extensions.recommendations)).toBe(true);
    expect(extensions.recommendations).toContain('dbaeumer.vscode-eslint');
    expect(extensions.recommendations).toContain('esbenp.prettier-vscode');
    expect(extensions).toHaveProperty('unwantedRecommendations');
  });

  test('existing-extensions-with-generacy.json has one Generacy extension', () => {
    const extensions = loadFixture('existing-extensions-with-generacy.json');

    expect(extensions.recommendations).toContain('generacy-ai.agency');
    expect(extensions.recommendations).not.toContain('generacy-ai.generacy');
  });

  test('empty-extensions.json has empty recommendations array', () => {
    const extensions = loadFixture('empty-extensions.json');

    expect(extensions.recommendations).toEqual([]);
  });
});

// ============================================================================
// Fixture Completeness Tests
// ============================================================================

describe('Fixture Completeness', () => {
  test('all required fixture files exist', () => {
    // This test will fail if any fixture file is missing or can't be parsed
    expect(() => loadFixture('single-repo-context.json')).not.toThrow();
    expect(() => loadFixture('multi-repo-context.json')).not.toThrow();
    expect(() => loadFixture('minimal-single-repo-context.json')).not.toThrow();
    expect(() => loadFixture('large-multi-repo-context.json')).not.toThrow();
    expect(() => loadFixture('preview-release-context.json')).not.toThrow();
    expect(() => loadFixture('custom-base-image-context.json')).not.toThrow();
    expect(() => loadFixture('invalid-contexts.json')).not.toThrow();
    expect(() => loadFixture('existing-extensions.json')).not.toThrow();
    expect(() => loadFixture('existing-extensions-with-generacy.json')).not.toThrow();
    expect(() => loadFixture('empty-extensions.json')).not.toThrow();
  });

  test('fixture coverage includes edge cases', () => {
    // Verify we have fixtures for important edge cases
    const minimal = loadFixture<TemplateContext>('minimal-single-repo-context.json');
    const large = loadFixture<TemplateContext>('large-multi-repo-context.json');

    // Minimal: absolute minimum configuration
    expect(minimal.repos.dev).toHaveLength(0);
    expect(minimal.repos.clone).toHaveLength(0);
    expect(minimal.devcontainer.baseImage).toBe('mcr.microsoft.com/devcontainers/base:ubuntu');

    // Large: many repos
    expect(large.repos.dev.length).toBeGreaterThan(5);
    expect(large.repos.clone.length).toBeGreaterThan(3);
    expect(large.orchestrator.workerCount).toBeGreaterThan(5);
  });

  test('fixtures cover both release streams', () => {
    const stable = loadFixture<TemplateContext>('single-repo-context.json');
    const preview = loadFixture<TemplateContext>('preview-release-context.json');

    expect(stable.defaults.releaseStream).toBe('stable');
    expect(stable.devcontainer.featureTag).toBe(':1');

    expect(preview.defaults.releaseStream).toBe('preview');
    expect(preview.devcontainer.featureTag).toBe(':preview');
  });

  test('fixtures cover both generatedBy values', () => {
    const cli = loadFixture<TemplateContext>('single-repo-context.json');
    const cloud = loadFixture<TemplateContext>('multi-repo-context.json');

    expect(cli.metadata.generatedBy).toBe('generacy-cli');
    expect(cloud.metadata.generatedBy).toBe('generacy-cloud');
  });

  test('fixtures cover different base branches', () => {
    const main = loadFixture<TemplateContext>('single-repo-context.json');
    const develop = loadFixture<TemplateContext>('multi-repo-context.json');

    expect(main.defaults.baseBranch).toBe('main');
    expect(develop.defaults.baseBranch).toBe('develop');
  });
});

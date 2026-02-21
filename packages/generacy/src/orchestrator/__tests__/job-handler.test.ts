import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { JobHandler } from '../job-handler.js';
import type { OrchestratorClient } from '../client.js';

/**
 * Mock the workflow-engine module so we can control the registry
 * without side-effects from the real module (file validation, etc.).
 */
vi.mock('@generacy-ai/workflow-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@generacy-ai/workflow-engine')>();
  return {
    ...actual,
    // Stub registerWorkflow to avoid file-existence checks during construction
    registerWorkflow: vi.fn(),
    // resolveRegisteredWorkflow will be controlled per-test via mockReturnValue
    resolveRegisteredWorkflow: vi.fn().mockReturnValue(undefined),
  };
});

import {
  resolveRegisteredWorkflow,
  clearWorkflowRegistry,
} from '@generacy-ai/workflow-engine';

const mockedResolveRegisteredWorkflow = vi.mocked(resolveRegisteredWorkflow);

/**
 * Create a temporary directory tree for testing filesystem resolution.
 * Returns paths and a cleanup function.
 */
function createTempFixture(): {
  root: string;
  generacyDir: string;
  cleanup: () => void;
} {
  const root = resolve(
    tmpdir(),
    `job-handler-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  const generacyDir = join(root, '.generacy');
  mkdirSync(generacyDir, { recursive: true });

  return {
    root,
    generacyDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Write a minimal YAML file at the given path.
 */
function writeWorkflowFile(filePath: string): void {
  mkdirSync(resolve(filePath, '..'), { recursive: true });
  writeFileSync(filePath, 'name: test\nphases: []\n');
}

/**
 * Create a minimal JobHandler for testing.
 * Only the `workdir` and the private `resolveWorkflowPath` method are exercised.
 */
function createHandler(workdir: string): JobHandler {
  const mockClient = {
    pollForJob: vi.fn(),
    updateJobStatus: vi.fn(),
    reportJobResult: vi.fn(),
  } as unknown as OrchestratorClient;

  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  return new JobHandler({
    client: mockClient,
    workerId: 'test-worker',
    logger: mockLogger,
    workdir,
  });
}

/**
 * Access the private resolveWorkflowPath method for testing.
 */
function callResolveWorkflowPath(
  handler: JobHandler,
  workflow: string,
  jobWorkdir?: string,
  excludePath?: string
): string {
  return (handler as any).resolveWorkflowPath(workflow, jobWorkdir, excludePath);
}

describe('resolveWorkflowPath()', () => {
  let fixture: ReturnType<typeof createTempFixture>;
  let handler: JobHandler;

  beforeEach(() => {
    fixture = createTempFixture();
    handler = createHandler(fixture.root);
    mockedResolveRegisteredWorkflow.mockReturnValue(undefined);
  });

  afterEach(() => {
    fixture.cleanup();
    vi.restoreAllMocks();
  });

  describe('absolute path resolution', () => {
    it('returns absolute path when it exists on disk', () => {
      const absPath = join(fixture.root, 'my-workflow.yaml');
      writeWorkflowFile(absPath);

      const result = callResolveWorkflowPath(handler, absPath);
      expect(result).toBe(absPath);
    });

    it('does not return absolute path when it does not exist', () => {
      const absPath = join(fixture.root, 'nonexistent.yaml');

      const result = callResolveWorkflowPath(handler, absPath);
      // Falls through to other tiers; since nothing matches, returns raw string
      expect(result).toBe(absPath);
    });
  });

  describe('relative to workdir resolution', () => {
    it('resolves workflow relative to the default workdir', () => {
      const relFile = join(fixture.root, 'my-workflow.yaml');
      writeWorkflowFile(relFile);

      const result = callResolveWorkflowPath(handler, 'my-workflow.yaml');
      expect(result).toBe(resolve(fixture.root, 'my-workflow.yaml'));
    });

    it('resolves workflow relative to jobWorkdir when provided', () => {
      const jobDir = join(fixture.root, 'job-specific');
      mkdirSync(jobDir, { recursive: true });
      const relFile = join(jobDir, 'custom.yaml');
      writeWorkflowFile(relFile);

      const result = callResolveWorkflowPath(handler, 'custom.yaml', jobDir);
      expect(result).toBe(resolve(jobDir, 'custom.yaml'));
    });
  });

  describe('.generacy/ directory resolution', () => {
    it('resolves workflow from .generacy/ subdirectory', () => {
      writeWorkflowFile(join(fixture.generacyDir, 'my-workflow.yaml'));

      const result = callResolveWorkflowPath(handler, 'my-workflow');
      expect(result).toBe(resolve(fixture.generacyDir, 'my-workflow.yaml'));
    });

    it('resolves .yml extension from .generacy/ subdirectory', () => {
      writeWorkflowFile(join(fixture.generacyDir, 'alt.yml'));

      const result = callResolveWorkflowPath(handler, 'alt');
      expect(result).toBe(resolve(fixture.generacyDir, 'alt.yml'));
    });

    it('resolves exact name (no extension) from .generacy/', () => {
      writeWorkflowFile(join(fixture.generacyDir, 'no-ext'));

      const result = callResolveWorkflowPath(handler, 'no-ext');
      expect(result).toBe(resolve(fixture.generacyDir, 'no-ext'));
    });

    it('prefers .yaml over .yml when both exist', () => {
      writeWorkflowFile(join(fixture.generacyDir, 'both.yaml'));
      writeWorkflowFile(join(fixture.generacyDir, 'both.yml'));

      const result = callResolveWorkflowPath(handler, 'both');
      // .yaml is tried before .yml (order: '', '.yaml', '.yml')
      expect(result).toBe(resolve(fixture.generacyDir, 'both.yaml'));
    });
  });

  describe('priority: .generacy/ takes priority over registry', () => {
    it('returns .generacy/ path even when registry has a match', () => {
      // Set up .generacy/ file
      writeWorkflowFile(join(fixture.generacyDir, 'shared-workflow.yaml'));

      // Set up registry to return a different path
      const registryPath = '/some/plugin/shared-workflow.yaml';
      mockedResolveRegisteredWorkflow.mockReturnValue(registryPath);

      const result = callResolveWorkflowPath(handler, 'shared-workflow');
      expect(result).toBe(resolve(fixture.generacyDir, 'shared-workflow.yaml'));
      // Registry should not even be consulted if .generacy/ matches
    });
  });

  describe('registry resolution', () => {
    it('returns registry path when no local file matches', () => {
      const registryPath = '/plugins/agency-spec-kit/workflows/speckit-feature.yaml';
      mockedResolveRegisteredWorkflow.mockReturnValue(registryPath);

      const result = callResolveWorkflowPath(handler, 'speckit-feature');
      expect(result).toBe(registryPath);
    });

    it('calls resolveRegisteredWorkflow with the workflow name', () => {
      callResolveWorkflowPath(handler, 'my-plugin-workflow');
      expect(mockedResolveRegisteredWorkflow).toHaveBeenCalledWith('my-plugin-workflow');
    });
  });

  describe('registry is the final search tier', () => {
    it('returns registry path when no local file matches', () => {
      // Don't create any local files — force fallthrough past .generacy/
      const registryPath = '/plugins/my-plugin/workflow.yaml';
      mockedResolveRegisteredWorkflow.mockReturnValue(registryPath);

      const result = callResolveWorkflowPath(handler, 'some-workflow');
      expect(result).toBe(registryPath);
    });
  });

  describe('excludePath parameter', () => {
    it('skips absolute path when it matches excludePath and falls through to registry', () => {
      const absPath = join(fixture.root, 'excluded.yaml');
      writeWorkflowFile(absPath);

      // Set up a registry fallback so we can verify it falls through
      const registryPath = '/plugins/fallback/excluded.yaml';
      mockedResolveRegisteredWorkflow.mockReturnValue(registryPath);

      const result = callResolveWorkflowPath(
        handler,
        absPath,
        undefined,
        resolve(absPath)
      );
      // Should skip the absolute path and relative-to-workdir (same file),
      // then fall through to registry
      expect(result).toBe(registryPath);
    });

    it('skips .generacy/ match when it matches excludePath', () => {
      const generacyFile = join(fixture.generacyDir, 'skip-me.yaml');
      writeWorkflowFile(generacyFile);

      // Also set up registry as fallback
      const registryPath = '/plugins/fallback/skip-me.yaml';
      mockedResolveRegisteredWorkflow.mockReturnValue(registryPath);

      const result = callResolveWorkflowPath(
        handler,
        'skip-me',
        undefined,
        resolve(generacyFile)
      );
      // Should skip .generacy/ and fall through to registry
      expect(result).toBe(registryPath);
    });

    it('skips registry match when it matches excludePath', () => {
      const registryPath = '/plugins/my-plugin/workflow.yaml';
      mockedResolveRegisteredWorkflow.mockReturnValue(registryPath);

      const result = callResolveWorkflowPath(
        handler,
        'workflow',
        undefined,
        registryPath
      );
      // Should skip registry and fall through to fallback or raw string
      expect(result).not.toBe(registryPath);
    });

    it('skips relative-to-workdir match when it matches excludePath', () => {
      const relFile = join(fixture.root, 'rel-workflow.yaml');
      writeWorkflowFile(relFile);

      const result = callResolveWorkflowPath(
        handler,
        'rel-workflow.yaml',
        undefined,
        resolve(relFile)
      );
      // Should not return the relative match
      expect(result).not.toBe(resolve(relFile));
    });
  });

  describe('unresolved workflow returns raw string', () => {
    it('returns the original workflow string when nothing matches', () => {
      // No files exist, registry returns undefined
      const result = callResolveWorkflowPath(handler, 'nonexistent-workflow');
      expect(result).toBe('nonexistent-workflow');
    });

    it('preserves the exact input string for downstream error handling', () => {
      const name = 'my-custom/deep/workflow-name';
      const result = callResolveWorkflowPath(handler, name);
      expect(result).toBe(name);
    });
  });

  describe('extension inference (.yaml, .yml)', () => {
    it('appends .yaml when bare name matches .yaml in .generacy/', () => {
      writeWorkflowFile(join(fixture.generacyDir, 'infer.yaml'));

      const result = callResolveWorkflowPath(handler, 'infer');
      expect(result).toBe(resolve(fixture.generacyDir, 'infer.yaml'));
    });

    it('appends .yml when bare name matches .yml in .generacy/', () => {
      writeWorkflowFile(join(fixture.generacyDir, 'infer.yml'));

      const result = callResolveWorkflowPath(handler, 'infer');
      expect(result).toBe(resolve(fixture.generacyDir, 'infer.yml'));
    });

    it('does not double-append extension if already provided', () => {
      writeWorkflowFile(join(fixture.generacyDir, 'explicit.yaml'));

      // Pass the full name with extension — it resolves as '' + '' first
      const result = callResolveWorkflowPath(handler, 'explicit.yaml');
      expect(result).toBe(resolve(fixture.generacyDir, 'explicit.yaml'));
    });
  });

  describe('jobWorkdir overrides default workdir', () => {
    it('searches jobWorkdir .generacy/ instead of default workdir', () => {
      const jobDir = join(fixture.root, 'repo-checkout');
      const jobGeneracy = join(jobDir, '.generacy');
      mkdirSync(jobGeneracy, { recursive: true });
      writeWorkflowFile(join(jobGeneracy, 'repo-workflow.yaml'));

      const result = callResolveWorkflowPath(handler, 'repo-workflow', jobDir);
      expect(result).toBe(resolve(jobGeneracy, 'repo-workflow.yaml'));
    });

    it('does not search default workdir when jobWorkdir is specified', () => {
      // Put a file in default workdir's .generacy/
      writeWorkflowFile(join(fixture.generacyDir, 'only-in-default.yaml'));

      // Use a different jobWorkdir that doesn't have this file
      const jobDir = join(fixture.root, 'other-repo');
      mkdirSync(jobDir, { recursive: true });

      const result = callResolveWorkflowPath(handler, 'only-in-default', jobDir);
      // Should not find it in jobWorkdir, falls through to registry/fallback
      expect(result).not.toBe(resolve(fixture.generacyDir, 'only-in-default.yaml'));
    });
  });
});

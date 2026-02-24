/**
 * Tests for deterministic speckit operations (library calls)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import * as fs from '../../../src/actions/builtin/speckit/lib/fs.js';

// Mock fs module
vi.mock('../../../src/actions/builtin/speckit/lib/fs.js', async () => {
  const actual = await vi.importActual('../../../src/actions/builtin/speckit/lib/fs.js');
  return {
    ...actual,
    exists: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    readDir: vi.fn(),
    copyFile: vi.fn(),
    findRepoRoot: vi.fn(),
    resolveSpecsPath: vi.fn(),
    resolveTemplatesPath: vi.fn(),
    getFilesConfig: vi.fn(),
    isFile: vi.fn(),
    isDirectory: vi.fn(),
  };
});

// Shared mock git instance so tests can control behavior
const mockGit: Record<string, ReturnType<typeof vi.fn>> = {
  branchLocal: vi.fn(),
  checkoutLocalBranch: vi.fn(),
  checkout: vi.fn(),
  status: vi.fn(),
  fetch: vi.fn(),
  branch: vi.fn(),
  pull: vi.fn(),
  reset: vi.fn(),
  revparse: vi.fn(),
  raw: vi.fn(),
  listRemote: vi.fn(),
};

// Mock simple-git to always return the shared instance
vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => mockGit),
}));

describe('Deterministic Operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Configure shared git mock defaults
    mockGit.branchLocal.mockResolvedValue({ all: [], current: 'main' });
    mockGit.checkoutLocalBranch.mockResolvedValue(undefined);
    mockGit.checkout.mockResolvedValue(undefined);
    mockGit.status.mockResolvedValue({ current: '001-test-feature' });
    mockGit.fetch.mockResolvedValue(undefined);
    mockGit.branch.mockResolvedValue({ all: [] });
    mockGit.pull.mockResolvedValue(undefined);
    mockGit.reset.mockResolvedValue(undefined);
    mockGit.listRemote.mockResolvedValue('ref: refs/heads/main\tHEAD');
    mockGit.raw.mockResolvedValue('refs/remotes/origin/main');
    // Smart revparse: return branch name for --abbrev-ref, commit hash otherwise
    mockGit.revparse.mockImplementation(async (args: string[]) => {
      if (Array.isArray(args) && args.includes('--abbrev-ref')) {
        // Return the branch that was last checked out via checkoutLocalBranch
        const calls = mockGit.checkoutLocalBranch.mock.calls;
        if (calls.length > 0) {
          return calls[calls.length - 1][0];
        }
        return 'main';
      }
      return 'abc123';
    });

    // Default fs mock implementations
    vi.mocked(fs.exists).mockResolvedValue(false);
    vi.mocked(fs.findRepoRoot).mockResolvedValue('/repo');
    vi.mocked(fs.resolveSpecsPath).mockResolvedValue('/repo/specs');
    vi.mocked(fs.resolveTemplatesPath).mockResolvedValue('/repo/.specify/templates');
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.readDir).mockResolvedValue([]);
    vi.mocked(fs.getFilesConfig).mockResolvedValue({
      spec: 'spec.md',
      plan: 'plan.md',
      tasks: 'tasks.md',
      clarifications: 'clarifications.md',
      research: 'research.md',
      dataModel: 'data-model.md',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createFeature', () => {
    it('should create feature directory and spec file', async () => {
      const { createFeature } = await import('../../../src/actions/builtin/speckit/lib/feature.js');

      vi.mocked(fs.exists).mockImplementation(async (path: string) => {
        if (path === '/repo/.git') return true;
        return false;
      });

      const result = await createFeature({
        description: 'Test feature for user authentication',
        cwd: '/repo',
      });

      expect(result.success).toBe(true);
      expect(result.branch_name).toMatch(/^\d+-/);
      expect(result.feature_dir).toContain('/repo/specs/');
      expect(fs.mkdir).toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it('should use explicit feature number if provided', async () => {
      const { createFeature } = await import('../../../src/actions/builtin/speckit/lib/feature.js');

      vi.mocked(fs.exists).mockImplementation(async (path: string) => {
        if (path === '/repo/.git') return true;
        return false;
      });

      const result = await createFeature({
        description: 'Test feature',
        number: 42,
        cwd: '/repo',
      });

      expect(result.success).toBe(true);
      expect(result.feature_num).toBe('042');
      expect(result.branch_name).toMatch(/^042-/);
    });

    it('should use short_name if provided', async () => {
      const { createFeature } = await import('../../../src/actions/builtin/speckit/lib/feature.js');

      vi.mocked(fs.exists).mockImplementation(async (path: string) => {
        if (path === '/repo/.git') return true;
        return false;
      });

      const result = await createFeature({
        description: 'Test feature',
        number: 1,
        short_name: 'my-feature',
        cwd: '/repo',
      });

      expect(result.success).toBe(true);
      expect(result.branch_name).toBe('001-my-feature');
    });
  });

  describe('getPaths', () => {
    it('should return all feature paths', async () => {
      const { getPaths } = await import('../../../src/actions/builtin/speckit/lib/paths.js');

      vi.mocked(fs.exists).mockImplementation(async (path: string) => {
        if (path === '/repo/.git') return true;
        if (path === '/repo/specs/001-test-feature') return true;
        return false;
      });

      const result = await getPaths({
        branch: '001-test-feature',
        cwd: '/repo',
      });

      expect(result.success).toBe(true);
      expect(result.featureDir).toBe('/repo/specs/001-test-feature');
      expect(result.specFile).toBe('/repo/specs/001-test-feature/spec.md');
      expect(result.planFile).toBe('/repo/specs/001-test-feature/plan.md');
      expect(result.tasksFile).toBe('/repo/specs/001-test-feature/tasks.md');
    });

    it('should fail for invalid branch name', async () => {
      const { getPaths } = await import('../../../src/actions/builtin/speckit/lib/paths.js');

      const result = await getPaths({
        branch: 'invalid-branch',
        cwd: '/repo',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('checkPrereqs', () => {
    it('should pass when all required files exist', async () => {
      const { checkPrereqs } = await import('../../../src/actions/builtin/speckit/lib/prereqs.js');

      vi.mocked(fs.exists).mockImplementation(async (path: string) => {
        if (path === '/repo/.git') return true;
        if (path === '/repo/specs/001-test-feature') return true;
        return false;
      });
      vi.mocked(fs.isFile).mockImplementation(async (path: string) => {
        if (path.endsWith('spec.md')) return true;
        return false;
      });
      vi.mocked(fs.isDirectory).mockResolvedValue(false);

      const result = await checkPrereqs({
        branch: '001-test-feature',
        require_spec: true,
        require_plan: false,
        cwd: '/repo',
      });

      expect(result.valid).toBe(true);
      expect(result.featureDir).toBe('/repo/specs/001-test-feature');
    });

    it('should fail when required spec is missing', async () => {
      const { checkPrereqs } = await import('../../../src/actions/builtin/speckit/lib/prereqs.js');

      vi.mocked(fs.exists).mockImplementation(async (path: string) => {
        if (path === '/repo/.git') return true;
        if (path === '/repo/specs/001-test-feature') return true;
        return false;
      });
      vi.mocked(fs.isFile).mockResolvedValue(false);
      vi.mocked(fs.isDirectory).mockResolvedValue(false);

      const result = await checkPrereqs({
        branch: '001-test-feature',
        require_spec: true,
        cwd: '/repo',
      });

      expect(result.valid).toBe(false);
      expect(result.missingRequired).toContain('spec.md');
    });

    it('should list available optional docs', async () => {
      const { checkPrereqs } = await import('../../../src/actions/builtin/speckit/lib/prereqs.js');

      vi.mocked(fs.exists).mockImplementation(async (path: string) => {
        if (path === '/repo/.git') return true;
        if (path === '/repo/specs/001-test-feature') return true;
        return false;
      });
      vi.mocked(fs.isFile).mockImplementation(async (path: string) => {
        if (path.endsWith('spec.md')) return true;
        if (path.endsWith('research.md')) return true;
        return false;
      });
      vi.mocked(fs.isDirectory).mockResolvedValue(false);

      const result = await checkPrereqs({
        branch: '001-test-feature',
        require_spec: true,
        cwd: '/repo',
      });

      expect(result.valid).toBe(true);
      expect(result.availableDocs).toContain('research.md');
    });
  });

  describe('copyTemplates', () => {
    it('should copy template to feature directory', async () => {
      const { copyTemplates } = await import('../../../src/actions/builtin/speckit/lib/templates.js');

      vi.mocked(fs.exists).mockImplementation(async (path: string) => {
        if (path.includes('spec-template.md')) return true;
        return false;
      });
      vi.mocked(fs.copyFile).mockResolvedValue(undefined);

      const result = await copyTemplates({
        templates: ['spec'],
        feature_dir: '/repo/specs/001-test-feature',
        cwd: '/repo',
      });

      expect(result.success).toBe(true);
      expect(result.copied).toHaveLength(1);
      expect(result.copied[0].template).toBe('spec');
      expect(fs.copyFile).toHaveBeenCalled();
    });

    it('should report error for missing template', async () => {
      const { copyTemplates } = await import('../../../src/actions/builtin/speckit/lib/templates.js');

      vi.mocked(fs.exists).mockResolvedValue(false);

      const result = await copyTemplates({
        templates: ['spec'],
        feature_dir: '/repo/specs/001-test-feature',
        cwd: '/repo',
      });

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors?.[0].error.code).toBe('TEMPLATE_NOT_FOUND');
    });

    it('should reject invalid template names', async () => {
      const { copyTemplates } = await import('../../../src/actions/builtin/speckit/lib/templates.js');

      const result = await copyTemplates({
        templates: ['invalid' as any],
        feature_dir: '/repo/specs/001-test-feature',
        cwd: '/repo',
      });

      expect(result.success).toBe(false);
      expect(result.errors?.[0].error.code).toBe('TEMPLATE_NOT_FOUND');
    });

    it('should fail when feature_dir is missing', async () => {
      const { copyTemplates } = await import('../../../src/actions/builtin/speckit/lib/templates.js');

      const result = await copyTemplates({
        templates: ['spec'],
        cwd: '/repo',
      });

      expect(result.success).toBe(false);
      expect(result.errors?.[0].error.code).toBe('FEATURE_DIR_NOT_FOUND');
    });
  });
});

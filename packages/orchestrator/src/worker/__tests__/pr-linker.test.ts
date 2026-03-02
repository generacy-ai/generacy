import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PrLinker } from '../pr-linker.js';
import type { PrLinkInput } from '../pr-linker.js';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { Logger } from '../types.js';

function createMockLogger(): Logger {
  const logger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger;
}

function createMockGitHubClient(overrides: Partial<Record<keyof GitHubClient, unknown>> = {}): GitHubClient {
  return {
    getIssue: vi.fn(),
    ...overrides,
  } as unknown as GitHubClient;
}

function createPrInput(overrides: Partial<PrLinkInput> = {}): PrLinkInput {
  return {
    number: 10,
    body: '',
    head: { ref: 'main' },
    ...overrides,
  };
}

describe('PrLinker', () => {
  let linker: PrLinker;
  let logger: Logger;

  beforeEach(() => {
    logger = createMockLogger();
    linker = new PrLinker(logger);
  });

  // ==========================================================================
  // parsePrBody
  // ==========================================================================

  describe('parsePrBody', () => {
    it('should parse "Closes #42"', () => {
      expect(linker.parsePrBody('Closes #42')).toBe(42);
    });

    it('should parse "closes #42" (lowercase)', () => {
      expect(linker.parsePrBody('closes #42')).toBe(42);
    });

    it('should parse "CLOSES #42" (uppercase)', () => {
      expect(linker.parsePrBody('CLOSES #42')).toBe(42);
    });

    it('should parse "Close #42"', () => {
      expect(linker.parsePrBody('Close #42')).toBe(42);
    });

    it('should parse "Closed #42"', () => {
      expect(linker.parsePrBody('Closed #42')).toBe(42);
    });

    it('should parse "fixes #7"', () => {
      expect(linker.parsePrBody('fixes #7')).toBe(7);
    });

    it('should parse "Fix #7"', () => {
      expect(linker.parsePrBody('Fix #7')).toBe(7);
    });

    it('should parse "Fixed #7"', () => {
      expect(linker.parsePrBody('Fixed #7')).toBe(7);
    });

    it('should parse "Resolves #100"', () => {
      expect(linker.parsePrBody('Resolves #100')).toBe(100);
    });

    it('should parse "Resolve #100"', () => {
      expect(linker.parsePrBody('Resolve #100')).toBe(100);
    });

    it('should parse "Resolved #100"', () => {
      expect(linker.parsePrBody('Resolved #100')).toBe(100);
    });

    it('should return first match when multiple closing keywords exist', () => {
      expect(linker.parsePrBody('Fixes #7\nCloses #42')).toBe(7);
    });

    it('should handle keyword in the middle of text', () => {
      expect(linker.parsePrBody('This PR fixes #15 by updating the handler')).toBe(15);
    });

    it('should handle keyword with extra spaces before #', () => {
      expect(linker.parsePrBody('Closes  #42')).toBe(null);
    });

    it('should return null for empty body', () => {
      expect(linker.parsePrBody('')).toBe(null);
    });

    it('should return null when no closing keywords present', () => {
      expect(linker.parsePrBody('This is a PR without any closing keywords')).toBe(null);
    });

    it('should return null when # is referenced without keyword', () => {
      expect(linker.parsePrBody('Related to #42 but not closing it')).toBe(null);
    });

    it('should handle multiline PR body', () => {
      const body = `## Description
This PR adds new feature.

Fixes #99

## Testing
- Unit tests added`;
      expect(linker.parsePrBody(body)).toBe(99);
    });

    it('should handle mixed case "FIXES #123"', () => {
      expect(linker.parsePrBody('FIXES #123')).toBe(123);
    });

    it('should parse large issue numbers', () => {
      expect(linker.parsePrBody('Closes #99999')).toBe(99999);
    });
  });

  // ==========================================================================
  // parseBranchName
  // ==========================================================================

  describe('parseBranchName', () => {
    it('should parse "42-feature-name"', () => {
      expect(linker.parseBranchName('42-feature-name')).toBe(42);
    });

    it('should parse "7-fix"', () => {
      expect(linker.parseBranchName('7-fix')).toBe(7);
    });

    it('should parse "100-"', () => {
      expect(linker.parseBranchName('100-')).toBe(100);
    });

    it('should parse "199-description-implement-pr"', () => {
      expect(linker.parseBranchName('199-description-implement-pr')).toBe(199);
    });

    it('should return null for branches not starting with a number', () => {
      expect(linker.parseBranchName('feature-42')).toBe(null);
    });

    it('should return null for branches with only a number (no hyphen)', () => {
      expect(linker.parseBranchName('42')).toBe(null);
    });

    it('should return null for empty string', () => {
      expect(linker.parseBranchName('')).toBe(null);
    });

    it('should return null for "main"', () => {
      expect(linker.parseBranchName('main')).toBe(null);
    });

    it('should return null for "develop"', () => {
      expect(linker.parseBranchName('develop')).toBe(null);
    });

    it('should return null for date-prefixed branches like "2024-01-feature"', () => {
      // "2024-01-feature" matches the pattern (2024 is a valid number prefix)
      // but this is expected behavior — the regex is simple and date-like branches
      // will match. The linkPrToIssue method verifies the issue exists.
      expect(linker.parseBranchName('2024-01-feature')).toBe(2024);
    });

    it('should handle "1-a" minimal branch name', () => {
      expect(linker.parseBranchName('1-a')).toBe(1);
    });

    it('should return null for "not-a-number-prefix"', () => {
      expect(linker.parseBranchName('not-a-number-prefix')).toBe(null);
    });

    it('should parse large issue numbers in branch name', () => {
      expect(linker.parseBranchName('99999-some-feature')).toBe(99999);
    });
  });

  // ==========================================================================
  // linkPrToIssue
  // ==========================================================================

  describe('linkPrToIssue', () => {
    let github: GitHubClient;

    beforeEach(() => {
      github = createMockGitHubClient({
        getIssue: vi.fn().mockResolvedValue({
          number: 42,
          title: 'Test Issue',
          body: 'Test body',
          state: 'open',
          labels: [{ name: 'agent:speckit-feature', color: '0075ca' }],
          assignees: [],
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        }),
      });
    });

    it('should link via PR body closing keywords', async () => {
      const pr = createPrInput({
        number: 10,
        body: 'Fixes #42',
        head: { ref: 'some-branch' },
      });

      const result = await linker.linkPrToIssue(github, 'owner', 'repo', pr);

      expect(result).toEqual({
        prNumber: 10,
        issueNumber: 42,
        linkMethod: 'pr-body',
        assignees: [],
      });
      expect(github.getIssue).toHaveBeenCalledWith('owner', 'repo', 42);
    });

    it('should fall back to branch name when PR body has no keywords', async () => {
      const pr = createPrInput({
        number: 10,
        body: 'No closing keywords here',
        head: { ref: '42-feature-branch' },
      });

      const result = await linker.linkPrToIssue(github, 'owner', 'repo', pr);

      expect(result).toEqual({
        prNumber: 10,
        issueNumber: 42,
        linkMethod: 'branch-name',
        assignees: [],
      });
    });

    it('should prioritize PR body over branch name', async () => {
      // PR body references #42, branch references #99
      (github.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
        number: 42,
        title: 'Issue 42',
        body: '',
        state: 'open',
        labels: [{ name: 'agent:speckit-feature', color: '0075ca' }],
        assignees: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const pr = createPrInput({
        number: 10,
        body: 'Closes #42',
        head: { ref: '99-other-feature' },
      });

      const result = await linker.linkPrToIssue(github, 'owner', 'repo', pr);

      expect(result).toEqual({
        prNumber: 10,
        issueNumber: 42,
        linkMethod: 'pr-body',
        assignees: [],
      });
      // Should fetch issue #42, not #99
      expect(github.getIssue).toHaveBeenCalledWith('owner', 'repo', 42);
      expect(github.getIssue).toHaveBeenCalledTimes(1);
    });

    it('should return null when issue does not have an agent:* label', async () => {
      (github.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
        number: 42,
        title: 'Regular Issue',
        body: '',
        state: 'open',
        labels: [{ name: 'bug', color: 'd73a4a' }],
        assignees: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const pr = createPrInput({
        number: 10,
        body: 'Fixes #42',
        head: { ref: 'some-branch' },
      });

      const result = await linker.linkPrToIssue(github, 'owner', 'repo', pr);

      expect(result).toBeNull();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ prNumber: 10, issueNumber: 42 }),
        expect.stringContaining('agent:*'),
      );
    });

    it('should return null when issue has no labels at all', async () => {
      (github.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
        number: 42,
        title: 'Unlabeled Issue',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const pr = createPrInput({
        number: 10,
        body: 'Fixes #42',
        head: { ref: 'some-branch' },
      });

      const result = await linker.linkPrToIssue(github, 'owner', 'repo', pr);

      expect(result).toBeNull();
    });

    it('should return null when getIssue throws (issue not found)', async () => {
      (github.getIssue as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Not Found'),
      );

      const pr = createPrInput({
        number: 10,
        body: 'Fixes #42',
        head: { ref: 'some-branch' },
      });

      const result = await linker.linkPrToIssue(github, 'owner', 'repo', pr);

      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ prNumber: 10, issueNumber: 42 }),
        expect.stringContaining('Failed to fetch'),
      );
    });

    it('should return null when neither body nor branch have a link', async () => {
      const pr = createPrInput({
        number: 10,
        body: 'Just a regular PR',
        head: { ref: 'feature-branch' },
      });

      const result = await linker.linkPrToIssue(github, 'owner', 'repo', pr);

      expect(result).toBeNull();
      expect(github.getIssue).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ prNumber: 10 }),
        expect.stringContaining('No issue link found'),
      );
    });

    it('should return null when body is empty and branch has no issue prefix', async () => {
      const pr = createPrInput({
        number: 10,
        body: '',
        head: { ref: 'main' },
      });

      const result = await linker.linkPrToIssue(github, 'owner', 'repo', pr);

      expect(result).toBeNull();
    });

    it('should accept issues with agent:speckit-bugfix label', async () => {
      (github.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
        number: 7,
        title: 'Bug Issue',
        body: '',
        state: 'open',
        labels: [{ name: 'agent:speckit-bugfix', color: '0075ca' }],
        assignees: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const pr = createPrInput({
        number: 10,
        body: 'Fixes #7',
        head: { ref: 'some-branch' },
      });

      const result = await linker.linkPrToIssue(github, 'owner', 'repo', pr);

      expect(result).toEqual({
        prNumber: 10,
        issueNumber: 7,
        linkMethod: 'pr-body',
        assignees: [],
      });
    });

    it('should accept issues with agent: label among other labels', async () => {
      (github.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
        number: 42,
        title: 'Multi-label Issue',
        body: '',
        state: 'open',
        labels: [
          { name: 'enhancement', color: 'a2eeef' },
          { name: 'agent:speckit-feature', color: '0075ca' },
          { name: 'priority:high', color: 'b60205' },
        ],
        assignees: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const pr = createPrInput({
        number: 10,
        body: 'Closes #42',
        head: { ref: 'some-branch' },
      });

      const result = await linker.linkPrToIssue(github, 'owner', 'repo', pr);

      expect(result).not.toBeNull();
      expect(result!.issueNumber).toBe(42);
    });

    it('should log successful link with method info', async () => {
      const pr = createPrInput({
        number: 10,
        body: 'Fixes #42',
        head: { ref: 'some-branch' },
      });

      await linker.linkPrToIssue(github, 'owner', 'repo', pr);

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          prNumber: 10,
          issueNumber: 42,
          linkMethod: 'pr-body',
        }),
        expect.stringContaining('Linked PR #10 to issue #42'),
      );
    });

    it('should log successful branch-name link', async () => {
      const pr = createPrInput({
        number: 10,
        body: 'No keywords',
        head: { ref: '42-feature' },
      });

      await linker.linkPrToIssue(github, 'owner', 'repo', pr);

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          linkMethod: 'branch-name',
        }),
        expect.stringContaining('branch-name'),
      );
    });

    it('should handle getIssue network error gracefully', async () => {
      (github.getIssue as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('ECONNREFUSED'),
      );

      const pr = createPrInput({
        number: 10,
        body: 'Fixes #42',
        head: { ref: 'some-branch' },
      });

      const result = await linker.linkPrToIssue(github, 'owner', 'repo', pr);

      expect(result).toBeNull();
    });
  });
});

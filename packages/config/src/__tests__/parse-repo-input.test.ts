import { describe, expect, it } from 'vitest';
import { parseRepoInput, parseRepoList } from '../parse-repo-input.js';

describe('parseRepoInput', () => {
  describe('bare name', () => {
    it('returns { owner, repo } when defaultOrg is provided', () => {
      expect(parseRepoInput('generacy', 'generacy-ai')).toEqual({
        owner: 'generacy-ai',
        repo: 'generacy',
      });
    });

    it('throws when defaultOrg is not provided', () => {
      expect(() => parseRepoInput('generacy')).toThrow(
        'Bare repo name "generacy" requires a defaultOrg parameter',
      );
    });

    it('handles names with hyphens', () => {
      expect(parseRepoInput('tetrad-development', 'generacy-ai')).toEqual({
        owner: 'generacy-ai',
        repo: 'tetrad-development',
      });
    });

    it('handles names with dots and underscores', () => {
      expect(parseRepoInput('my_repo.v2', 'org')).toEqual({
        owner: 'org',
        repo: 'my_repo.v2',
      });
    });
  });

  describe('owner/repo format', () => {
    it('parses owner/repo', () => {
      expect(parseRepoInput('generacy-ai/generacy')).toEqual({
        owner: 'generacy-ai',
        repo: 'generacy',
      });
    });

    it('ignores defaultOrg when owner/repo is provided', () => {
      expect(parseRepoInput('other-org/repo', 'generacy-ai')).toEqual({
        owner: 'other-org',
        repo: 'repo',
      });
    });

    it('strips .git suffix from owner/repo', () => {
      expect(parseRepoInput('generacy-ai/generacy.git')).toEqual({
        owner: 'generacy-ai',
        repo: 'generacy',
      });
    });
  });

  describe('github.com URL path', () => {
    it('parses github.com/owner/repo', () => {
      expect(parseRepoInput('github.com/generacy-ai/generacy')).toEqual({
        owner: 'generacy-ai',
        repo: 'generacy',
      });
    });

    it('parses github.com/owner/repo.git', () => {
      expect(parseRepoInput('github.com/generacy-ai/generacy.git')).toEqual({
        owner: 'generacy-ai',
        repo: 'generacy',
      });
    });
  });

  describe('HTTPS URL', () => {
    it('parses https://github.com/owner/repo', () => {
      expect(
        parseRepoInput('https://github.com/generacy-ai/generacy'),
      ).toEqual({
        owner: 'generacy-ai',
        repo: 'generacy',
      });
    });

    it('strips .git suffix from HTTPS URL', () => {
      expect(
        parseRepoInput('https://github.com/generacy-ai/generacy.git'),
      ).toEqual({
        owner: 'generacy-ai',
        repo: 'generacy',
      });
    });

    it('parses http:// URL', () => {
      expect(
        parseRepoInput('http://github.com/generacy-ai/generacy'),
      ).toEqual({
        owner: 'generacy-ai',
        repo: 'generacy',
      });
    });

    it('parses www.github.com URL', () => {
      expect(
        parseRepoInput('https://www.github.com/generacy-ai/generacy'),
      ).toEqual({
        owner: 'generacy-ai',
        repo: 'generacy',
      });
    });
  });

  describe('SSH URL', () => {
    it('parses git@github.com:owner/repo', () => {
      expect(
        parseRepoInput('git@github.com:generacy-ai/generacy'),
      ).toEqual({
        owner: 'generacy-ai',
        repo: 'generacy',
      });
    });

    it('strips .git suffix from SSH URL', () => {
      expect(
        parseRepoInput('git@github.com:generacy-ai/generacy.git'),
      ).toEqual({
        owner: 'generacy-ai',
        repo: 'generacy',
      });
    });
  });

  describe('whitespace handling', () => {
    it('trims leading and trailing whitespace', () => {
      expect(parseRepoInput('  generacy-ai/generacy  ')).toEqual({
        owner: 'generacy-ai',
        repo: 'generacy',
      });
    });
  });

  describe('invalid inputs', () => {
    it('throws on empty string', () => {
      expect(() => parseRepoInput('')).toThrow('Repo input must not be empty');
    });

    it('throws on whitespace-only string', () => {
      expect(() => parseRepoInput('   ')).toThrow(
        'Repo input must not be empty',
      );
    });

    it('throws on unrecognized format', () => {
      expect(() => parseRepoInput('a/b/c')).toThrow(
        'Unrecognized repo input format',
      );
    });
  });
});

describe('parseRepoList', () => {
  it('parses comma-separated owner/repo entries', () => {
    expect(parseRepoList('generacy-ai/generacy,generacy-ai/contracts')).toEqual(
      [
        { owner: 'generacy-ai', repo: 'generacy' },
        { owner: 'generacy-ai', repo: 'contracts' },
      ],
    );
  });

  it('trims whitespace around entries', () => {
    expect(
      parseRepoList('generacy-ai/generacy , generacy-ai/contracts'),
    ).toEqual([
      { owner: 'generacy-ai', repo: 'generacy' },
      { owner: 'generacy-ai', repo: 'contracts' },
    ]);
  });

  it('filters out empty entries', () => {
    expect(parseRepoList('generacy-ai/generacy,,generacy-ai/contracts,')).toEqual(
      [
        { owner: 'generacy-ai', repo: 'generacy' },
        { owner: 'generacy-ai', repo: 'contracts' },
      ],
    );
  });

  it('passes defaultOrg to each entry', () => {
    expect(parseRepoList('generacy,contracts', 'generacy-ai')).toEqual([
      { owner: 'generacy-ai', repo: 'generacy' },
      { owner: 'generacy-ai', repo: 'contracts' },
    ]);
  });

  it('handles mixed formats', () => {
    expect(
      parseRepoList(
        'generacy,generacy-ai/contracts,https://github.com/generacy-ai/tetrad-development.git',
        'generacy-ai',
      ),
    ).toEqual([
      { owner: 'generacy-ai', repo: 'generacy' },
      { owner: 'generacy-ai', repo: 'contracts' },
      { owner: 'generacy-ai', repo: 'tetrad-development' },
    ]);
  });

  it('returns empty array for empty string', () => {
    expect(parseRepoList('')).toEqual([]);
  });

  it('returns empty array for commas-only string', () => {
    expect(parseRepoList(',,,,')).toEqual([]);
  });
});

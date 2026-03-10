import { describe, expect, it } from 'vitest';
import { detectRepoDrift } from '../drift.js';

const repo = (owner: string, name: string) => ({ owner, repo: name });

describe('detectRepoDrift', () => {
  describe('identical sets', () => {
    it('returns null when both lists are identical', () => {
      const repos = [repo('generacy-ai', 'generacy'), repo('generacy-ai', 'tetrad-development')];
      expect(detectRepoDrift(repos, repos)).toBeNull();
    });

    it('returns null for single identical repo', () => {
      const r = [repo('generacy-ai', 'generacy')];
      expect(detectRepoDrift(r, r)).toBeNull();
    });

    it('returns null regardless of case differences', () => {
      const config = [repo('Generacy-AI', 'Generacy')];
      const env = [repo('generacy-ai', 'generacy')];
      expect(detectRepoDrift(config, env)).toBeNull();
    });

    it('returns null when both lists are empty', () => {
      expect(detectRepoDrift([], [])).toBeNull();
    });
  });

  describe('extra repos in config only', () => {
    it('reports repos present in config but not in env', () => {
      const config = [repo('generacy-ai', 'generacy'), repo('generacy-ai', 'contracts')];
      const env = [repo('generacy-ai', 'generacy')];
      const result = detectRepoDrift(config, env);
      expect(result).toEqual({
        inConfigOnly: ['generacy-ai/contracts'],
        inEnvOnly: [],
      });
    });

    it('reports multiple config-only repos sorted alphabetically', () => {
      const config = [
        repo('generacy-ai', 'generacy'),
        repo('generacy-ai', 'contracts'),
        repo('generacy-ai', 'cluster-templates'),
      ];
      const env = [repo('generacy-ai', 'generacy')];
      const result = detectRepoDrift(config, env);
      expect(result).toEqual({
        inConfigOnly: ['generacy-ai/cluster-templates', 'generacy-ai/contracts'],
        inEnvOnly: [],
      });
    });
  });

  describe('extra repos in env only', () => {
    it('reports repos present in env but not in config', () => {
      const config = [repo('generacy-ai', 'generacy')];
      const env = [repo('generacy-ai', 'generacy'), repo('generacy-ai', 'contracts')];
      const result = detectRepoDrift(config, env);
      expect(result).toEqual({
        inConfigOnly: [],
        inEnvOnly: ['generacy-ai/contracts'],
      });
    });
  });

  describe('both differ', () => {
    it('reports repos in both directions when sets are disjoint', () => {
      const config = [repo('generacy-ai', 'generacy')];
      const env = [repo('generacy-ai', 'contracts')];
      const result = detectRepoDrift(config, env);
      expect(result).toEqual({
        inConfigOnly: ['generacy-ai/generacy'],
        inEnvOnly: ['generacy-ai/contracts'],
      });
    });

    it('reports differences with overlapping sets', () => {
      const config = [
        repo('generacy-ai', 'tetrad-development'),
        repo('generacy-ai', 'generacy'),
        repo('generacy-ai', 'contracts'),
      ];
      const env = [
        repo('generacy-ai', 'tetrad-development'),
        repo('generacy-ai', 'generacy'),
        repo('generacy-ai', 'cluster-templates'),
      ];
      const result = detectRepoDrift(config, env);
      expect(result).toEqual({
        inConfigOnly: ['generacy-ai/contracts'],
        inEnvOnly: ['generacy-ai/cluster-templates'],
      });
    });
  });

  describe('empty inputs', () => {
    it('reports all config repos when env is empty', () => {
      const config = [repo('generacy-ai', 'generacy'), repo('generacy-ai', 'contracts')];
      const result = detectRepoDrift(config, []);
      expect(result).toEqual({
        inConfigOnly: ['generacy-ai/contracts', 'generacy-ai/generacy'],
        inEnvOnly: [],
      });
    });

    it('reports all env repos when config is empty', () => {
      const env = [repo('generacy-ai', 'generacy'), repo('generacy-ai', 'contracts')];
      const result = detectRepoDrift([], env);
      expect(result).toEqual({
        inConfigOnly: [],
        inEnvOnly: ['generacy-ai/contracts', 'generacy-ai/generacy'],
      });
    });
  });

  describe('deduplication', () => {
    it('handles duplicate repos in config list', () => {
      const config = [repo('generacy-ai', 'generacy'), repo('generacy-ai', 'generacy')];
      const env = [repo('generacy-ai', 'generacy')];
      expect(detectRepoDrift(config, env)).toBeNull();
    });

    it('handles duplicate repos in env list', () => {
      const config = [repo('generacy-ai', 'generacy')];
      const env = [repo('generacy-ai', 'generacy'), repo('generacy-ai', 'generacy')];
      expect(detectRepoDrift(config, env)).toBeNull();
    });
  });
});

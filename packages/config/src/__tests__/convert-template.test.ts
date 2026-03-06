import { describe, expect, it } from 'vitest';
import { convertTemplateConfig } from '../convert-template.js';
import type { TemplateConfig } from '../template-schema.js';

describe('convertTemplateConfig', () => {
  describe('primary repo parsing', () => {
    it('extracts org and repo from owner/repo format', () => {
      const template: TemplateConfig = {
        repos: { primary: 'generacy-ai/generacy', dev: [], clone: [] },
      };
      const result = convertTemplateConfig(template);
      expect(result.org).toBe('generacy-ai');
      expect(result.repos[0]).toEqual({ name: 'generacy', monitor: true });
    });

    it('parses github.com URL path format', () => {
      const template: TemplateConfig = {
        repos: {
          primary: 'github.com/generacy-ai/generacy',
          dev: [],
          clone: [],
        },
      };
      const result = convertTemplateConfig(template);
      expect(result.org).toBe('generacy-ai');
      expect(result.repos[0]).toEqual({ name: 'generacy', monitor: true });
    });

    it('parses HTTPS URL format', () => {
      const template: TemplateConfig = {
        repos: {
          primary: 'https://github.com/generacy-ai/generacy.git',
          dev: [],
          clone: [],
        },
      };
      const result = convertTemplateConfig(template);
      expect(result.org).toBe('generacy-ai');
      expect(result.repos[0]).toEqual({ name: 'generacy', monitor: true });
    });

    it('parses SSH URL format', () => {
      const template: TemplateConfig = {
        repos: {
          primary: 'git@github.com:generacy-ai/generacy.git',
          dev: [],
          clone: [],
        },
      };
      const result = convertTemplateConfig(template);
      expect(result.org).toBe('generacy-ai');
      expect(result.repos[0]).toEqual({ name: 'generacy', monitor: true });
    });
  });

  describe('dev repos', () => {
    it('marks dev repos as monitor: true', () => {
      const template: TemplateConfig = {
        repos: {
          primary: 'generacy-ai/generacy',
          dev: ['generacy-ai/contracts', 'generacy-ai/tetrad-development'],
          clone: [],
        },
      };
      const result = convertTemplateConfig(template);
      expect(result.repos).toEqual([
        { name: 'generacy', monitor: true },
        { name: 'contracts', monitor: true },
        { name: 'tetrad-development', monitor: true },
      ]);
    });
  });

  describe('clone repos', () => {
    it('marks clone repos as monitor: false', () => {
      const template: TemplateConfig = {
        repos: {
          primary: 'generacy-ai/generacy',
          dev: [],
          clone: ['generacy-ai/shared-lib', 'generacy-ai/docs'],
        },
      };
      const result = convertTemplateConfig(template);
      expect(result.repos).toEqual([
        { name: 'generacy', monitor: true },
        { name: 'shared-lib', monitor: false },
        { name: 'docs', monitor: false },
      ]);
    });
  });

  describe('mixed dev and clone repos', () => {
    it('combines primary, dev, and clone repos in order', () => {
      const template: TemplateConfig = {
        repos: {
          primary: 'generacy-ai/generacy',
          dev: ['generacy-ai/contracts'],
          clone: ['generacy-ai/shared-lib'],
        },
      };
      const result = convertTemplateConfig(template);
      expect(result.repos).toEqual([
        { name: 'generacy', monitor: true },
        { name: 'contracts', monitor: true },
        { name: 'shared-lib', monitor: false },
      ]);
    });
  });

  describe('empty dev and clone arrays', () => {
    it('returns only the primary repo when dev and clone are empty', () => {
      const template: TemplateConfig = {
        repos: { primary: 'generacy-ai/generacy', dev: [], clone: [] },
      };
      const result = convertTemplateConfig(template);
      expect(result.repos).toHaveLength(1);
      expect(result.repos[0]).toEqual({ name: 'generacy', monitor: true });
    });
  });

  describe('bare repo name with org_name fallback', () => {
    it('uses project.org_name for bare primary repo name', () => {
      const template: TemplateConfig = {
        project: { org_name: 'generacy-ai' },
        repos: { primary: 'generacy', dev: [], clone: [] },
      };
      const result = convertTemplateConfig(template);
      expect(result.org).toBe('generacy-ai');
      expect(result.repos[0]).toEqual({ name: 'generacy', monitor: true });
    });

    it('uses primary owner as defaultOrg for bare dev/clone names', () => {
      const template: TemplateConfig = {
        repos: {
          primary: 'generacy-ai/generacy',
          dev: ['contracts'],
          clone: ['shared-lib'],
        },
      };
      const result = convertTemplateConfig(template);
      expect(result.repos).toEqual([
        { name: 'generacy', monitor: true },
        { name: 'contracts', monitor: true },
        { name: 'shared-lib', monitor: false },
      ]);
    });
  });

  describe('branch default', () => {
    it('always sets branch to develop', () => {
      const template: TemplateConfig = {
        repos: { primary: 'generacy-ai/generacy', dev: [], clone: [] },
      };
      const result = convertTemplateConfig(template);
      expect(result.branch).toBe('develop');
    });
  });

  describe('error handling', () => {
    it('throws when bare primary name has no org_name fallback', () => {
      const template: TemplateConfig = {
        repos: { primary: 'generacy', dev: [], clone: [] },
      };
      expect(() => convertTemplateConfig(template)).toThrow(
        'Bare repo name "generacy" requires a defaultOrg parameter',
      );
    });
  });
});

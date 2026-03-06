import { describe, expect, it } from 'vitest';
import { TemplateConfigSchema } from '../template-schema.js';

describe('TemplateConfigSchema', () => {
  const validFullConfig = {
    project: { org_name: 'generacy-ai' },
    repos: {
      primary: 'generacy',
      dev: ['tetrad-development'],
      clone: ['contracts'],
    },
  };

  it('accepts a valid full config with project and repos', () => {
    const result = TemplateConfigSchema.parse(validFullConfig);
    expect(result).toEqual(validFullConfig);
  });

  it('accepts a minimal config with repos.primary only', () => {
    const result = TemplateConfigSchema.parse({
      repos: { primary: 'generacy' },
    });
    expect(result.repos.primary).toBe('generacy');
  });

  it('defaults dev to empty array when omitted', () => {
    const result = TemplateConfigSchema.parse({
      repos: { primary: 'generacy' },
    });
    expect(result.repos.dev).toEqual([]);
  });

  it('defaults clone to empty array when omitted', () => {
    const result = TemplateConfigSchema.parse({
      repos: { primary: 'generacy' },
    });
    expect(result.repos.clone).toEqual([]);
  });

  it('project.org_name is optional', () => {
    const result = TemplateConfigSchema.parse({
      project: {},
      repos: { primary: 'generacy' },
    });
    expect(result.project).toEqual({});
    expect(result.project?.org_name).toBeUndefined();
  });

  it('project with extra fields passes through', () => {
    const result = TemplateConfigSchema.parse({
      project: { org_name: 'generacy-ai', description: 'A cool project', version: 2 },
      repos: { primary: 'generacy' },
    });
    expect(result.project).toEqual({
      org_name: 'generacy-ai',
      description: 'A cool project',
      version: 2,
    });
  });

  it('rejects missing repos', () => {
    expect(() =>
      TemplateConfigSchema.parse({ project: { org_name: 'generacy-ai' } }),
    ).toThrow();
  });

  it('rejects empty repos.primary', () => {
    expect(() =>
      TemplateConfigSchema.parse({ repos: { primary: '' } }),
    ).toThrow();
  });

  it('coerces null dev to empty array', () => {
    const result = TemplateConfigSchema.parse({
      repos: { primary: 'generacy', dev: null },
    });
    expect(result.repos.dev).toEqual([]);
  });

  it('coerces null clone to empty array', () => {
    const result = TemplateConfigSchema.parse({
      repos: { primary: 'generacy', clone: null },
    });
    expect(result.repos.clone).toEqual([]);
  });

  it('rejects repos.dev with empty string', () => {
    expect(() =>
      TemplateConfigSchema.parse({ repos: { primary: 'generacy', dev: [''] } }),
    ).toThrow();
  });

  it('rejects repos.clone with empty string', () => {
    expect(() =>
      TemplateConfigSchema.parse({ repos: { primary: 'generacy', clone: [''] } }),
    ).toThrow();
  });
});
